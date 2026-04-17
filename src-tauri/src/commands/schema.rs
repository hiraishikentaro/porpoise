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

#[derive(Debug, serde::Deserialize)]
pub struct SortKey {
    pub column: String,
    #[serde(default)]
    pub descending: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FilterOp {
    Eq { value: String },
    Ne { value: String },
    Lt { value: String },
    Le { value: String },
    Gt { value: String },
    Ge { value: String },
    Like { value: String },
    NotLike { value: String },
    IsNull,
    IsNotNull,
}

#[derive(Debug, serde::Deserialize)]
pub struct Filter {
    pub column: String,
    #[serde(flatten)]
    pub op: FilterOp,
}

#[derive(Debug, Default, serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum FilterMatch {
    #[default]
    All,
    Any,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn select_table_rows(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: String,
    table: String,
    offset: u64,
    limit: u32,
    sort: Option<Vec<SortKey>>,
    filters: Option<Vec<Filter>>,
    filter_match: Option<FilterMatch>,
) -> AppResult<TablePage> {
    let pool = pool_of(&state, connection_id)?;

    let mut where_parts: Vec<String> = Vec::new();
    let mut params: Vec<mysql_async::Value> = Vec::new();
    if let Some(filters) = filters.as_ref() {
        for f in filters {
            let col = quote_ident(&f.column);
            match &f.op {
                FilterOp::Eq { value } => {
                    where_parts.push(format!("{col} = ?"));
                    params.push(mysql_async::Value::Bytes(value.clone().into_bytes()));
                }
                FilterOp::Ne { value } => {
                    where_parts.push(format!("{col} <> ?"));
                    params.push(mysql_async::Value::Bytes(value.clone().into_bytes()));
                }
                FilterOp::Lt { value } => {
                    where_parts.push(format!("{col} < ?"));
                    params.push(mysql_async::Value::Bytes(value.clone().into_bytes()));
                }
                FilterOp::Le { value } => {
                    where_parts.push(format!("{col} <= ?"));
                    params.push(mysql_async::Value::Bytes(value.clone().into_bytes()));
                }
                FilterOp::Gt { value } => {
                    where_parts.push(format!("{col} > ?"));
                    params.push(mysql_async::Value::Bytes(value.clone().into_bytes()));
                }
                FilterOp::Ge { value } => {
                    where_parts.push(format!("{col} >= ?"));
                    params.push(mysql_async::Value::Bytes(value.clone().into_bytes()));
                }
                FilterOp::Like { value } => {
                    where_parts.push(format!("{col} LIKE ?"));
                    params.push(mysql_async::Value::Bytes(value.clone().into_bytes()));
                }
                FilterOp::NotLike { value } => {
                    where_parts.push(format!("{col} NOT LIKE ?"));
                    params.push(mysql_async::Value::Bytes(value.clone().into_bytes()));
                }
                FilterOp::IsNull => {
                    where_parts.push(format!("{col} IS NULL"));
                }
                FilterOp::IsNotNull => {
                    where_parts.push(format!("{col} IS NOT NULL"));
                }
            }
        }
    }

    let conjunction = match filter_match.unwrap_or_default() {
        FilterMatch::All => " AND ",
        FilterMatch::Any => " OR ",
    };
    let where_sql = if where_parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", where_parts.join(conjunction))
    };

    let order_sql = match sort.as_ref() {
        Some(keys) if !keys.is_empty() => {
            let parts: Vec<String> = keys
                .iter()
                .map(|k| {
                    format!(
                        "{} {}",
                        quote_ident(&k.column),
                        if k.descending { "DESC" } else { "ASC" }
                    )
                })
                .collect();
            format!(" ORDER BY {}", parts.join(", "))
        }
        _ => String::new(),
    };

    let sql = format!(
        "SELECT * FROM {}.{}{}{} LIMIT {} OFFSET {}",
        quote_ident(&database),
        quote_ident(&table),
        where_sql,
        order_sql,
        limit,
        offset,
    );

