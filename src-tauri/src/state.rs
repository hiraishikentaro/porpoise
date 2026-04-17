use std::sync::Mutex;

use rusqlite::Connection;

/// Application-wide state shared between Tauri commands.
///
/// `local_db` は接続メタデータ(saved_connections)を保持する rusqlite コネクション。
/// 接続プール (`HashMap<ConnectionId, sqlx::MySqlPool>`) は次スライスで追加する。
pub struct AppState {
    pub local_db: Mutex<Connection>,
}
