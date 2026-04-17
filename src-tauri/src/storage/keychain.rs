use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use keyring::Entry;
use uuid::Uuid;

use crate::error::AppResult;

const SERVICE: &str = "com.hiraishi.porpoise";

#[derive(Clone, Copy)]
pub enum Slot {
    DbPassword,
    SshPassword,
    SshKeyPassphrase,
}

impl Slot {
    fn suffix(self) -> &'static str {
        match self {
            Self::DbPassword => "",
            Self::SshPassword => ":ssh-password",
            Self::SshKeyPassphrase => ":ssh-passphrase",
        }
    }
}

fn entry(id: Uuid, slot: Slot) -> AppResult<Entry> {
    Ok(Entry::new(
        SERVICE,
        &format!("connection:{id}{}", slot.suffix()),
    )?)
}

/// 同一プロセス内のセッションキャッシュ。
/// keychain のダイアログ (macOS) や dbus 呼び出し (Linux) を 2 回目以降スキップする。
/// プロセスが死んだら消える揮発キャッシュなので、永続化しているのは常に OS keyring 側のみ。
static CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn cache_key(id: Uuid, slot: Slot) -> String {
    format!("{id}{}", slot.suffix())
}

fn cache_get(id: Uuid, slot: Slot) -> Option<String> {
    CACHE
        .lock()
        .expect("keychain cache mutex poisoned")
        .get(&cache_key(id, slot))
        .cloned()
}

fn cache_put(id: Uuid, slot: Slot, value: &str) {
    CACHE
        .lock()
        .expect("keychain cache mutex poisoned")
        .insert(cache_key(id, slot), value.to_string());
}

fn cache_del(id: Uuid, slot: Slot) {
    CACHE
        .lock()
        .expect("keychain cache mutex poisoned")
        .remove(&cache_key(id, slot));
}

pub fn save(id: Uuid, slot: Slot, secret: &str) -> AppResult<()> {
    entry(id, slot)?.set_password(secret)?;
    cache_put(id, slot, secret);
    Ok(())
}

pub fn get(id: Uuid, slot: Slot) -> AppResult<String> {
    if let Some(v) = cache_get(id, slot) {
        return Ok(v);
    }
    let secret = entry(id, slot)?.get_password()?;
    cache_put(id, slot, &secret);
    Ok(secret)
}

pub fn try_get(id: Uuid, slot: Slot) -> AppResult<Option<String>> {
    if let Some(v) = cache_get(id, slot) {
        return Ok(Some(v));
    }
    match entry(id, slot)?.get_password() {
        Ok(s) => {
            cache_put(id, slot, &s);
            Ok(Some(s))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// keyring にエントリが無い場合 (NoEntry) も成功として扱う。
pub fn delete(id: Uuid, slot: Slot) -> AppResult<()> {
    cache_del(id, slot);
    match entry(id, slot)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_all(id: Uuid) -> AppResult<()> {
    delete(id, Slot::DbPassword)?;
    delete(id, Slot::SshPassword)?;
    delete(id, Slot::SshKeyPassphrase)?;
    Ok(())
}
