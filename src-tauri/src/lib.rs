pub mod api_chat;
pub mod api_context;
pub mod api_dash;
pub mod api_data;
pub mod metrics;
pub mod runner;

use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::net::SocketAddr;
use std::time::Duration;

pub struct AppState {
    pub db: PgPool,
    pub http: reqwest::Client,
    /// Query result cache (both /api/query and /api/query/sql), keyed by the
    /// canonical request. No TTL: entries are overwritten on `force` and the
    /// whole map cleared when a connector sync lands new data.
    pub cache: std::sync::Mutex<std::collections::HashMap<String, Value>>,
}

pub type App = std::sync::Arc<AppState>;

pub fn database_url() -> String {
    std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://insightful:insightful@localhost:5437/warehouse".into())
}

async fn init_pool(url: &str) -> PgPool {
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(5))
        .connect(url)
        .await
        .expect("warehouse Postgres unreachable — run `docker compose -f tests/docker-compose.yml up -d` first");
    let migrator = sqlx::migrate::Migrator::new(std::path::Path::new(&format!(
        "{}/migrations",
        env!("CARGO_MANIFEST_DIR")
    )))
    .await
    .expect("migrations dir unreadable");
    migrator.run(&pool).await.expect("migrations failed");
    pool
}

pub async fn build_router(state: App) -> axum::Router {
    use axum::routing::{get, post};
    use axum::Router;

    Router::new()
        // status / setup
        .route("/api/status", get(api_data::status))
        .route("/api/setup/sample", post(api_data::setup_sample))
        .route("/api/services", get(api_data::services))
        // connectors
        .route("/api/connectors", get(api_data::list_sources).post(api_data::create_source))
        .route("/api/connectors/{id}", axum::routing::delete(api_data::delete_source).put(api_data::update_source))
        .route("/api/connectors/{id}/sync", post(api_data::sync_source))
        .route("/api/connectors/{id}/spec", get(api_data::connector_spec))
        .route("/api/catalog", get(api_data::catalog))
        .route("/api/spec", post(api_data::spec_by_name))
        // warehouse
        .route("/api/warehouse/tables", get(api_data::warehouse_tables))
        .route("/api/warehouse/tables/{schema}/{name}", get(api_data::warehouse_preview))
        .route("/api/syncs", get(api_data::sync_history))
        // dashboards + card queries
        .route("/api/dashboards", get(api_dash::list).post(api_dash::create))
        .route("/api/dashboards/{id}", get(api_dash::get_one).put(api_dash::update).delete(api_dash::remove))
        .route("/api/query", post(api_dash::query))
        .route("/api/query/sql", post(api_dash::query_sql))
        // context layer
        .route("/api/context/overview", get(api_context::overview))
        .route("/api/context/search", get(api_context::search))
        .route(
            "/api/context/memories/{id}",
            axum::routing::patch(api_context::memories_patch).delete(api_context::memories_delete),
        )
        .route("/api/context/memories", get(api_context::memories_list))
        // chat
        .route("/api/chat/config", get(api_chat::get_config).post(api_chat::set_config))
        .route("/api/chat", post(api_chat::chat))
        .route("/api/chat/sessions", get(api_chat::sessions_list))
        .route("/api/chat/sessions/{id}", get(api_chat::session_get))
        // MCP surface (Claude/Cursor can attach here)
        .route("/mcp", post(api_context::mcp))
        .route("/mcp", get(api_context::mcp_info))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state)
}

pub async fn serve_standalone() {
    tracing_subscriber::fmt::init();
    let db = init_pool(&database_url()).await;
    let state: App = std::sync::Arc::new(AppState {
        db,
        http: reqwest::Client::new(),
        cache: std::sync::Mutex::new(std::collections::HashMap::new()),
    });
    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    println!("GetInsightful API on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, build_router(state).await).await.unwrap();
}

pub fn run() {
    tracing_subscriber::fmt::init();
    tauri::Builder::default()
        .setup(|_app| {
            tauri::async_runtime::spawn(async {
                let db = init_pool(&database_url()).await;
                let state: App = std::sync::Arc::new(AppState {
                    db,
                    http: reqwest::Client::new(),
                    cache: std::sync::Mutex::new(std::collections::HashMap::new()),
                });
                let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
                let listener = tokio::net::TcpListener::bind(addr)
                    .await
                    .expect("port 3000 in use — is another instance running?");
                axum::serve(listener, build_router(state).await)
                    .await
                    .expect("api server died");
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
