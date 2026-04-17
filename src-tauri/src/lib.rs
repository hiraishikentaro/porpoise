mod commands;
mod db;
mod error;
mod state;

use tracing_subscriber::{EnvFilter, fmt};

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,porpoise=debug"));
    fmt().with_env_filter(filter).with_target(true).init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    tracing::info!("starting porpoise");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![commands::connection::test_connection])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
