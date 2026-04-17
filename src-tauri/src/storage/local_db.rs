use std::path::Path;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SslMode {
    #[default]
    Disabled,
    Preferred,
    Required,
    VerifyCa,
    VerifyIdentity,
}

impl SslMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Preferred => "preferred",
            Self::Required => "required",
            Self::VerifyCa => "verify_ca",
            Self::VerifyIdentity => "verify_identity",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "preferred" => Self::Preferred,
            "required" => Self::Required,
            "verify_ca" => Self::VerifyCa,
            "verify_identity" => Self::VerifyIdentity,
            _ => Self::Disabled,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SshAuthKind {
    Password,
    Key,
}

impl SshAuthKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Key => "key",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s {
            "password" => Some(Self::Password),
            "key" => Some(Self::Key),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_kind: SshAuthKind,
    pub key_path: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SavedSslConfig {
    pub mode: SslMode,
    pub ca_cert_path: Option<String>,
    pub client_cert_path: Option<String>,
    pub client_key_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedConnection {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    pub ssl: SavedSslConfig,
    pub ssh: Option<SavedSshConfig>,
    pub enable_cleartext_plugin: bool,
    /// クエリ履歴の自動保存を有効にするかどうか (プライバシー設定)
    pub history_enabled: bool,
    /// 接続のカラーラベル (prod=red など誤爆防止用)。null なら name hash 由来。
    pub color_label: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    run_migrations(&conn)?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> AppResult<()> {
    // 0001: base table (exists from Phase 1 slice 2). IF NOT EXISTS で既存 DB に無害。
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS saved_connections (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            username TEXT NOT NULL,
            database TEXT,
            use_ssl INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )?;

    // 0002: SSL モード細分化 + SSH トンネル列。既存列があれば ADD COLUMN を skip。
    let existing_cols = existing_columns(conn, "saved_connections")?;
    let additions: &[(&str, &str)] = &[
        ("ssl_mode", "TEXT NOT NULL DEFAULT 'disabled'"),
        ("ssl_ca_cert_path", "TEXT"),
        ("ssl_client_cert_path", "TEXT"),
        ("ssl_client_key_path", "TEXT"),
        ("ssh_enabled", "INTEGER NOT NULL DEFAULT 0"),
        ("ssh_host", "TEXT"),
        ("ssh_port", "INTEGER"),
        ("ssh_user", "TEXT"),
        ("ssh_auth_kind", "TEXT"),
        ("ssh_key_path", "TEXT"),
        ("enable_cleartext_plugin", "INTEGER NOT NULL DEFAULT 0"),
        ("history_enabled", "INTEGER NOT NULL DEFAULT 1"),
        ("color_label", "TEXT"),
    ];
    for (name, decl) in additions {
        if !existing_cols.iter().any(|c| c == name) {
            conn.execute_batch(&format!(
                "ALTER TABLE saved_connections ADD COLUMN {name} {decl};"
            ))?;
        }
    }

    // 既存の use_ssl=1 行を ssl_mode='preferred' に昇格 (初回のみ)
    conn.execute(
        "UPDATE saved_connections SET ssl_mode = 'preferred'
         WHERE use_ssl = 1 AND ssl_mode = 'disabled'",
        [],
    )?;

    // 0003: query_history — 実行したクエリのログ (成功/失敗両方)
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS query_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id TEXT NOT NULL,
            database TEXT,
            sql TEXT NOT NULL,
            executed_at TEXT NOT NULL,
            duration_ms INTEGER,
            row_count INTEGER,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_query_history_conn_time
          ON query_history (connection_id, executed_at DESC);",
    )?;

    // 0004: saved_queries — 名前付きスニペット (per-connection)
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS saved_queries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id TEXT NOT NULL,
            name TEXT NOT NULL,
            sql TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_saved_queries_conn_name
          ON saved_queries (connection_id, name);",
    )?;

    Ok(())
}

fn existing_columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql)?;
    let iter = stmt.query_map([], |row| row.get::<_, String>("name"))?;
    iter.collect()
}

