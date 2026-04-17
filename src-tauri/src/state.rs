use std::collections::HashMap;
use std::sync::Mutex;

use mysql_async::Pool;
use rusqlite::Connection;
use uuid::Uuid;

use crate::db::ssh_tunnel::SshTunnel;

pub struct ActiveConnection {
    pub pool: Pool,
    pub tunnel: Option<SshTunnel>,
}

impl ActiveConnection {
    pub async fn shutdown(self) {
        // Pool::disconnect は全接続を閉じて内部タスクを止める。失敗しても握りつぶす。
        self.pool.disconnect().await.ok();
        if let Some(tunnel) = self.tunnel {
            tunnel.shutdown().await;
        }
    }
}

/// Application-wide state shared between Tauri commands.
pub struct AppState {
    pub local_db: Mutex<Connection>,
    pub pools: Mutex<HashMap<Uuid, ActiveConnection>>,
}

impl AppState {
    pub fn new(local_db: Connection) -> Self {
        Self {
            local_db: Mutex::new(local_db),
            pools: Mutex::new(HashMap::new()),
        }
    }
}
