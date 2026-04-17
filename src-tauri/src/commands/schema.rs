use mysql_async::prelude::Queryable;
use mysql_async::{Pool, Row, Value};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// MySQL の管理系スキーマ。一覧から除外する。
const SYSTEM_SCHEMAS: &[&str] = &["information_schema", "performance_schema", "mysql", "sys"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TableKind {
    Table,
    View,
}

#[derive(Debug, Serialize)]
pub struct TableInfo {
    pub name: String,
    pub kind: TableKind,
}

#[derive(Debug, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub key: Option<String>,
    pub default: Option<String>,
    pub extra: Option<String>,
    pub comment: Option<String>,
}

fn pool_of(state: &State<'_, AppState>, id: Uuid) -> AppResult<Pool> {
    let pools = state.pools.lock().expect("pools mutex poisoned");
    pools
        .get(&id)
        .map(|ac| ac.pool.clone())
        .ok_or_else(|| AppError::NotFound(format!("connection {id} not opened")))
}

async fn query_rows(pool: &Pool, sql: String) -> AppResult<Vec<Row>> {
    let mut conn = pool.get_conn().await?;
    let rows: Vec<Row> = conn.query(sql).await?;
    conn.disconnect().await.ok();
    Ok(rows)
}

/// mysql_async::Row から安全に文字列を取り出す。
/// 列が存在しない / NULL / 想定外の型のときは None。
fn row_str(row: &Row, name: &str) -> Option<String> {
    row.get_opt::<String, _>(name)?.ok()
}

fn row_str_pos(row: &Row, pos: usize) -> Option<String> {
    row.get_opt::<String, _>(pos)?.ok()
}

#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> AppResult<Vec<String>> {
    let pool = pool_of(&state, connection_id)?;
    let rows = query_rows(&pool, "SHOW DATABASES".to_string()).await?;
    Ok(rows
        .iter()
        .filter_map(|r| row_str_pos(r, 0))
        .filter(|d| !SYSTEM_SCHEMAS.contains(&d.as_str()))
        .collect())
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: String,
) -> AppResult<Vec<TableInfo>> {
    let pool = pool_of(&state, connection_id)?;
    let sql = format!("SHOW FULL TABLES FROM {}", quote_ident(&database));
    let rows = query_rows(&pool, sql).await?;

    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = row_str_pos(r, 0)?;
            let ty = row_str_pos(r, 1).unwrap_or_default();
            let kind = if ty.eq_ignore_ascii_case("VIEW") {
                TableKind::View
            } else {
                TableKind::Table
            };
            Some(TableInfo { name, kind })
        })
        .collect())
}

#[tauri::command]
pub async fn describe_table(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: String,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    let pool = pool_of(&state, connection_id)?;
    let sql = format!(
        "SHOW FULL COLUMNS FROM {}.{}",
        quote_ident(&database),
        quote_ident(&table),
    );
    let rows = query_rows(&pool, sql).await?;

    rows.iter().map(column_from_row).collect()
}

fn column_from_row(row: &Row) -> AppResult<ColumnInfo> {
    // SHOW FULL COLUMNS の列順:
    //   Field, Type, Collation, Null, Key, Default, Extra, Privileges, Comment
    // 型は列ごとに Null になりうるので get_opt で拾う。
    let name = row_str(row, "Field")
        .ok_or_else(|| AppError::InvalidData("SHOW FULL COLUMNS: missing Field".into()))?;
    let data_type = row_str(row, "Type")
        .ok_or_else(|| AppError::InvalidData("SHOW FULL COLUMNS: missing Type".into()))?;
    let nullable = row_str(row, "Null").unwrap_or_else(|| "NO".to_string());
    let key = row_str(row, "Key").filter(|s| !s.is_empty());
    let default = row_str(row, "Default");
    let extra = row_str(row, "Extra").filter(|s| !s.is_empty());
    let comment = row_str(row, "Comment").filter(|s| !s.is_empty());

    Ok(ColumnInfo {
        name,
        data_type,
        nullable: nullable.eq_ignore_ascii_case("YES"),
        key,
        default,
        extra,
        comment,
    })
}

/// SHOW などで識別子を安全に quote する (backtick)。
/// 内部に backtick が含まれる場合は二重にしてエスケープ。
fn quote_ident(name: &str) -> String {
    let escaped = name.replace('`', "``");
    format!("`{}`", escaped)
}

#[derive(Debug, Serialize)]
pub struct TablePage {
    pub columns: Vec<String>,
    /// 各セルは NULL なら None、それ以外は文字列表現。
    pub rows: Vec<Vec<Option<String>>>,
    pub offset: u64,
    pub returned: u64,
}

#[tauri::command]
pub async fn select_table_rows(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: String,
    table: String,
    offset: u64,
    limit: u32,
) -> AppResult<TablePage> {
    let pool = pool_of(&state, connection_id)?;
    let sql = format!(
        "SELECT * FROM {}.{} LIMIT {} OFFSET {}",
        quote_ident(&database),
        quote_ident(&table),
        limit,
        offset,
    );

    let mut conn = pool.get_conn().await?;
    let result = conn.query_iter(sql).await?;

    let columns: Vec<String> = result
        .columns()
        .map(|cols| cols.iter().map(|c| c.name_str().to_string()).collect())
        .unwrap_or_default();

    let rows: Vec<Row> = result.collect_and_drop().await?;
    conn.disconnect().await.ok();

    let returned = rows.len() as u64;
    let cells: Vec<Vec<Option<String>>> = rows
        .into_iter()
        .map(|row| row.unwrap().into_iter().map(value_to_display).collect())
        .collect();

    Ok(TablePage {
        columns,
        rows: cells,
        offset,
        returned,
    })
}

/// mysql_async::Value → 表示用の文字列 (NULL は None)。
fn value_to_display(v: Value) -> Option<String> {
    match v {
        Value::NULL => None,
        Value::Bytes(b) => Some(match std::str::from_utf8(&b) {
            Ok(s) => s.to_string(),
            Err(_) => format!("0x{}", hex_encode(&b)),
        }),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        Value::Date(y, mo, d, h, mi, s, us) => {
            if h == 0 && mi == 0 && s == 0 && us == 0 {
                Some(format!("{:04}-{:02}-{:02}", y, mo, d))
            } else if us == 0 {
                Some(format!(
                    "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
                    y, mo, d, h, mi, s
                ))
            } else {
                Some(format!(
                    "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}",
                    y, mo, d, h, mi, s, us
                ))
            }
        }
        Value::Time(neg, d, h, mi, s, us) => {
            let sign = if neg { "-" } else { "" };
            let base = if d > 0 {
                format!("{}{}d {:02}:{:02}:{:02}", sign, d, h, mi, s)
            } else {
                format!("{}{:02}:{:02}:{:02}", sign, h, mi, s)
            };
            Some(if us == 0 {
                base
            } else {
                format!("{}.{:06}", base, us)
            })
        }
    }
}

fn hex_encode(b: &[u8]) -> String {
    let mut out = String::with_capacity(b.len() * 2);
    for byte in b {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}
