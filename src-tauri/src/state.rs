/// Application-wide state shared between Tauri commands.
///
/// Phase 1 現時点では中身なし。
/// 接続プール (`HashMap<ConnectionId, sqlx::MySqlPool>`) は次のスライスで追加する。
#[derive(Default)]
pub struct AppState {}
