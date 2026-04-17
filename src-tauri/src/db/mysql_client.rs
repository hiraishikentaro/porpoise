use std::path::PathBuf;
use std::time::Duration;

use mysql_async::prelude::Queryable;
use mysql_async::{ClientIdentity, OptsBuilder, Pool, PoolConstraints, PoolOpts, SslOpts};
use serde::Deserialize;

use crate::db::ssh_tunnel::{SshRuntimeAuth, SshRuntimeConfig, SshTunnel};
use crate::error::{AppError, AppResult};
use crate::storage::local_db::{SavedSshConfig, SavedSslConfig, SshAuthKind, SslMode};

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SslConfigInput {
    #[serde(default)]
    pub mode: SslMode,
    pub ca_cert_path: Option<String>,
    pub client_cert_path: Option<String>,
    pub client_key_path: Option<String>,
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
    #[serde(default)]
    pub enable_cleartext_plugin: bool,
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

/// SslMode → mysql_async SslOpts に変換。Disabled は None を返す。
fn ssl_opts_for(mode: SslMode, ssl: &SslConfigInput) -> Option<SslOpts> {
    if matches!(mode, SslMode::Disabled) {
        return None;
    }
    let mut opts = SslOpts::default();
    if let Some(p) = ssl.ca_cert_path.as_ref().filter(|s| !s.is_empty()) {
        opts = opts.with_root_certs(vec![PathBuf::from(p).into()]);
    }
    if let (Some(cert), Some(key)) = (
        ssl.client_cert_path.as_ref().filter(|s| !s.is_empty()),
        ssl.client_key_path.as_ref().filter(|s| !s.is_empty()),
    ) {
        opts = opts.with_client_identity(Some(ClientIdentity::new(
            PathBuf::from(cert).into(),
            PathBuf::from(key).into(),
        )));
    }
    let (accept_invalid_certs, skip_domain) = match mode {
        SslMode::Preferred | SslMode::Required => (true, true),
        SslMode::VerifyCa => (false, true),
        SslMode::VerifyIdentity => (false, false),
        SslMode::Disabled => (false, false),
    };
    opts = opts
        .with_danger_accept_invalid_certs(accept_invalid_certs)
        .with_danger_skip_domain_validation(skip_domain);
    Some(opts)
}

fn build_opts(config: &ConnectionConfig, host: &str, port: u16) -> OptsBuilder {
    let mut opts = OptsBuilder::default()
        .ip_or_hostname(host.to_string())
        .tcp_port(port)
        .user(Some(config.user.clone()))
        .pass(Some(config.password.clone()))
        .enable_cleartext_plugin(config.enable_cleartext_plugin);

    if let Some(db) = &config.database {
        if !db.is_empty() {
            opts = opts.db_name(Some(db.clone()));
        }
    }
    opts = opts.ssl_opts(ssl_opts_for(config.ssl.mode, &config.ssl));

    opts
}

pub struct OpenedConnection {
    pub pool: Pool,
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

async fn verify_connection(pool: &Pool) -> AppResult<()> {
    let conn = pool.get_conn().await?;
    conn.disconnect().await.ok();
    Ok(())
}

async fn open_pool_with(
    config: &ConnectionConfig,
    max_connections: usize,
) -> AppResult<OpenedConnection> {
    let (host, port, tunnel) = resolve_target(config).await?;
    let opts = build_opts(config, &host, port).pool_opts(
        PoolOpts::default()
            .with_constraints(PoolConstraints::new(0, max_connections).unwrap_or_default())
            .with_inactive_connection_ttl(Duration::from_secs(60)),
    );
    let pool = Pool::new(opts);
    if let Err(e) = verify_connection(&pool).await {
        pool.disconnect().await.ok();
        if let Some(t) = tunnel {
            t.shutdown().await;
        }
        return Err(e);
    }
    Ok(OpenedConnection { pool, tunnel })
}

/// 接続確認のみ。開いたプールは即閉じる。
pub async fn test_connection(config: &ConnectionConfig) -> AppResult<String> {
    let opened = open_pool_with(config, 1).await?;
    let version = fetch_version(&opened.pool).await;
    opened.pool.disconnect().await.ok();
    if let Some(t) = opened.tunnel {
        t.shutdown().await;
    }
    version
}

/// 長命プール (AppState に保持)。
pub async fn open(config: &ConnectionConfig) -> AppResult<OpenedConnection> {
    open_pool_with(config, 5).await
}

pub async fn fetch_version(pool: &Pool) -> AppResult<String> {
    let mut conn = pool.get_conn().await?;
    let version: Option<String> = conn.query_first("SELECT VERSION()").await?;
    conn.disconnect().await.ok();
    version.ok_or_else(|| AppError::InvalidData("VERSION() returned no rows".into()))
}
