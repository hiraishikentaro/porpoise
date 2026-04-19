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

/// 実行中のクエリ: request_id (フロント発行) → (tauri 接続 id, MySQL thread id)
/// cancel_query(request_id) 時に別コネクションから `KILL QUERY {thread}` を撃つために使う。
#[derive(Clone, Copy, Debug)]
pub struct RunningQuery {
    pub connection_id: Uuid,
    pub mysql_thread_id: u32,
}

/// Application-wide state shared between Tauri commands.
pub struct AppState {
    pub local_db: Mutex<Connection>,
    pub pools: Mutex<HashMap<Uuid, ActiveConnection>>,
    pub running_queries: Mutex<HashMap<Uuid, RunningQuery>>,
}

impl AppState {
    pub fn new(local_db: Connection) -> Self {
        Self {
            local_db: Mutex::new(local_db),
            pools: Mutex::new(HashMap::new()),
            running_queries: Mutex::new(HashMap::new()),
        }
    }
}
