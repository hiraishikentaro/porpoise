use std::time::Duration;

use serde::Deserialize;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};
use sqlx::MySqlPool;

use crate::db::ssh_tunnel::{SshRuntimeAuth, SshRuntimeConfig, SshTunnel};
use crate::error::AppResult;
use crate::storage::local_db::{SavedSshConfig, SavedSslConfig, SshAuthKind, SslMode};

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SslConfigInput {
    #[serde(default = "default_ssl_mode")]
    pub mode: SslMode,
    pub ca_cert_path: Option<String>,
    pub client_cert_path: Option<String>,
    pub client_key_path: Option<String>,
}

fn default_ssl_mode() -> SslMode {
    SslMode::Disabled
}

#[derive(Debug, Clone, Deserialize)]
pub struct SshConfigInput {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuthInput,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshAuthInput {
    Password {
        password: String,
    },
    Key {
        key_path: String,
        #[serde(default)]
        passphrase: Option<String>,
    },
}

/// フロントから渡される接続情報 (test_connection / 内部で materialize した open 用)。
/// 保存時は password/ssh auth secret は keyring へ分離される。
#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: Option<String>,
    #[serde(default)]
    pub ssl: SslConfigInput,
    #[serde(default)]
    pub ssh: Option<SshConfigInput>,
}

impl SslConfigInput {
    pub fn to_saved(&self) -> SavedSslConfig {
        SavedSslConfig {
            mode: self.mode,
            ca_cert_path: self.ca_cert_path.clone(),
            client_cert_path: self.client_cert_path.clone(),
            client_key_path: self.client_key_path.clone(),
        }
    }

    pub fn from_saved(saved: SavedSslConfig) -> Self {
        Self {
            mode: saved.mode,
            ca_cert_path: saved.ca_cert_path,
            client_cert_path: saved.client_cert_path,
            client_key_path: saved.client_key_path,
        }
    }
}

impl SshConfigInput {
    pub fn saved_meta(&self) -> SavedSshConfig {
        SavedSshConfig {
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            auth_kind: match self.auth {
                SshAuthInput::Password { .. } => SshAuthKind::Password,
                SshAuthInput::Key { .. } => SshAuthKind::Key,
            },
            key_path: match &self.auth {
                SshAuthInput::Key { key_path, .. } => Some(key_path.clone()),
                SshAuthInput::Password { .. } => None,
            },
        }
    }
}

impl From<&SshConfigInput> for SshRuntimeConfig {
    fn from(c: &SshConfigInput) -> Self {
        Self {
            host: c.host.clone(),
            port: c.port,
            user: c.user.clone(),
            auth: match &c.auth {
                SshAuthInput::Password { password } => SshRuntimeAuth::Password(password.clone()),
                SshAuthInput::Key {
                    key_path,
                    passphrase,
                } => SshRuntimeAuth::Key {
                    path: key_path.clone(),
                    passphrase: passphrase.clone(),
                },
            },
        }
    }
}

fn map_ssl_mode(mode: SslMode) -> MySqlSslMode {
    match mode {
        SslMode::Disabled => MySqlSslMode::Disabled,
        SslMode::Preferred => MySqlSslMode::Preferred,
        SslMode::Required => MySqlSslMode::Required,
        SslMode::VerifyCa => MySqlSslMode::VerifyCa,
        SslMode::VerifyIdentity => MySqlSslMode::VerifyIdentity,
    }
}

fn build_connect_options(config: &ConnectionConfig, host: &str, port: u16) -> MySqlConnectOptions {
    let mut opts = MySqlConnectOptions::new()
        .host(host)
        .port(port)
        .username(&config.user)
        .password(&config.password)
        .ssl_mode(map_ssl_mode(config.ssl.mode));

    if let Some(db) = &config.database {
        if !db.is_empty() {
            opts = opts.database(db);
        }
    }
    if let Some(p) = &config.ssl.ca_cert_path {
        if !p.is_empty() {
            opts = opts.ssl_ca(p);
        }
    }
    if let Some(p) = &config.ssl.client_cert_path {
        if !p.is_empty() {
            opts = opts.ssl_client_cert(p);
        }
    }
    if let Some(p) = &config.ssl.client_key_path {
        if !p.is_empty() {
            opts = opts.ssl_client_key(p);
        }
    }
    opts
}

pub struct OpenedConnection {
    pub pool: MySqlPool,
    pub tunnel: Option<SshTunnel>,
}

async fn resolve_target(config: &ConnectionConfig) -> AppResult<(String, u16, Option<SshTunnel>)> {
    if let Some(ssh) = &config.ssh {
        let tunnel = SshTunnel::start(&ssh.into(), &config.host, config.port).await?;
        let addr = tunnel.local_addr();
        Ok((addr.ip().to_string(), addr.port(), Some(tunnel)))
    } else {
        Ok((config.host.clone(), config.port, None))
    }
}

async fn open_pool_with_limits(
    config: &ConnectionConfig,
    max_connections: u32,
    acquire_timeout: Duration,
) -> AppResult<OpenedConnection> {
    let (host, port, tunnel) = resolve_target(config).await?;
    let opts = build_connect_options(config, &host, port);
    let pool = match MySqlPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(acquire_timeout)
        .connect_with(opts)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            if let Some(t) = tunnel {
                t.shutdown().await;
            }
            return Err(e.into());
        }
    };
    Ok(OpenedConnection { pool, tunnel })
}

/// 接続確認のみ行う。プールは関数終了時に drop されるので永続化しない。
/// 返り値は MySQL の `VERSION()` 文字列。
pub async fn test_connection(config: &ConnectionConfig) -> AppResult<String> {
    let opened = open_pool_with_limits(config, 1, Duration::from_secs(10)).await?;
    let result = fetch_version(&opened.pool).await;
    opened.pool.close().await;
    if let Some(tunnel) = opened.tunnel {
        tunnel.shutdown().await;
    }
    result
}

/// AppState に保持する長命プールを作成する (SSH トンネル併用時は tunnel も返す)。
pub async fn open(config: &ConnectionConfig) -> AppResult<OpenedConnection> {
    open_pool_with_limits(config, 5, Duration::from_secs(15)).await
}

pub async fn fetch_version(pool: &MySqlPool) -> AppResult<String> {
    let (version,): (String,) = sqlx::query_as("SELECT VERSION()").fetch_one(pool).await?;
    Ok(version)
}
