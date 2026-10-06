#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Desktop entry: boots the axum API (same server the browser dev app uses),
// then opens the Tauri window pointing at the frontend.
fn main() {
    getinsightful_lib::run()
}
