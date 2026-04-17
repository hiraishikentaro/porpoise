use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};

use crate::error::AppResult;

/// フロントから渡される接続情報。パスワードは keyring に保存する前提なので、
/// 現時点では平文でメモリ上に持つ (Phase 1b で keyring 連携に切り替え)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: Option<String>,
    #[serde(default)]
    pub use_ssl: bool,
}

fn connect_options(config: &ConnectionConfig) -> MySqlConnectOptions {
    let mut opts = MySqlConnectOptions::new()
        .host(&config.host)
        .port(config.port)
        .username(&config.user)
        .password(&config.password);

    if let Some(db) = &config.database {
        if !db.is_empty() {
            opts = opts.database(db);
        }
    }

    let ssl_mode = if config.use_ssl {
        MySqlSslMode::Preferred
    } else {
        MySqlSslMode::Disabled
    };
    opts.ssl_mode(ssl_mode)
}

/// 接続確認のみ行う。プールは関数終了時に drop されるので永続化しない。
/// 返り値は MySQL の `VERSION()` 文字列。
pub async fn test_connection(config: &ConnectionConfig) -> AppResult<String> {
    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(connect_options(config))
        .await?;

    let (version,): (String,) = sqlx::query_as("SELECT VERSION()").fetch_one(&pool).await?;

    pool.close().await;
    Ok(version)
}
