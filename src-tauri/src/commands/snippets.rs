use tauri::State;
use uuid::Uuid;

use crate::error::AppResult;
use crate::state::AppState;
use crate::storage::local_db::{self, SavedQuery};

#[tauri::command]
pub fn save_snippet(
    state: State<'_, AppState>,
    connection_id: Uuid,
    name: String,
    sql: String,
) -> AppResult<SavedQuery> {
    let conn = state.local_db.lock().expect("local_db mutex poisoned");
    local_db::insert_saved_query(&conn, connection_id, &name, &sql)
}

#[tauri::command]
pub fn update_snippet(
    state: State<'_, AppState>,
    id: i64,
    name: String,
    sql: String,
) -> AppResult<SavedQuery> {
    let conn = state.local_db.lock().expect("local_db mutex poisoned");
    local_db::update_saved_query(&conn, id, &name, &sql)
}

#[tauri::command]
pub fn list_snippets(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> AppResult<Vec<SavedQuery>> {
    let conn = state.local_db.lock().expect("local_db mutex poisoned");
    local_db::list_saved_queries(&conn, connection_id)
}

#[tauri::command]
pub fn delete_snippet(state: State<'_, AppState>, id: i64) -> AppResult<bool> {
    let conn = state.local_db.lock().expect("local_db mutex poisoned");
    local_db::delete_saved_query(&conn, id)
}