fn row_to_saved(row: &Row<'_>) -> rusqlite::Result<SavedConnection> {
    let id_str: String = row.get("id")?;
    let id = Uuid::parse_str(&id_str).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let port: i64 = row.get("port")?;
    let ssl_mode: String = row.get("ssl_mode")?;
    let ssh_enabled: i64 = row.get("ssh_enabled")?;
    let enable_cleartext: i64 = row.get("enable_cleartext_plugin")?;
    let history_enabled: i64 = row.get("history_enabled")?;
    let color_label: Option<String> = row.get("color_label")?;
    let ssh = if ssh_enabled != 0 {
        let ssh_host: Option<String> = row.get("ssh_host")?;
        let ssh_port: Option<i64> = row.get("ssh_port")?;
        let ssh_user: Option<String> = row.get("ssh_user")?;
        let auth_kind_str: Option<String> = row.get("ssh_auth_kind")?;
        let key_path: Option<String> = row.get("ssh_key_path")?;
        match (ssh_host, ssh_port, ssh_user, auth_kind_str.as_deref()) {
            (Some(h), Some(p), Some(u), Some(kind_str)) => {
                let auth_kind = SshAuthKind::from_str(kind_str).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        format!("unknown ssh auth kind: {kind_str}").into(),
                    )
                })?;
                Some(SavedSshConfig {
                    host: h,
                    port: u16::try_from(p).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Integer,
                            Box::new(e),
                        )
                    })?,
                    user: u,
                    auth_kind,
                    key_path,
                })
            }
            _ => None,
        }
    } else {
        None
    };

    Ok(SavedConnection {
        id,
        name: row.get("name")?,
        host: row.get("host")?,
        port: u16::try_from(port).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Integer,
                Box::new(e),
            )
        })?,
        user: row.get("username")?,
        database: row.get("database")?,
        ssl: SavedSslConfig {
            mode: SslMode::from_str(&ssl_mode),
            ca_cert_path: row.get("ssl_ca_cert_path")?,
            client_cert_path: row.get("ssl_client_cert_path")?,
            client_key_path: row.get("ssl_client_key_path")?,
        },
        ssh,
        enable_cleartext_plugin: enable_cleartext != 0,
        history_enabled: history_enabled != 0,
        color_label,
        created_at: parse_ts(&row.get::<_, String>("created_at")?)?,
        updated_at: parse_ts(&row.get::<_, String>("updated_at")?)?,
    })
}

fn parse_ts(s: &str) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })
}

pub struct NewConnection<'a> {
    pub name: &'a str,
    pub host: &'a str,
    pub port: u16,
    pub user: &'a str,
    pub database: Option<&'a str>,
    pub ssl: SavedSslConfig,
    pub ssh: Option<SavedSshConfig>,
    pub enable_cleartext_plugin: bool,
    pub history_enabled: bool,
    pub color_label: Option<&'a str>,
}

pub fn insert(conn: &Connection, input: NewConnection<'_>) -> AppResult<SavedConnection> {
    if input.name.trim().is_empty() {
        return Err(AppError::InvalidData("connection name is empty".into()));
    }

    let id = Uuid::new_v4();
    let now = Utc::now();
    let now_str = now.to_rfc3339();

    conn.execute(
        "INSERT INTO saved_connections
            (id, name, host, port, username, database, use_ssl,
             ssl_mode, ssl_ca_cert_path, ssl_client_cert_path, ssl_client_key_path,
             ssh_enabled, ssh_host, ssh_port, ssh_user, ssh_auth_kind, ssh_key_path,
             enable_cleartext_plugin, history_enabled, color_label,
             created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?)",
        params![
            id.to_string(),
            input.name,
            input.host,
            i64::from(input.port),
            input.user,
            input.database,
            i64::from(matches!(
                input.ssl.mode,
                SslMode::Preferred
                    | SslMode::Required
                    | SslMode::VerifyCa
                    | SslMode::VerifyIdentity
            )),
            input.ssl.mode.as_str(),
            input.ssl.ca_cert_path,
            input.ssl.client_cert_path,
            input.ssl.client_key_path,
            i64::from(input.ssh.is_some()),
            input.ssh.as_ref().map(|s| &s.host),
            input.ssh.as_ref().map(|s| i64::from(s.port)),
            input.ssh.as_ref().map(|s| &s.user),
            input.ssh.as_ref().map(|s| s.auth_kind.as_str()),
            input.ssh.as_ref().and_then(|s| s.key_path.clone()),
            i64::from(input.enable_cleartext_plugin),
            i64::from(input.history_enabled),
            input.color_label,
            now_str,
            now_str,
        ],
    )?;

    Ok(SavedConnection {
        id,
        name: input.name.to_owned(),
        host: input.host.to_owned(),
        port: input.port,
        user: input.user.to_owned(),
        database: input.database.map(str::to_owned),
        ssl: input.ssl,
        ssh: input.ssh,
        enable_cleartext_plugin: input.enable_cleartext_plugin,
        history_enabled: input.history_enabled,
        color_label: input.color_label.map(str::to_owned),
        created_at: now,
        updated_at: now,
    })
}

