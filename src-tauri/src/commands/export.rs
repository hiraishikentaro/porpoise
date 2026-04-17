use futures::StreamExt;
use mysql_async::prelude::Queryable;
use mysql_async::{Pool, Row, Value};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use uuid::Uuid;

use crate::commands::schema::{
    build_where_order, pool_of, quote_ident, value_to_display, Filter, FilterMatch, SortKey,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Csv,
    Json,
    Sql,
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub rows: u64,
    pub bytes: u64,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_table(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: String,
    table: String,
    sort: Option<Vec<SortKey>>,
    filters: Option<Vec<Filter>>,
    filter_match: Option<FilterMatch>,
    format: ExportFormat,
    path: String,
) -> AppResult<ExportResult> {
    let pool = pool_of(&state, connection_id)?;
    let (where_sql, order_sql, params) =
        build_where_order(filters.as_deref(), filter_match, sort.as_deref());
    let sql = format!(
        "SELECT * FROM {}.{}{}{}",
        quote_ident(&database),
        quote_ident(&table),
        where_sql,
        order_sql,
    );
    stream_export(&pool, &sql, params, format, &path, Some(&table)).await
}

#[tauri::command]
pub async fn export_query(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: Option<String>,
    sql: String,
    format: ExportFormat,
    path: String,
) -> AppResult<ExportResult> {
    let pool = pool_of(&state, connection_id)?;
    let mut conn = pool.get_conn().await?;
    if let Some(db) = database.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let use_sql = format!("USE {}", quote_ident(db));
        conn.query_drop(use_sql).await?;
    }
    // conn を閉じずに使いまわすため、stream_export を自前で展開する
    let result = conn.exec_iter(sql, ()).await?;
    write_stream(result, format, &path, None).await
}

async fn stream_export(
    pool: &Pool,
    sql: &str,
    params: Vec<mysql_async::Value>,
    format: ExportFormat,
    path: &str,
    default_table_name: Option<&str>,
) -> AppResult<ExportResult> {
    let mut conn = pool.get_conn().await?;
    let result = conn.exec_iter(sql.to_string(), params).await?;
    write_stream(result, format, path, default_table_name).await
}

