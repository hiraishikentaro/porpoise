use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::Connection;
use sqlx::MySqlPool;
use uuid::Uuid;

use crate::db::ssh_tunnel::SshTunnel;

pub struct ActiveConnection {
    pub pool: MySqlPool,
    pub tunnel: Option<SshTunnel>,
}

impl ActiveConnection {
    pub async fn shutdown(self) {
        self.pool.close().await;
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
