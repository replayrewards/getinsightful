// Context Layer: the pre-indexed business context built after each sync
// (Airbyte Agents-style context store, local flavor), plus an MCP endpoint so
// Claude / Cursor / any MCP client can attach to the same context + tools.

use crate::{api_chat, App};
use axum::extract::{Path, Query, State};
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
    let (total, pending) = memory_counts(&app).await;
    axum::Json(json!({
        "collections": collections,
        "memories": { "total": total, "pending": pending },
    }))
}

async fn memory_counts(app: &App) -> (i64, i64) {
    #[derive(sqlx::FromRow)]
    struct Counts {
        total: i64,
        pending: i64,
    }
    match sqlx::query_as::<_, Counts>(
        "select count(*) as total, count(*) filter (where status='pending') as pending from memories",
    )
    .fetch_one(&app.db)
    .await
    {
        Ok(c) => (c.total, c.pending),
        Err(_) => (0, 0),
    }
}

pub async fn search(
    State(app): State<App>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> axum::Json<Value> {
    let query = q.get("q").map(String::as_str).unwrap_or("").to_string();
    let limit = q.get("limit").and_then(|s| s.parse::<i64>().ok()).unwrap_or(30).clamp(1, 100);
    let entities = search_entities(&app, &query, limit)
        .await
        .map(|v| v["entities"].clone())
        .unwrap_or_else(|_| json!([]));
    // the UI feed shows everything; search only surfaces usable knowledge
    let memories = search_memories(&app, &query, limit, None)
        .await
        .map(|v| v["memories"].clone())
        .unwrap_or_else(|_| json!([]));
    axum::Json(json!({ "entities": entities, "memories": memories }))
}

pub(crate) fn search_entities(
    app: &App,
    q: &str,
    limit: i64,
) -> impl std::future::Future<Output = sqlx::Result<Value>> + Send {
    let app = app.clone();
    let q = q.to_string();
    async move {
        let rows = if q.trim().is_empty() {
            sqlx::query(
                "select source, collection, entity_id, title, summary, attrs
                 from ctx_entities order by indexed_at desc limit $1",
            )
            .bind(limit)
            .fetch_all(&app.db)
            .await?
        } else {
            let like = format!("%{}%", q.replace('%', ""));
            // one query, hybrid rank: full-text relevance vs trigram similarity,
            // whichever scores higher wins. ponytail: reciprocal-rank fusion +
            // pgvector embeddings when this ordering measurably falls short.
            sqlx::query(
                "select source, collection, entity_id, title, summary, attrs
                 from ctx_entities
                 where tsv @@ websearch_to_tsquery('english', $1) or title ilike $2 or summary ilike $2
                 order by greatest(
                     ts_rank(tsv, websearch_to_tsquery('english', $1)),
                     similarity(title, $1)
                 ) desc, indexed_at desc
                 limit $3",
            )
            .bind(q)
            .bind(&like)
            .bind(limit)
            .fetch_all(&app.db)
            .await?
        };
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

// -- Memories: durable extracted knowledge with an approval flow --------------

/// Search (or list, when `q` empty) memories. `statuses` None = all (UI);
/// Some = restrict (the context_search tool sends pending+approved).
pub(crate) async fn search_memories(
    app: &App,
    q: &str,
    limit: i64,
    statuses: Option<&[&str]>,
) -> Result<Value, String> {
    let statuses = statuses.unwrap_or(&["pending", "approved"]);
    let rows = if q.trim().is_empty() {
        sqlx::query(
            "select id, kind, text, status, source, provenance, created_at
             from memories where status = any($2) order by created_at desc limit $1",
        )
        .bind(limit)
        .bind(statuses)
        .fetch_all(&app.db)
        .await
        .map_err(|e| e.to_string())?
    } else {
        let like = format!("%{}%", q.replace('%', ""));
        sqlx::query(
            "select id, kind, text, status, source, provenance, created_at
             from memories
             where status = any($4) and (tsv @@ websearch_to_tsquery('english', $1) or text ilike $2)
             order by greatest(ts_rank(tsv, websearch_to_tsquery('english', $1)), similarity(text, $1)) desc
             limit $3",
        )
        .bind(q)
        .bind(&like)
        .bind(limit)
        .bind(statuses)
        .fetch_all(&app.db)
        .await
        .map_err(|e| e.to_string())?
    };
    Ok(memories_json(&rows))
}

fn memories_json(rows: &[sqlx::postgres::PgRow]) -> Value {
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>(0),
                "kind": r.get::<String, _>(1),
                "text": r.get::<String, _>(2),
                "status": r.get::<String, _>(3),
                "source": r.get::<String, _>(4),
                "provenance": r.get::<Value, _>(5),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>(6),
            })
        })
        .collect();
    json!({ "memories": out })
}

/// GET /api/context/memories?status=pending — the moderation feed.
pub async fn memories_list(
    State(app): State<App>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> axum::Json<Value> {
    let limit = q.get("limit").and_then(|s| s.parse::<i64>().ok()).unwrap_or(200).clamp(1, 500);
    let v = search_memories(&app, "", limit, None).await.unwrap_or(json!({ "memories": [] }));
    axum::Json(v)
}

/// PATCH /api/context/memories/{id} {"status": "approved"|"rejected"}
pub async fn memories_patch(
    State(app): State<App>,
    Path(id): Path<i64>,
    axum::Json(body): axum::Json<Value>,
) -> axum::Json<Value> {
    let status = body.get("status").and_then(|s| s.as_str()).unwrap_or("");
    if !matches!(status, "approved" | "rejected" | "pending") {
        return axum::Json(json!({ "error": "status must be approved|rejected|pending" }));
    }
    let r = sqlx::query("update memories set status = $2 where id = $1")
        .bind(id)
        .bind(status)
        .execute(&app.db)
        .await;
    match r {
        Ok(res) if res.rows_affected() > 0 => axum::Json(json!({ "ok": true })),
        _ => axum::Json(json!({ "error": "memory not found" })),
    }
}

/// DELETE /api/context/memories/{id}
pub async fn memories_delete(State(app): State<App>, Path(id): Path<i64>) -> axum::Json<Value> {
    let _ = sqlx::query("delete from memories where id = $1").bind(id).execute(&app.db).await;
    axum::Json(json!({ "ok": true }))
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
