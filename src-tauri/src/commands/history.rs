use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::error::AppResult;
use crate::state::AppState;
use crate::storage::local_db::{self, QueryHistoryRow};

const DEFAULT_LIMIT: u32 = 200;
const MAX_LIMIT: u32 = 1000;

#[derive(Debug, Serialize)]
pub struct QueryHistoryList {
    pub items: Vec<QueryHistoryRow>,
}

#[tauri::command]
pub fn list_query_history(
    state: State<'_, AppState>,
    connection_id: Option<Uuid>,
    search: Option<String>,
    limit: Option<u32>,
) -> AppResult<QueryHistoryList> {
    let conn = state.local_db.lock().expect("local_db mutex poisoned");
    let take = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let items = local_db::list_query_history(&conn, connection_id, search.as_deref(), take)?;
    Ok(QueryHistoryList { items })
}

#[tauri::command]
pub fn clear_query_history(
    state: State<'_, AppState>,
    connection_id: Option<Uuid>,
) -> AppResult<u64> {
    let conn = state.local_db.lock().expect("local_db mutex poisoned");
    local_db::clear_query_history(&conn, connection_id)
}
