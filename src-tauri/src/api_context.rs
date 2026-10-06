// Context Layer: the pre-indexed business context built after each sync
// (Airbyte Agents-style context store, local flavor), plus an MCP endpoint so
// Claude / Cursor / any MCP client can attach to the same context + tools.

use crate::{api_chat, App};
use axum::extract::{Query, State};
use serde_json::{json, Value};
use sqlx::Row;

pub async fn overview(State(app): State<App>) -> axum::Json<Value> {
    let rows = sqlx::query(
        "select source, collection, count(*) as entities, max(indexed_at) as updated
         from ctx_entities group by source, collection order by source, collection",
    )
    .fetch_all(&app.db)
    .await
    .unwrap_or_default();
    let collections: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "source": r.get::<String, _>(0),
                "collection": r.get::<String, _>(1),
                "entities": r.get::<i64, _>(2),
                "updated": r.get::<chrono::DateTime<chrono::Utc>, _>(3),
            })
        })
        .collect();
    axum::Json(json!({ "collections": collections }))
}

pub async fn search(
    State(app): State<App>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> axum::Json<Value> {
    let query = q.get("q").map(String::as_str).unwrap_or("").to_string();
    let limit = q.get("limit").and_then(|s| s.parse::<i64>().ok()).unwrap_or(30).clamp(1, 100);
    match search_entities(&app, &query, limit).await {
        Ok(v) => axum::Json(v),
        Err(e) => axum::Json(json!({ "error": e.to_string(), "entities": [] })),
    }
}

pub(crate) fn search_entities(
    app: &App,
    q: &str,
    limit: i64,
) -> impl std::future::Future<Output = sqlx::Result<Value>> + Send {
    let app = app.clone();
    let q = q.to_string();
    async move {
        if q.trim().is_empty() {
            let rows = sqlx::query(
                "select source, collection, entity_id, title, summary, attrs
                 from ctx_entities order by indexed_at desc limit $1",
            )
            .bind(limit)
            .fetch_all(&app.db)
            .await?;
            return Ok(entities_json(&rows));
        }
        let like = format!("%{}%", q.replace('%', ""));
        let rows = sqlx::query(
            "select source, collection, entity_id, title, summary, attrs
             from ctx_entities
             where title ilike $1 or summary ilike $1
             order by similarity(title, $2) desc nulls last, indexed_at desc
             limit $3",
        )
        .bind(&like)
        .bind(q)
        .bind(limit)
        .fetch_all(&app.db)
        .await?;
        Ok(entities_json(&rows))
    }
}

fn entities_json(rows: &[sqlx::postgres::PgRow]) -> Value {
    let entities: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "source": r.get::<String, _>(0),
                "collection": r.get::<String, _>(1),
                "id": r.get::<String, _>(2),
                "title": r.get::<String, _>(3),
                "summary": r.get::<String, _>(4),
                "attrs": r.get::<Value, _>(5),
            })
        })
        .collect();
    json!({ "entities": entities })
}

// -- MCP (streamable-http flavor: JSON-RPC 2.0 over POST /mcp) ----------------

pub async fn mcp_info() -> axum::Json<Value> {
    axum::Json(json!({
        "server": "getinsightful",
        "version": env!("CARGO_PKG_VERSION"),
        "transport": "JSON-RPC 2.0 over HTTP POST /mcp",
        "hint": "Point Claude/Cursor here (e.g. via a streamable-http MCP client) and call tools/list.",
        "tools": ["context_search", "run_sql", "list_tables"],
    }))
}

pub async fn mcp(
    State(app): State<App>,
    axum::Json(req): axum::Json<Value>,
) -> axum::response::Response {
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = req.get("id").cloned();
    let result: Value = match method {
        "initialize" => json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "getinsightful", "version": env!("CARGO_PKG_VERSION") },
        }),
        "tools/list" => json!({ "tools": api_chat::tools_json() }),
        "tools/call" => {
            let name = req.pointer("/params/name").and_then(|n| n.as_str()).unwrap_or("");
            let args = req.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            match api_chat::execute_tool(&app, name, &args).await {
                Ok(v) => json!({ "content": [ { "type": "text", "text": v.to_string() } ] }),
                Err(e) => json!({ "content": [ { "type": "text", "text": e } ], "isError": true }),
            }
        }
        "ping" => json!({}),
        _ => {
            let err = json!({ "code": -32601, "message": "method not found" });
            let mut resp = json!({ "jsonrpc": "2.0", "error": err });
            if let Some(id) = id {
                resp["id"] = id;
            }
            return axum::Json(resp).into_response();
        }
    };
    let mut resp = json!({ "jsonrpc": "2.0", "result": result });
    if let Some(id) = id {
        resp["id"] = id;
    }
    axum::Json(resp).into_response()
}

use axum::response::IntoResponse;
