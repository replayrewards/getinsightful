// Server-only entry (`npm run api` / `cargo run --bin api`): same axum app the
// Tauri shell embeds, for browser-only development and for the agent's checks.
#[tokio::main]
async fn main() {
    getinsightful_lib::serve_standalone().await;
}
