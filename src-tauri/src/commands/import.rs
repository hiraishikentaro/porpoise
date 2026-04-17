use csv::ReaderBuilder;
use mysql_async::prelude::Queryable;
use mysql_async::TxOpts;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;
use uuid::Uuid;

use crate::commands::schema::{pool_of, quote_ident};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct CsvPreview {
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_approx: Option<u64>,
}

#[tauri::command]
pub fn preview_csv(path: String, limit: u32) -> AppResult<CsvPreview> {
    let buf = PathBuf::from(&path);
    let file = std::fs::File::open(&buf).map_err(|e| AppError::Io(format!("open {path}: {e}")))?;
    // ファイルサイズから概算
    let total_bytes = file.metadata().map(|m| m.len()).ok().filter(|b| *b > 0);

    let mut reader = ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(file);

    let header: Vec<String> = reader
        .headers()
        .map_err(|e| AppError::Io(format!("csv header: {e}")))?
        .iter()
        .map(str::to_string)
        .collect();

    let mut rows = Vec::new();
    for (i, rec) in reader.records().enumerate() {
        if i >= limit as usize {
            break;
        }
        match rec {
            Ok(rec) => rows.push(rec.iter().map(str::to_string).collect()),
            Err(e) => return Err(AppError::Io(format!("csv row {}: {e}", i + 1))),
        }
    }

    Ok(CsvPreview {
        header,
        rows,
        // bytes を返しておくと進捗表示に使える (行数ではない)
        total_approx: total_bytes,
    })
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportMode {
    Insert,
    /// INSERT ... ON DUPLICATE KEY UPDATE col=VALUES(col)
    Upsert,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ColumnMapping {
    /// INSERT 先のカラム名 (MySQL 側)
    pub target: String,
    /// 0-origin の CSV カラム index。null のときはスキップ (SQL の列リストから除外)
    pub csv_index: Option<usize>,
}

#[derive(Debug, Serialize, Default)]
pub struct ImportResult {
    pub inserted: u64,
    pub rows_read: u64,
    pub dry_run: bool,
    pub batches: u32,
    pub warnings: Vec<String>,
}

const BATCH_SIZE: usize = 500;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn import_csv(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: String,
    table: String,
    path: String,
    mapping: Vec<ColumnMapping>,
    mode: ImportMode,
    has_header: bool,
    empty_as_null: bool,
    dry_run: bool,
) -> AppResult<ImportResult> {
    let active_mapping: Vec<ColumnMapping> = mapping
        .iter()
        .filter(|m| m.csv_index.is_some())
        .cloned()
        .collect();
    if active_mapping.is_empty() {
        return Err(AppError::InvalidData("no columns mapped for import".into()));
    }

    let file =
        std::fs::File::open(&path).map_err(|e| AppError::Io(format!("open csv {path}: {e}")))?;
    let mut reader = ReaderBuilder::new()
        .has_headers(has_header)
        .flexible(true)
        .from_reader(file);

    let cols = active_mapping
        .iter()
        .map(|m| quote_ident(&m.target))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = active_mapping
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let one_row = format!("({placeholders})");

    let dup_clause = if matches!(mode, ImportMode::Upsert) {
        let parts: Vec<String> = active_mapping
            .iter()
            .map(|m| format!("{0}=VALUES({0})", quote_ident(&m.target)))
            .collect();
        format!(" ON DUPLICATE KEY UPDATE {}", parts.join(", "))
    } else {
        String::new()
    };

    let pool = pool_of(&state, connection_id)?;
    let mut conn = pool.get_conn().await?;
    // database を USE しておく
    conn.query_drop(format!("USE {}", quote_ident(&database)))
        .await?;
    let mut tx = conn.start_transaction(TxOpts::default()).await?;

    let mut result = ImportResult {
        dry_run,
        ..Default::default()
    };

    let mut batch_rows: Vec<mysql_async::Value> =
        Vec::with_capacity(BATCH_SIZE * active_mapping.len());
    let mut batch_count: usize = 0;

    // 行を読んで batch に溜める。batch が満杯になったら flush。
    for (i, rec) in reader.records().enumerate() {
        let rec = match rec {
            Ok(r) => r,
            Err(e) => {
                tx.rollback().await?;
                return Err(AppError::Io(format!("csv row {}: {e}", i + 1)));
            }
        };
        result.rows_read += 1;

        for m in &active_mapping {
            let idx = m.csv_index.expect("filtered above");
            match rec.get(idx) {
                Some(v) => {
                    if empty_as_null && v.is_empty() {
                        batch_rows.push(mysql_async::Value::NULL);
                    } else {
                        batch_rows.push(mysql_async::Value::Bytes(v.as_bytes().to_vec()));
                    }
                }
                None => batch_rows.push(mysql_async::Value::NULL),
            }
        }
        batch_count += 1;

        if batch_count >= BATCH_SIZE {
            flush_batch(
                &mut tx,
                &database,
                &table,
                &cols,
                &one_row,
                batch_count,
                &mut batch_rows,
                &dup_clause,
                &mut result,
            )
            .await?;
            batch_count = 0;
        }
    }
    if batch_count > 0 {
        flush_batch(
            &mut tx,
            &database,
            &table,
            &cols,
            &one_row,
            batch_count,
            &mut batch_rows,
            &dup_clause,
            &mut result,
        )
        .await?;
    }

    if dry_run {
        tx.rollback().await?;
    } else {
        tx.commit().await?;
    }
    tracing::info!(
        table = %table,
        rows_read = result.rows_read,
        inserted = result.inserted,
        batches = result.batches,
        dry_run = result.dry_run,
        "csv import finished"
    );
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
async fn flush_batch(
    tx: &mut mysql_async::Transaction<'_>,
    database: &str,
    table: &str,
    cols: &str,
    one_row: &str,
    batch_count: usize,
    batch_rows: &mut Vec<mysql_async::Value>,
    dup_clause: &str,
    result: &mut ImportResult,
) -> AppResult<()> {
    let rows_sql: String = std::iter::repeat_n(one_row, batch_count)
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {}.{} ({cols}) VALUES {rows_sql}{dup_clause}",
        quote_ident(database),
        quote_ident(table),
    );
    let params = std::mem::take(batch_rows);
    tx.exec_drop(sql, params).await?;
    result.inserted += tx.affected_rows();
    result.batches += 1;
    Ok(())
}
