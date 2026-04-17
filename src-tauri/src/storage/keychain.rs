use keyring::Entry;
use uuid::Uuid;

use crate::error::AppResult;

const SERVICE: &str = "com.hiraishi.porpoise";

fn entry(id: Uuid) -> AppResult<Entry> {
    Ok(Entry::new(SERVICE, &format!("connection:{id}"))?)
}

pub fn save_password(id: Uuid, password: &str) -> AppResult<()> {
    entry(id)?.set_password(password)?;
    Ok(())
}

/// keyring にエントリが無い場合 (NoEntry) も成功として扱う。
/// SavedConnection の削除時にパスワードが既に無くても問題ないため。
pub fn delete_password(id: Uuid) -> AppResult<()> {
    match entry(id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
