use std::path::Path;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedConnection {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    pub use_ssl: bool,
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
    Ok(())
}

fn row_to_saved(row: &Row<'_>) -> rusqlite::Result<SavedConnection> {
    let id_str: String = row.get("id")?;
    let id = Uuid::parse_str(&id_str).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let created_at: String = row.get("created_at")?;
    let updated_at: String = row.get("updated_at")?;
    let port: i64 = row.get("port")?;
    let use_ssl: i64 = row.get("use_ssl")?;

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
        use_ssl: use_ssl != 0,
        created_at: parse_ts(&created_at)?,
        updated_at: parse_ts(&updated_at)?,
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
    pub use_ssl: bool,
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
            (id, name, host, port, username, database, use_ssl, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id.to_string(),
            input.name,
            input.host,
            i64::from(input.port),
            input.user,
            input.database,
            i64::from(input.use_ssl),
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
        use_ssl: input.use_ssl,
        created_at: now,
        updated_at: now,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<SavedConnection>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, host, port, username, database, use_ssl, created_at, updated_at
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
