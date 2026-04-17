mod commands;
mod db;
mod error;
mod state;
mod storage;

use tauri::Manager;
use tracing_subscriber::{fmt, EnvFilter};

fn init_tracing() {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,porpoise=debug"));
    fmt().with_env_filter(filter).with_target(true).init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    tracing::info!("starting porpoise");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_local_data_dir()
                .map_err(|e| error::AppError::Setup(e.to_string()))?;
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| error::AppError::Setup(e.to_string()))?;
            let db_path = data_dir.join("connections.db");
            tracing::info!(path = %db_path.display(), "opening local db");
            let conn = storage::local_db::open(&db_path)?;
            app.manage(state::AppState::new(conn));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::test_connection,
            commands::connection::save_connection,
            commands::connection::update_connection,
            commands::connection::list_connections,
            commands::connection::delete_connection,
            commands::connection::open_connection,
            commands::connection::close_connection,
            commands::connection::active_connections,
            commands::schema::list_databases,
            commands::schema::list_tables,
            commands::schema::describe_table,
            commands::schema::select_table_rows,
            commands::schema::commit_changes,
            commands::schema::execute_query,
            commands::schema::schema_snapshot,
            commands::history::list_query_history,
            commands::history::clear_query_history,
            commands::snippets::save_snippet,
            commands::snippets::update_snippet,
            commands::snippets::list_snippets,
            commands::snippets::delete_snippet,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
