use crate::db::mysql_client::{self, ConnectionConfig};
use crate::error::AppResult;

/// フロントから呼ばれる接続テスト。成功時は MySQL の VERSION() を返す。
#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> AppResult<String> {
    tracing::info!(host = %config.host, port = config.port, "testing connection");
    let version = mysql_client::test_connection(&config).await?;
    tracing::info!(%version, "connection ok");
    Ok(version)
}
