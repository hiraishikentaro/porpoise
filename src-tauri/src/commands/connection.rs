use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::db::mysql_client::{
    self, ConnectionConfig, SshAuthInput, SshConfigInput, SslConfigInput,
};
use crate::error::{AppError, AppResult};
use crate::state::{ActiveConnection, AppState};
use crate::storage::keychain::{self, Slot};
use crate::storage::local_db::{self, SshAuthKind};

/// フロントから呼ばれる接続テスト。成功時は MySQL の VERSION() を返す。
#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> AppResult<String> {
    tracing::info!(host = %config.host, port = config.port, "testing connection");
    match mysql_client::test_connection(&config).await {
        Ok(version) => {
            tracing::info!(%version, "connection ok");
            Ok(version)
        }
        Err(e) => {
            tracing::warn!(error = %e, host = %config.host, "test_connection failed");
            Err(e)
        }
    }
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
    pub ssl: SslConfigInput,
    #[serde(default)]
    pub ssh: Option<SshConfigInput>,
    #[serde(default)]
    pub enable_cleartext_plugin: bool,
    /// クエリ履歴を記録するか (default true)
    #[serde(default = "default_true")]
    pub history_enabled: bool,
}

fn default_true() -> bool {
    true
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
                ssl: input.ssl.to_saved(),
                ssh: input.ssh.as_ref().map(SshConfigInput::saved_meta),
                enable_cleartext_plugin: input.enable_cleartext_plugin,
                history_enabled: input.history_enabled,
            },
        )?
    };

    // keyring 書き込みでエラーが出たら rollback (メタデータ削除)
    if let Err(err) = persist_secrets(saved.id, &input) {
        let conn = state.local_db.lock().expect("local_db mutex poisoned");
        let _ = local_db::delete(&conn, saved.id);
        let _ = keychain::delete_all(saved.id);
        return Err(err);
    }

    tracing::info!(id = %saved.id, name = %saved.name, "saved connection");
    Ok(saved)
}

fn persist_secrets(id: Uuid, input: &SaveConnectionInput) -> AppResult<()> {
    keychain::save(id, Slot::DbPassword, &input.password)?;
    if let Some(ssh) = &input.ssh {
        match &ssh.auth {
            SshAuthInput::Password { password } => {
                keychain::save(id, Slot::SshPassword, password)?;
            }
            SshAuthInput::Key { passphrase, .. } => {
                if let Some(pp) = passphrase.as_deref() {
                    if !pp.is_empty() {
                        keychain::save(id, Slot::SshKeyPassphrase, pp)?;
                    }
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn list_connections(
    state: State<'_, AppState>,
) -> AppResult<Vec<local_db::SavedConnection>> {
    let conn = state.local_db.lock().expect("local_db mutex poisoned");
    local_db::list(&conn)
}

#[derive(Debug, Deserialize)]
pub struct UpdateConnectionInput {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// 空文字なら keychain の既存値を保持する。
    #[serde(default)]
    pub password: Option<String>,
    pub database: Option<String>,
    #[serde(default)]
    pub ssl: SslConfigInput,
    #[serde(default)]
    pub ssh: Option<SshConfigInput>,
    #[serde(default)]
    pub enable_cleartext_plugin: bool,
    #[serde(default = "default_true")]
    pub history_enabled: bool,
}

#[tauri::command]
pub async fn update_connection(
    state: State<'_, AppState>,
    input: UpdateConnectionInput,
) -> AppResult<local_db::SavedConnection> {
    // 既に開いているプールがあればいったん閉じる (設定変更を反映させるため)
    let active = {
        let mut pools = state.pools.lock().expect("pools mutex poisoned");
        pools.remove(&input.id)
    };
    if let Some(active) = active {
        active.shutdown().await;
    }

    let saved = {
        let conn = state.local_db.lock().expect("local_db mutex poisoned");
        local_db::update(
            &conn,
            input.id,
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
                ssl: input.ssl.to_saved(),
                ssh: input.ssh.as_ref().map(SshConfigInput::saved_meta),
                enable_cleartext_plugin: input.enable_cleartext_plugin,
                history_enabled: input.history_enabled,
            },
        )?
    };

    // DB パスワードは「空文字なら変更しない」方針
    if let Some(pw) = input.password.as_deref() {
        if !pw.is_empty() {
            keychain::save(saved.id, Slot::DbPassword, pw)?;
        }
    }

    // SSH の secret も同様に、空なら既存を保持。
    // SSH 設定が外された (ssh: null) 場合は関連 keychain エントリを削除。
    match &input.ssh {
        None => {
            let _ = keychain::delete(saved.id, Slot::SshPassword);
            let _ = keychain::delete(saved.id, Slot::SshKeyPassphrase);
        }
        Some(ssh) => match &ssh.auth {
            SshAuthInput::Password { password } => {
                if !password.is_empty() {
                    keychain::save(saved.id, Slot::SshPassword, password)?;
                }
                // 認証方式切り替え時の passphrase 残骸を除去
                let _ = keychain::delete(saved.id, Slot::SshKeyPassphrase);
            }
            SshAuthInput::Key { passphrase, .. } => {
                if let Some(pp) = passphrase.as_deref() {
                    if !pp.is_empty() {
                        keychain::save(saved.id, Slot::SshKeyPassphrase, pp)?;
                    }
                }
                let _ = keychain::delete(saved.id, Slot::SshPassword);
            }
        },
    }

    tracing::info!(id = %saved.id, name = %saved.name, "updated connection");
    Ok(saved)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: Uuid) -> AppResult<()> {
    // 開いているプールがあれば先に閉じる
    let active = {
        let mut pools = state.pools.lock().expect("pools mutex poisoned");
        pools.remove(&id)
    };
    if let Some(active) = active {
        active.shutdown().await;
    }

    {
        let conn = state.local_db.lock().expect("local_db mutex poisoned");
        local_db::delete(&conn, id)?;
    }
    keychain::delete_all(id)?;
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
    let existing_pool = {
        let pools = state.pools.lock().expect("pools mutex poisoned");
        pools.get(&id).map(|ac| ac.pool.clone())
    };
    if let Some(pool) = existing_pool {
        let version = mysql_client::fetch_version(&pool).await?;
        return Ok(OpenConnectionResult { id, version });
    }

    let saved = {
        let conn = state.local_db.lock().expect("local_db mutex poisoned");
        local_db::get(&conn, id)?
    }
    .ok_or_else(|| AppError::NotFound(format!("connection {id} not found")))?;

    let config = materialize_config(&saved)?;

    tracing::info!(%id, host = %config.host, ssh = config.ssh.is_some(), "opening connection");
    let opened = match mysql_client::open(&config).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(%id, error = %e, "open_connection: pool creation failed");
            return Err(e);
        }
    };
    let version = match mysql_client::fetch_version(&opened.pool).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(%id, error = %e, "open_connection: VERSION() failed");
            opened.pool.disconnect().await.ok();
            if let Some(t) = opened.tunnel {
                t.shutdown().await;
            }
            return Err(e);
        }
    };

    {
        let mut pools = state.pools.lock().expect("pools mutex poisoned");
        pools.insert(
            id,
            ActiveConnection {
                pool: opened.pool,
                tunnel: opened.tunnel,
            },
        );
    }
    tracing::info!(%id, %version, "connection opened");

    Ok(OpenConnectionResult { id, version })
}