    let mut conn = pool.get_conn().await?;
    // text/binary protocol の戻り型を揃えるため、常に exec_iter を使う (params 空でも OK)
    let result = conn.exec_iter(sql, params).await?;

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

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryResult {
    /// SELECT / SHOW / EXPLAIN など、結果セットが返る SQL。
    Select {
        columns: Vec<String>,
        rows: Vec<Vec<Option<String>>>,
        returned: u64,
        elapsed_ms: u64,
    },
    /// INSERT / UPDATE / DELETE など、結果セットが無い SQL。
    Affected { rows: u64, elapsed_ms: u64 },
}

#[derive(Debug, Serialize)]
pub struct SchemaSnapshot {
    /// table name → ordinal-ordered column names
    pub tables: std::collections::BTreeMap<String, Vec<String>>,
}

#[tauri::command]
pub async fn schema_snapshot(
    state: State<'_, AppState>,
    connection_id: Uuid,
    database: String,
) -> AppResult<SchemaSnapshot> {
    let pool = pool_of(&state, connection_id)?;
    let mut conn = pool.get_conn().await?;
    let sql = "SELECT TABLE_NAME, COLUMN_NAME
               FROM information_schema.columns
               WHERE TABLE_SCHEMA = ?
               ORDER BY TABLE_NAME, ORDINAL_POSITION";
    let rows: Vec<(String, String)> = conn.exec(sql, (database.clone(),)).await?;
    conn.disconnect().await.ok();

    let mut tables: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();
    for (table, column) in rows {
        tables.entry(table).or_default().push(column);
    }
    Ok(SchemaSnapshot { tables })
}

#[tauri::command]
pub async fn execute_query(
    state: State<'_, AppState>,
    connection_id: Uuid,
    sql: String,
    database: Option<String>,
) -> AppResult<QueryResult> {
    let pool = pool_of(&state, connection_id)?;

    let start = std::time::Instant::now();
    let outcome = execute_query_inner(&pool, &sql, database.as_deref(), start).await;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    // 履歴は成功/失敗の両方で残す。書き込み失敗はログに落として握りつぶす
    // (履歴保存がアプリの主機能を阻害しないように)
    let (row_count, error_msg): (Option<i64>, Option<String>) = match &outcome {
        Ok(QueryResult::Select { returned, .. }) => (Some(*returned as i64), None),
        Ok(QueryResult::Affected { rows, .. }) => (Some(*rows as i64), None),
        Err(e) => (None, Some(e.to_string())),
    };
    if let Err(e) = record_history(
        &state,
        connection_id,
        database.as_deref(),
        &sql,
        elapsed_ms,
        row_count,
        error_msg.as_deref(),
    ) {
        tracing::warn!(error = %e, "failed to record query history");
    }

    outcome
}

async fn execute_query_inner(
    pool: &Pool,
    sql: &str,
    database: Option<&str>,
    start: std::time::Instant,
) -> AppResult<QueryResult> {
    let mut conn = pool.get_conn().await?;

    // 明示的な DB 指定があれば USE で切り替える。失敗したらそのままエラーを返す。
    if let Some(db) = database.map(str::trim).filter(|s| !s.is_empty()) {
        let use_sql = format!("USE {}", quote_ident(db));
        conn.query_drop(use_sql).await?;
    }

    let result = conn.query_iter(sql.to_string()).await?;
    let columns_opt = result.columns();
    let columns: Vec<String> = columns_opt
        .as_ref()
        .map(|cols| cols.iter().map(|c| c.name_str().to_string()).collect())
        .unwrap_or_default();
    let has_columns = columns_opt.is_some() && !columns.is_empty();

    let rows: Vec<Row> = result.collect_and_drop().await?;
    let affected = conn.affected_rows();
    let elapsed_ms = start.elapsed().as_millis() as u64;
    conn.disconnect().await.ok();

    if has_columns {
        let returned = rows.len() as u64;
        let cells: Vec<Vec<Option<String>>> = rows
            .into_iter()
            .map(|row| row.unwrap().into_iter().map(value_to_display).collect())
            .collect();
        tracing::info!(returned, elapsed_ms, "execute_query (select) ok");
        Ok(QueryResult::Select {
            columns,
            rows: cells,
            returned,
            elapsed_ms,
        })
    } else {
        tracing::info!(affected, elapsed_ms, "execute_query (dml) ok");
        Ok(QueryResult::Affected {
            rows: affected,
            elapsed_ms,
        })
    }
}

fn record_history(
    state: &State<'_, AppState>,
    connection_id: Uuid,
    database: Option<&str>,
    sql: &str,
    elapsed_ms: u64,
    row_count: Option<i64>,
    error: Option<&str>,
) -> AppResult<()> {
    use crate::storage::local_db::{self, NewQueryHistory};
    let db = state.local_db.lock().expect("local_db mutex poisoned");
    local_db::insert_query_history(
        &db,
        NewQueryHistory {
            connection_id,
            database,
            sql,
            duration_ms: Some(elapsed_ms),
            row_count,
            error,
        },
    )?;
    Ok(())
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

#[derive(Debug, serde::Deserialize)]
pub struct CellChange {
    pub column: String,
    /// None は NULL を示す。
    pub value: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RowChange {
    Update {
        database: String,
        table: String,
        changes: Vec<CellChange>,
        /// WHERE 句に使う PK 列の現在値
        pk: Vec<CellChange>,
    },
    Insert {
        database: String,
        table: String,
        /// 明示的に設定する列。指定されなかった列は MySQL の DEFAULT に任せる
        values: Vec<CellChange>,
    },
    Delete {
        database: String,
        table: String,
        pk: Vec<CellChange>,
    },
}

#[derive(Debug, serde::Serialize, Default)]
pub struct CommitChangesResult {
    pub updated: u64,
    pub inserted: u64,
    pub deleted: u64,
    pub statements: u64,
}

#[tauri::command]
pub async fn commit_changes(
    state: State<'_, AppState>,
    connection_id: Uuid,
    changes: Vec<RowChange>,
) -> AppResult<CommitChangesResult> {
    let pool = pool_of(&state, connection_id)?;
    let mut conn = pool.get_conn().await?;

    use mysql_async::TxOpts;
    let mut tx = conn.start_transaction(TxOpts::default()).await?;

    let mut result = CommitChangesResult::default();

    for change in &changes {
        match change {
            RowChange::Update {
                database,
                table,
                changes: cells,
                pk,
            } => {
                if cells.is_empty() {
                    continue;
                }
                if pk.is_empty() {
                    tx.rollback().await?;
                    return Err(AppError::InvalidData(
                        "row update without primary key is not allowed".into(),
                    ));
                }
                let set_clause = cells
                    .iter()
                    .map(|c| format!("{} = ?", quote_ident(&c.column)))
                    .collect::<Vec<_>>()
                    .join(", ");
                let where_clause = pk
                    .iter()
                    .map(|c| format!("{} <=> ?", quote_ident(&c.column)))
                    .collect::<Vec<_>>()
                    .join(" AND ");
                let sql = format!(
                    "UPDATE {}.{} SET {} WHERE {}",
                    quote_ident(database),
                    quote_ident(table),
                    set_clause,
                    where_clause,
                );
                let mut params: Vec<mysql_async::Value> = Vec::new();
                for c in cells {
                    params.push(value_of(c.value.as_deref()));
                }
                for c in pk {
                    params.push(value_of(c.value.as_deref()));
                }
                tx.exec_drop(sql, params).await?;
                let affected = tx.affected_rows();
                if affected > 1 {
                    tx.rollback().await?;
                    return Err(AppError::InvalidData(format!(
                        "update affected {affected} rows (expected <= 1) — PK not unique?"
                    )));
                }
                result.updated += affected;
                result.statements += 1;
            }
            RowChange::Insert {
                database,
                table,
                values,
            } => {
                if values.is_empty() {
                    // 全列 DEFAULT で INSERT
                    let sql = format!(
                        "INSERT INTO {}.{} () VALUES ()",
                        quote_ident(database),
                        quote_ident(table),
                    );
                    tx.exec_drop(sql, ()).await?;
                } else {
                    let cols = values
                        .iter()
                        .map(|c| quote_ident(&c.column))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let placeholders = values.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
                    let sql = format!(
                        "INSERT INTO {}.{} ({}) VALUES ({})",
                        quote_ident(database),
                        quote_ident(table),
                        cols,
                        placeholders,
                    );
                    let params: Vec<mysql_async::Value> = values
                        .iter()
                        .map(|c| value_of(c.value.as_deref()))
                        .collect();
                    tx.exec_drop(sql, params).await?;
                }
                result.inserted += tx.affected_rows();
                result.statements += 1;
            }
            RowChange::Delete {
                database,
                table,
                pk,
            } => {
                if pk.is_empty() {
                    tx.rollback().await?;
                    return Err(AppError::InvalidData(
                        "row delete without primary key is not allowed".into(),
                    ));
                }
                let where_clause = pk
                    .iter()
                    .map(|c| format!("{} <=> ?", quote_ident(&c.column)))
                    .collect::<Vec<_>>()
                    .join(" AND ");
                let sql = format!(
                    "DELETE FROM {}.{} WHERE {} LIMIT 2",
                    quote_ident(database),
                    quote_ident(table),
                    where_clause,
                );
                let params: Vec<mysql_async::Value> =
                    pk.iter().map(|c| value_of(c.value.as_deref())).collect();
                tx.exec_drop(sql, params).await?;
                let affected = tx.affected_rows();
                if affected > 1 {
                    tx.rollback().await?;
                    return Err(AppError::InvalidData(format!(
                        "delete affected {affected} rows (expected <= 1) — PK not unique?"
                    )));
                }
                result.deleted += affected;
                result.statements += 1;
            }
        }
    }

    tx.commit().await?;
    tracing::info!(
        %connection_id,
        updated = result.updated,
        inserted = result.inserted,
        deleted = result.deleted,
        statements = result.statements,
        "commit_changes ok"
    );
    Ok(result)
}

fn value_of(s: Option<&str>) -> mysql_async::Value {
    match s {
        Some(v) => mysql_async::Value::Bytes(v.as_bytes().to_vec()),
        None => mysql_async::Value::NULL,
    }
}