pub fn get(conn: &Connection, id: Uuid) -> AppResult<Option<SavedConnection>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, host, port, username, database,
                ssl_mode, ssl_ca_cert_path, ssl_client_cert_path, ssl_client_key_path,
                ssh_enabled, ssh_host, ssh_port, ssh_user, ssh_auth_kind, ssh_key_path,
                enable_cleartext_plugin, history_enabled, color_label,
                created_at, updated_at
         FROM saved_connections
         WHERE id = ?",
    )?;
    let mut rows = stmt.query(params![id.to_string()])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_saved(row)?))
    } else {
        Ok(None)
    }
}

pub fn list(conn: &Connection) -> AppResult<Vec<SavedConnection>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, host, port, username, database,
                ssl_mode, ssl_ca_cert_path, ssl_client_cert_path, ssl_client_key_path,
                ssh_enabled, ssh_host, ssh_port, ssh_user, ssh_auth_kind, ssh_key_path,
                enable_cleartext_plugin, history_enabled, color_label,
                created_at, updated_at
         FROM saved_connections
         ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map([], row_to_saved)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn delete(conn: &Connection, id: Uuid) -> AppResult<bool> {
    let affected = conn.execute(
        "DELETE FROM saved_connections WHERE id = ?",
        params![id.to_string()],
    )?;
    Ok(affected > 0)
}

pub fn update(conn: &Connection, id: Uuid, input: NewConnection<'_>) -> AppResult<SavedConnection> {
    if input.name.trim().is_empty() {
        return Err(AppError::InvalidData("connection name is empty".into()));
    }

    let now = Utc::now();
    let now_str = now.to_rfc3339();

    let affected = conn.execute(
        "UPDATE saved_connections SET
            name = ?, host = ?, port = ?, username = ?, database = ?, use_ssl = ?,
            ssl_mode = ?, ssl_ca_cert_path = ?, ssl_client_cert_path = ?, ssl_client_key_path = ?,
            ssh_enabled = ?, ssh_host = ?, ssh_port = ?, ssh_user = ?,
            ssh_auth_kind = ?, ssh_key_path = ?,
            enable_cleartext_plugin = ?,
            history_enabled = ?,
            color_label = ?,
            updated_at = ?
         WHERE id = ?",
        params![
            input.name,
            input.host,
            i64::from(input.port),
            input.user,
            input.database,
            i64::from(matches!(
                input.ssl.mode,
                SslMode::Preferred
                    | SslMode::Required
                    | SslMode::VerifyCa
                    | SslMode::VerifyIdentity
            )),
            input.ssl.mode.as_str(),
            input.ssl.ca_cert_path,
            input.ssl.client_cert_path,
            input.ssl.client_key_path,
            i64::from(input.ssh.is_some()),
            input.ssh.as_ref().map(|s| &s.host),
            input.ssh.as_ref().map(|s| i64::from(s.port)),
            input.ssh.as_ref().map(|s| &s.user),
            input.ssh.as_ref().map(|s| s.auth_kind.as_str()),
            input.ssh.as_ref().and_then(|s| s.key_path.clone()),
            i64::from(input.enable_cleartext_plugin),
            i64::from(input.history_enabled),
            input.color_label,
            now_str,
            id.to_string(),
        ],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("connection {id} not found")));
    }

    get(conn, id)?
        .ok_or_else(|| AppError::NotFound(format!("connection {id} not found after update")))
}

// ---------- query_history ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistoryRow {
    pub id: i64,
    pub connection_id: Uuid,
    pub database: Option<String>,
    pub sql: String,
    pub executed_at: DateTime<Utc>,
    pub duration_ms: Option<u64>,
    pub row_count: Option<i64>,
    pub error: Option<String>,
}

pub struct NewQueryHistory<'a> {
    pub connection_id: Uuid,
    pub database: Option<&'a str>,
    pub sql: &'a str,
    pub duration_ms: Option<u64>,
    pub row_count: Option<i64>,
    pub error: Option<&'a str>,
}