async fn write_stream<'a>(
    mut result: mysql_async::QueryResult<'a, 'static, mysql_async::BinaryProtocol>,
    format: ExportFormat,
    path: &str,
    table_name_for_insert: Option<&str>,
) -> AppResult<ExportResult> {
    let columns: Vec<String> = result
        .columns()
        .map(|cols| cols.iter().map(|c| c.name_str().to_string()).collect())
        .unwrap_or_default();
    if columns.is_empty() {
        return Err(AppError::InvalidData(
            "query did not return any columns".into(),
        ));
    }

    let file_path = PathBuf::from(path);
    let file = tokio::fs::File::create(&file_path)
        .await
        .map_err(|e| AppError::Io(format!("export: create {path}: {e}")))?;
    let mut writer = tokio::io::BufWriter::new(file);

    let mut count: u64 = 0;
    let mut bytes: u64 = 0;

    match format {
        ExportFormat::Csv => {
            let header = csv_line(&columns);
            bytes += write_line(&mut writer, &header).await?;
            let mut stream = result
                .stream::<Row>()
                .await
                .map_err(map_mysql_err)?
                .ok_or_else(|| AppError::InvalidData("no result set to stream".into()))?;
            while let Some(row_res) = stream.next().await {
                let row = row_res.map_err(map_mysql_err)?;
                let cells: Vec<String> = row.unwrap().into_iter().map(value_to_csv_cell).collect();
                let line = csv_line(&cells);
                bytes += write_line(&mut writer, &line).await?;
                count += 1;
            }
        }
        ExportFormat::Json => {
            // JSONL (1 行 1 オブジェクト) — ストリーム書き出しに最適
            let mut stream = result
                .stream::<Row>()
                .await
                .map_err(map_mysql_err)?
                .ok_or_else(|| AppError::InvalidData("no result set to stream".into()))?;
            while let Some(row_res) = stream.next().await {
                let row = row_res.map_err(map_mysql_err)?;
                let values = row.unwrap();
                let mut obj = serde_json::Map::with_capacity(columns.len());
                for (i, v) in values.into_iter().enumerate() {
                    let key = columns.get(i).cloned().unwrap_or_else(|| format!("_{i}"));
                    obj.insert(key, value_to_json(v));
                }
                let line = serde_json::to_string(&serde_json::Value::Object(obj))
                    .unwrap_or_else(|_| "{}".into());
                bytes += write_line(&mut writer, &line).await?;
                count += 1;
            }
        }
        ExportFormat::Sql => {
            let table = table_name_for_insert.unwrap_or("exported_rows");
            let col_list = columns
                .iter()
                .map(|c| quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            let prefix = format!("INSERT INTO {} ({}) VALUES ", quote_ident(table), col_list);
            let mut stream = result
                .stream::<Row>()
                .await
                .map_err(map_mysql_err)?
                .ok_or_else(|| AppError::InvalidData("no result set to stream".into()))?;
            while let Some(row_res) = stream.next().await {
                let row = row_res.map_err(map_mysql_err)?;
                let vals = row
                    .unwrap()
                    .into_iter()
                    .map(value_to_sql)
                    .collect::<Vec<_>>()
                    .join(", ");
                let line = format!("{prefix}({vals});");
                bytes += write_line(&mut writer, &line).await?;
                count += 1;
            }
        }
    }

    writer
        .flush()
        .await
        .map_err(|e| AppError::Io(format!("export flush: {e}")))?;

    tracing::info!(
        path = %file_path.display(),
        rows = count,
        bytes = bytes,
        "export finished"
    );
    Ok(ExportResult {
        path: path.to_string(),
        rows: count,
        bytes,
    })
}

async fn write_line<W: AsyncWrite + Unpin>(writer: &mut W, line: &str) -> AppResult<u64> {
    writer
        .write_all(line.as_bytes())
        .await
        .map_err(|e| AppError::Io(format!("write: {e}")))?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|e| AppError::Io(format!("write: {e}")))?;
    Ok((line.len() + 1) as u64)
}

fn csv_line(cells: &[String]) -> String {
    cells
        .iter()
        .map(|c| csv_escape(c))
        .collect::<Vec<_>>()
        .join(",")
}

fn csv_escape(s: &str) -> String {
    let needs = s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r');
    if !needs {
        return s.to_string();
    }
    let escaped = s.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

fn value_to_csv_cell(v: Value) -> String {
    value_to_display(v).unwrap_or_default()
}

fn value_to_json(v: Value) -> serde_json::Value {
    match v {
        Value::NULL => serde_json::Value::Null,
        Value::Int(i) => serde_json::json!(i),
        Value::UInt(u) => serde_json::json!(u),
        Value::Float(f) => serde_json::json!(f),
        Value::Double(d) => serde_json::json!(d),
        Value::Bytes(b) => match std::str::from_utf8(&b) {
            Ok(s) => serde_json::Value::String(s.to_string()),
            Err(_) => serde_json::Value::String(format!("0x{}", hex_upper(&b))),
        },
        other => {
            // Date/Time は文字列表現にフォールバック
            serde_json::Value::String(value_to_display(other).unwrap_or_default())
        }
    }
}

fn value_to_sql(v: Value) -> String {
    match v {
        Value::NULL => "NULL".to_string(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Double(d) => d.to_string(),
        Value::Bytes(b) => {
            match std::str::from_utf8(&b) {
                Ok(s) => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'")),
                // 非 UTF-8 は hex literal で表現
                Err(_) => format!("0x{}", hex_upper(&b)),
            }
        }
        other => {
            let s = value_to_display(other).unwrap_or_default();
            format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
        }
    }
}

fn hex_upper(b: &[u8]) -> String {
    let mut out = String::with_capacity(b.len() * 2);
    for byte in b {
        out.push_str(&format!("{:02X}", byte));
    }
    out
}

fn map_mysql_err(e: mysql_async::Error) -> AppError {
    AppError::Database(e)
}