fn materialize_config(saved: &local_db::SavedConnection) -> AppResult<ConnectionConfig> {
    let password = keychain::get(saved.id, Slot::DbPassword)?;
    let ssh = if let Some(ssh_meta) = &saved.ssh {
        let auth = match ssh_meta.auth_kind {
            SshAuthKind::Password => {
                let pw = keychain::get(saved.id, Slot::SshPassword)?;
                SshAuthInput::Password { password: pw }
            }
            SshAuthKind::Key => {
                let key_path = ssh_meta
                    .key_path
                    .clone()
                    .ok_or_else(|| AppError::InvalidData("ssh key path missing".into()))?;
                let passphrase = keychain::try_get(saved.id, Slot::SshKeyPassphrase)?;
                SshAuthInput::Key {
                    key_path,
                    passphrase,
                }
            }
        };
        Some(SshConfigInput {
            host: ssh_meta.host.clone(),
            port: ssh_meta.port,
            user: ssh_meta.user.clone(),
            auth,
        })
    } else {
        None
    };
    Ok(ConnectionConfig {
        host: saved.host.clone(),
        port: saved.port,
        user: saved.user.clone(),
        password,
        database: saved.database.clone(),
        ssl: SslConfigInput::from_saved(saved.ssl.clone()),
        ssh,
        enable_cleartext_plugin: saved.enable_cleartext_plugin,
    })
}

#[tauri::command]
pub async fn close_connection(state: State<'_, AppState>, id: Uuid) -> AppResult<()> {
    let active = {
        let mut pools = state.pools.lock().expect("pools mutex poisoned");
        pools.remove(&id)
    };
    if let Some(active) = active {
        active.shutdown().await;
        tracing::info!(%id, "connection closed");
    }
    Ok(())
}

#[tauri::command]
pub async fn active_connections(state: State<'_, AppState>) -> AppResult<Vec<Uuid>> {
    let pools = state.pools.lock().expect("pools mutex poisoned");
    Ok(pools.keys().copied().collect())
}
