use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::db::mysql_client::{self, ConnectionConfig};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::storage::{keychain, local_db};

/// フロントから呼ばれる接続テスト。成功時は MySQL の VERSION() を返す。
#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> AppResult<String> {
    tracing::info!(host = %config.host, port = config.port, "testing connection");
    let version = mysql_client::test_connection(&config).await?;
    tracing::info!(%version, "connection ok");
    Ok(version)
}

#[derive(Debug, Deserialize)]
pub struct SaveConnectionInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: Option<String>,
    #[serde(default)]
    pub use_ssl: bool,
}

#[tauri::command]
pub async fn save_connection(
    state: State<'_, AppState>,
    input: SaveConnectionInput,
) -> AppResult<local_db::SavedConnection> {
    let saved = {
        let conn = state.local_db.lock().expect("local_db mutex poisoned");
        local_db::insert(
            &conn,
            local_db::NewConnection {
                name: input.name.trim(),
                host: input.host.trim(),
                port: input.port,
                user: input.user.trim(),
                database: input
                    .database
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
                use_ssl: input.use_ssl,
            },
        )?
    };

    if let Err(err) = keychain::save_password(saved.id, &input.password) {
        // ロールバック: メタデータだけ残すと整合性が崩れるので即削除
        let conn = state.local_db.lock().expect("local_db mutex poisoned");
        let _ = local_db::delete(&conn, saved.id);
        return Err(err);
    }

    tracing::info!(id = %saved.id, name = %saved.name, "saved connection");
    Ok(saved)
}

#[tauri::command]
pub async fn list_connections(
    state: State<'_, AppState>,
) -> AppResult<Vec<local_db::SavedConnection>> {
    let conn = state.local_db.lock().expect("local_db mutex poisoned");
    local_db::list(&conn)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: Uuid) -> AppResult<()> {
    // 開いているプールがあれば先に閉じる
    let pool = {
        let mut pools = state.pools.lock().expect("pools mutex poisoned");
        pools.remove(&id)
    };
    if let Some(pool) = pool {
        pool.close().await;
    }

    {
        let conn = state.local_db.lock().expect("local_db mutex poisoned");
        local_db::delete(&conn, id)?;
    }
    keychain::delete_password(id)?;
    tracing::info!(%id, "deleted connection");
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct OpenConnectionResult {
    pub id: Uuid,
    pub version: String,
}

#[tauri::command]
pub async fn open_connection(
    state: State<'_, AppState>,
    id: Uuid,
) -> AppResult<OpenConnectionResult> {
    // 既に開いている場合はそのまま version だけ返す
    let existing = {
        let pools = state.pools.lock().expect("pools mutex poisoned");
        pools.get(&id).cloned()
    };
    if let Some(pool) = existing {
        let version = mysql_client::fetch_version(&pool).await?;
        return Ok(OpenConnectionResult { id, version });
    }

    let saved = {
        let conn = state.local_db.lock().expect("local_db mutex poisoned");
        local_db::get(&conn, id)?
    }
    .ok_or_else(|| AppError::NotFound(format!("connection {id} not found")))?;

    let password = keychain::get_password(id)?;
    let config = ConnectionConfig {
        host: saved.host,
        port: saved.port,
        user: saved.user,
        password,
        database: saved.database,
        use_ssl: saved.use_ssl,
    };

    tracing::info!(%id, host = %config.host, "opening connection");
    let pool = mysql_client::connect_pool(&config).await?;
    let version = mysql_client::fetch_version(&pool).await?;

    {
        let mut pools = state.pools.lock().expect("pools mutex poisoned");
        pools.insert(id, pool);
    }
    tracing::info!(%id, %version, "connection opened");

    Ok(OpenConnectionResult { id, version })
}

#[tauri::command]
pub async fn close_connection(state: State<'_, AppState>, id: Uuid) -> AppResult<()> {
    let pool = {
        let mut pools = state.pools.lock().expect("pools mutex poisoned");
        pools.remove(&id)
    };
    if let Some(pool) = pool {
        pool.close().await;
        tracing::info!(%id, "connection closed");
    }
    Ok(())
}

#[tauri::command]
pub async fn active_connections(state: State<'_, AppState>) -> AppResult<Vec<Uuid>> {
    let pools = state.pools.lock().expect("pools mutex poisoned");
    Ok(pools.keys().copied().collect())
}