pub fn insert_query_history(conn: &Connection, input: NewQueryHistory<'_>) -> AppResult<i64> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO query_history
            (connection_id, database, sql, executed_at, duration_ms, row_count, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            input.connection_id.to_string(),
            input.database,
            input.sql,
            now,
            input.duration_ms.map(|v| v as i64),
            input.row_count,
            input.error,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_query_history(
    conn: &Connection,
    connection_id: Option<Uuid>,
    search: Option<&str>,
    limit: u32,
) -> AppResult<Vec<QueryHistoryRow>> {
    // プレースホルダ順を揃えるため WHERE を動的に組む
    let mut clauses: Vec<&'static str> = Vec::new();
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    let conn_id_str;
    if let Some(id) = connection_id {
        conn_id_str = id.to_string();
        clauses.push("connection_id = ?");
        args.push(Box::new(conn_id_str.clone()));
    }

    let like_pattern;
    if let Some(q) = search.map(str::trim).filter(|s| !s.is_empty()) {
        like_pattern = format!("%{q}%");
        clauses.push("sql LIKE ?");
        args.push(Box::new(like_pattern.clone()));
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };

    let sql = format!(
        "SELECT id, connection_id, database, sql, executed_at, duration_ms, row_count, error
         FROM query_history{where_sql}
         ORDER BY executed_at DESC, id DESC
         LIMIT ?"
    );
    args.push(Box::new(i64::from(limit)));

    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(refs.as_slice(), row_to_history)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn clear_query_history(conn: &Connection, connection_id: Option<Uuid>) -> AppResult<u64> {
    let affected = match connection_id {
        Some(id) => conn.execute(
            "DELETE FROM query_history WHERE connection_id = ?",
            params![id.to_string()],
        )?,
        None => conn.execute("DELETE FROM query_history", [])?,
    };
    Ok(affected as u64)
}

// ---------- saved_queries (snippets) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedQuery {
    pub id: i64,
    pub connection_id: Uuid,
    pub name: String,
    pub sql: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub fn insert_saved_query(
    conn: &Connection,
    connection_id: Uuid,
    name: &str,
    sql: &str,
) -> AppResult<SavedQuery> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidData("snippet name is empty".into()));
    }
    let now = Utc::now();
    let now_str = now.to_rfc3339();
    conn.execute(
        "INSERT INTO saved_queries (connection_id, name, sql, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)",
        params![connection_id.to_string(), trimmed, sql, now_str, now_str],
    )?;
    Ok(SavedQuery {
        id: conn.last_insert_rowid(),
        connection_id,
        name: trimmed.to_owned(),
        sql: sql.to_owned(),
        created_at: now,
        updated_at: now,
    })
}

pub fn update_saved_query(
    conn: &Connection,
    id: i64,
    name: &str,
    sql: &str,
) -> AppResult<SavedQuery> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidData("snippet name is empty".into()));
    }
    let now = Utc::now().to_rfc3339();
    let affected = conn.execute(
        "UPDATE saved_queries SET name = ?, sql = ?, updated_at = ? WHERE id = ?",
        params![trimmed, sql, now, id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("snippet {id} not found")));
    }
    get_saved_query(conn, id)?
        .ok_or_else(|| AppError::NotFound(format!("snippet {id} not found after update")))
}

pub fn get_saved_query(conn: &Connection, id: i64) -> AppResult<Option<SavedQuery>> {
    let mut stmt = conn.prepare(
        "SELECT id, connection_id, name, sql, created_at, updated_at
         FROM saved_queries WHERE id = ?",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_snippet(row)?))
    } else {
        Ok(None)
    }
}

pub fn list_saved_queries(conn: &Connection, connection_id: Uuid) -> AppResult<Vec<SavedQuery>> {
    let mut stmt = conn.prepare(
        "SELECT id, connection_id, name, sql, created_at, updated_at
         FROM saved_queries WHERE connection_id = ?
         ORDER BY updated_at DESC, id DESC",
    )?;
    let rows = stmt.query_map(params![connection_id.to_string()], row_to_snippet)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn delete_saved_query(conn: &Connection, id: i64) -> AppResult<bool> {
    let affected = conn.execute("DELETE FROM saved_queries WHERE id = ?", params![id])?;
    Ok(affected > 0)
}

fn row_to_snippet(row: &Row<'_>) -> rusqlite::Result<SavedQuery> {
    let conn_id_str: String = row.get("connection_id")?;
    let connection_id = Uuid::parse_str(&conn_id_str).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(SavedQuery {
        id: row.get("id")?,
        connection_id,
        name: row.get("name")?,
        sql: row.get("sql")?,
        created_at: parse_ts(&row.get::<_, String>("created_at")?)?,
        updated_at: parse_ts(&row.get::<_, String>("updated_at")?)?,
    })
}

fn row_to_history(row: &Row<'_>) -> rusqlite::Result<QueryHistoryRow> {
    let conn_id_str: String = row.get("connection_id")?;
    let connection_id = Uuid::parse_str(&conn_id_str).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let duration_ms: Option<i64> = row.get("duration_ms")?;
    Ok(QueryHistoryRow {
        id: row.get("id")?,
        connection_id,
        database: row.get("database")?,
        sql: row.get("sql")?,
        executed_at: parse_ts(&row.get::<_, String>("executed_at")?)?,
        duration_ms: duration_ms.map(|v| v.max(0) as u64),
        row_count: row.get("row_count")?,
        error: row.get("error")?,
    })
}
