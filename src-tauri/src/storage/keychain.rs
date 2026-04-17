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

pub fn save(id: Uuid, slot: Slot, secret: &str) -> AppResult<()> {
    entry(id, slot)?.set_password(secret)?;
    Ok(())
}

pub fn get(id: Uuid, slot: Slot) -> AppResult<String> {
    Ok(entry(id, slot)?.get_password()?)
}

pub fn try_get(id: Uuid, slot: Slot) -> AppResult<Option<String>> {
    match entry(id, slot)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// keyring にエントリが無い場合 (NoEntry) も成功として扱う。
pub fn delete(id: Uuid, slot: Slot) -> AppResult<()> {
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
