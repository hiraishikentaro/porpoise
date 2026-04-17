use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::Connection;
use sqlx::MySqlPool;
use uuid::Uuid;

/// Application-wide state shared between Tauri commands.
///
/// - `local_db`: 接続メタデータ (saved_connections) を保持する rusqlite コネクション
/// - `pools`: 開いている MySQL 接続プール。MySqlPool 内部は Arc なので clone で渡す
pub struct AppState {
    pub local_db: Mutex<Connection>,
    pub pools: Mutex<HashMap<Uuid, MySqlPool>>,
}

impl AppState {
    pub fn new(local_db: Connection) -> Self {
        Self {
            local_db: Mutex::new(local_db),
            pools: Mutex::new(HashMap::new()),
        }
    }
}
