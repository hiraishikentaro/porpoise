use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{load_secret_key, ssh_key, PrivateKeyWithHashAlg};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct SshRuntimeConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshRuntimeAuth,
}

#[derive(Debug, Clone)]
pub enum SshRuntimeAuth {
    Password(String),
    Key {
        path: String,
        passphrase: Option<String>,
    },
}

struct NoopHandler;

impl client::Handler for NoopHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // TODO: host key 検証を known_hosts に寄せる。現段階では trust-first-use。
        Ok(true)
    }
}

pub struct SshTunnel {
    local_addr: SocketAddr,
    session: Arc<Handle<NoopHandler>>,
    listener_task: JoinHandle<()>,
}

impl SshTunnel {
    pub async fn start(
        ssh: &SshRuntimeConfig,
        target_host: &str,
        target_port: u16,
    ) -> AppResult<Self> {
        let cfg = client::Config {
            // プール接続が idle の間に session が切れて channel open が失敗する
            // 問題があるので 24 時間まで延長。keepalive は russh が裏で送ってくれる。
            inactivity_timeout: Some(Duration::from_secs(60 * 60 * 24)),
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 6,
            ..client::Config::default()
        };
        // SSH 先が応答しない場合の TCP ハンドシェイクは OS デフォルトで
        // 60 秒以上待たされるので、明示的に短めに切る。
        let connect_fut =
            client::connect(Arc::new(cfg), (ssh.host.as_str(), ssh.port), NoopHandler);
        let handle = match tokio::time::timeout(Duration::from_secs(10), connect_fut).await {
            Ok(result) => result.map_err(map_ssh_err)?,
            Err(_) => {
                return Err(AppError::Ssh(format!(
                    "ssh connect timed out after 10s ({}:{})",
                    ssh.host, ssh.port
                )));
            }
        };
        let mut handle = handle;

        let authed = match &ssh.auth {
            SshRuntimeAuth::Password(pw) => handle
                .authenticate_password(&ssh.user, pw)
                .await
                .map_err(map_ssh_err)?,
            SshRuntimeAuth::Key { path, passphrase } => {
                let key = load_secret_key(path, passphrase.as_deref())
                    .map_err(|e| AppError::Ssh(format!("private key load failed: {e}")))?;
                let with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
                handle
                    .authenticate_publickey(&ssh.user, with_alg)
                    .await
                    .map_err(map_ssh_err)?
            }
        };
        if !authed.success() {
            return Err(AppError::Ssh(format!(
                "ssh authentication rejected for user {}",
                ssh.user
            )));
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| AppError::Ssh(format!("local listener bind failed: {e}")))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| AppError::Ssh(format!("local_addr failed: {e}")))?;

        let session = Arc::new(handle);
        let session_for_task = session.clone();
        let target_host = target_host.to_string();

        let listener_task = tokio::spawn(async move {
            loop {
                let (mut local_stream, peer) = match listener.accept().await {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(error = %e, "ssh tunnel listener accept failed");
                        break;
                    }
                };
                let session = session_for_task.clone();
                let target_host = target_host.clone();
                tokio::spawn(async move {
                    let channel = match session
                        .channel_open_direct_tcpip(
                            target_host.as_str(),
                            u32::from(target_port),
                            peer.ip().to_string(),
                            u32::from(peer.port()),
                        )
                        .await
                    {
                        Ok(c) => c,
                        Err(e) => {
                            tracing::warn!(error = %e, "direct-tcpip channel open failed");
                            let _ = local_stream.shutdown().await;
                            return;
                        }
                    };
                    let mut channel_stream = channel.into_stream();
                    if let Err(e) =
                        tokio::io::copy_bidirectional(&mut local_stream, &mut channel_stream).await
                    {
                        tracing::debug!(error = %e, "ssh tunnel stream closed");
                    }
                });
            }
        });

        Ok(Self {
            local_addr,
            session,
            listener_task,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub async fn shutdown(self) {
        self.listener_task.abort();
        let _ = self
            .session
            .disconnect(russh::Disconnect::ByApplication, "bye", "en")
            .await;
    }
}

fn map_ssh_err(e: russh::Error) -> AppError {
    AppError::Ssh(e.to_string())
}
