use crate::{api_dash, metrics, runner, App};
use axum::extract::{Path, Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use std::convert::Infallible;
use tokio_stream::wrappers::ReceiverStream;

use axum::response::IntoResponse;

fn sse_event(v: &Value) -> Result<Event, Infallible> {
    Ok(Event::default().data(v.to_string()))
}

// -- status ----------------------------------------------------------------

pub async fn status(
    State(app): State<App>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let db_ok = sqlx::query("select 1").fetch_optional(&app.db).await.is_ok();
    let (sources, dashboards, ctx, syncs): (i64, i64, i64, i64) = sqlx::query(
        "select
           (select count(*) from sources),
           (select count(*) from dashboards),
           (select count(*) from ctx_entities),
           (select count(*) from sync_logs where status='done')",
    )
    .map(|r: sqlx::postgres::PgRow| {
        (r.get::<i64, _>(0), r.get::<i64, _>(1), r.get::<i64, _>(2), r.get::<i64, _>(3))
    })
    .fetch_one(&app.db)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let warehouse_tables = metrics::resolve_tables(&app.db)
        .await
        .map(|t| t.len() as i64)
        .unwrap_or(0);
    Ok(axum::Json(json!({
        "db_ok": db_ok,
        "setup_done": sources > 0,
        "sources": sources,
        "dashboards": dashboards,
        "ctx_entities": ctx,
        "syncs_done": syncs,
        "warehouse_tables": warehouse_tables,
    })))
}

pub async fn services(State(app): State<App>) -> axum::Json<Value> {
    let mut names: Vec<String> = vec![];
    if let Some(t) = metrics::find_table(&app.db, "services").await {
        if let Ok(rows) =
            sqlx::query(&format!("select name from {t} order by name")).fetch_all(&app.db).await
        {
            names = rows.into_iter().map(|r| r.get::<String, _>(0)).collect();
        }
    }
    axum::Json(json!({ "services": names }))
}

// -- setup wizard: sample data (GetInsightful Demo) --------------------------
// Real pipeline, no simulation: docker compose Postgres → SQL seed → PyAirbyte
// source-postgres read → warehouse → context index → default dashboard.

fn steps_tx() -> (tokio::sync::mpsc::Sender<Result<Event, Infallible>>, ReceiverStream<Result<Event, Infallible>>) {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(64);
    (tx, ReceiverStream::new(rx))
}

async fn send(tx: &tokio::sync::mpsc::Sender<Result<Event, Infallible>>, v: Value) {
    let _ = tx.send(sse_event(&v)).await;
}

async fn run_cmd(root: &std::path::Path, cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = tokio::process::Command::new(cmd)
        .args(args)
        .current_dir(root)
        .output()
        .await
        .map_err(|e| format!("{cmd} failed to start: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{cmd} {} exited {}: {}",
            args.join(" "),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

pub async fn setup_sample(State(app): State<App>) -> axum::response::Response {
    let (tx, rx) = steps_tx();
    let app = app.clone();
    tokio::spawn(async move {
        let root = runner::project_root();
        let step = |n: &str, detail: &str| json!({"type":"step","step":n,"detail":detail});

        send(&tx, step("docker", "Starting local Postgres (docker-compose.yml)")).await;
        if let Err(e) = run_cmd(&root, "docker", &[
            "compose", "-f", "docker-compose.yml", "up", "-d", "--wait",
        ]).await {
            send(&tx, json!({"type":"error","error": e, "hint": "Is Docker Desktop running?"})).await;
            return;
        }

        send(&tx, step("seed", "Seeding GetInsightful Demo engineering data into source DB")).await;
        if let Err(e) = run_cmd(&root, "docker", &[
            "compose", "-f", "docker-compose.yml", "exec", "-T", "db",
            "psql", "-U", "insightful", "-d", "demo_src", "-v", "ON_ERROR_STOP=1",
            "-f", "/seed/001_demo.sql",
        ]).await {
            send(&tx, json!({"type":"error","error": e})).await;
            return;
        }

        send(&tx, step("register", "Registering source-postgres connector")).await;
        let config = json!({
            "host": "localhost", "port": 5437,
            "database": "demo_src", "username": "insightful", "password": "insightful",
            "replication_method": {"method": "Standard"}
        });
        // idempotent: reuse the source registered by a previous setup run
        let existing: Option<uuid::Uuid> = sqlx::query_scalar(
            "select id from sources where connector='source-postgres' limit 1",
        )
        .fetch_optional(&app.db)
        .await
        .ok()
        .flatten();
        let source_id = match existing {
            Some(id) => id,
            None => sqlx::query_scalar(
                "insert into sources (connector, name, category, config, schedule)
                 values ('source-postgres', 'GetInsightful Demo (sample)', 'Databases', $1, 'manual')
                 returning id",
            )
            .bind(&config)
            .fetch_one(&app.db)
            .await
            .unwrap_or(uuid::Uuid::nil()),
        };
        let sync_id: i64 = sqlx::query_scalar(
            "insert into sync_logs (source_id, connector) values ($1, 'source-postgres') returning id",
        )
        .bind(source_id)
        .fetch_one(&app.db)
        .await
        .unwrap_or(0);

        send(&tx, step("ingest", "Running real Airbyte connector (PyAirbyte source-postgres → warehouse). First run downloads the connector package.")).await;
        match runner::ingest("source-postgres", &config).await {
            Ok(streams) => {
                let _ = sqlx::query("update sync_logs set status='done', finished_at=now(), streams=$2 where id=$1")
                    .bind(sync_id).bind(&streams).execute(&app.db).await;
                let _ = sqlx::query("update sources set last_sync_at=now(), status='connected' where id=$1")
                    .bind(source_id).execute(&app.db).await;
                app.cache.lock().map(|mut c| c.clear()).ok(); // data changed
                send(&tx, json!({"type":"log","text": format!("loaded streams: {streams}")})).await;
            }
            Err(e) => {
                let _ = sqlx::query("update sync_logs set status='failed', finished_at=now(), error=$2 where id=$1")
                    .bind(sync_id).bind(&e).execute(&app.db).await;
                send(&tx, json!({"type":"error","error": e})).await;
                return;
            }
        }

        send(&tx, step("context", "Building the context store (Airbyte Agents-style index)")).await;
        if let Err(e) = runner::index_context().await {
            send(&tx, json!({"type":"log","text": format!("context index warning: {e}")})).await;
        }

        send(&tx, step("dashboard", "Creating the Engineering Health dashboard")).await;
        let _ = api_dash_seed(&app).await;

        send(&tx, json!({"type":"done"})).await;
    });
    Sse::new(rx).keep_alive(KeepAlive::default()).into_response()
}

async fn api_dash_seed(app: &App) -> Result<(), sqlx::Error> {
    let count: i64 = sqlx::query_scalar("select count(*) from dashboards").fetch_one(&app.db).await?;
    if count == 0 {
        sqlx::query("insert into dashboards (slug, name, layout) values ('engineering-health', $1, $2)")
            .bind("Engineering Health")
            .bind(api_dash::default_layout())
            .execute(&app.db)
            .await?;
    }
    Ok(())
}

// -- sources ----------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
pub struct SourceRow {
    id: uuid::Uuid,
    connector: String,
    name: String,
    category: String,
    status: String,
    schedule: String,
    last_sync_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn list_sources(
    State(app): State<App>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let rows: Vec<SourceRow> = sqlx::query_as(
        "select id, connector, name, category, status, schedule, last_sync_at
         from sources order by created_at",
    )
    .fetch_all(&app.db)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(axum::Json(json!({ "sources": rows })))
}

#[derive(Deserialize)]
pub struct NewSource {
    connector: String,
    name: String,
    #[serde(default = "default_category")]
    category: String,
    #[serde(default)]
    config: Value,
    #[serde(default = "default_schedule")]
    schedule: String,
}
fn default_category() -> String { "Custom".into() }
fn default_schedule() -> String { "manual".into() }

pub async fn create_source(
    State(app): State<App>,
    axum::Json(body): axum::Json<NewSource>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let id: (uuid::Uuid, String, String) = sqlx::query(
        "insert into sources (connector, name, category, config, schedule)
         values ($1,$2,$3,$4,$5) returning id, connector, name",
    )
    .bind(&body.connector)
    .bind(&body.name)
    .bind(&body.category)
    .bind(&body.config)
    .bind(&body.schedule)
    .map(|r: sqlx::postgres::PgRow| (r.get(0), r.get(1), r.get(2)))
    .fetch_one(&app.db)
    .await
    .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(axum::Json(json!({ "id": id.0, "connector": id.1, "name": id.2 })))
}

pub async fn update_source(
    State(app): State<App>,
    Path(id): Path<uuid::Uuid>,
    axum::Json(body): axum::Json<Value>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    sqlx::query("update sources set name = coalesce($2, name), schedule = coalesce($3, schedule), status = coalesce($4, status) where id = $1")
        .bind(id)
        .bind(body.get("name").and_then(|v| v.as_str()))
        .bind(body.get("schedule").and_then(|v| v.as_str()))
        .bind(body.get("status").and_then(|v| v.as_str()))
        .execute(&app.db)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(axum::Json(json!({"ok": true})))
}

pub async fn delete_source(
    State(app): State<App>,
    Path(id): Path<uuid::Uuid>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    sqlx::query("delete from sources where id=$1")
        .bind(id)
        .execute(&app.db)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(axum::Json(json!({"ok": true})))
}

// Sync = a REAL Airbyte connector run (PyAirbyte read into the warehouse).
pub async fn sync_source(
    State(app): State<App>,
    Path(id): Path<uuid::Uuid>,
) -> axum::response::Response {
    let (tx, rx) = steps_tx();
    let app = app.clone();
    tokio::spawn(async move {
        let row: Option<(String, Value)> = sqlx::query_as(
            "select connector, config from sources where id=$1",
        )
        .bind(id)
        .fetch_optional(&app.db)
        .await
        .ok()
        .flatten();
        let Some((connector, config)) = row else {
            send(&tx, json!({"type":"error","error":"source not found"})).await;
            return;
        };
        let sync_id: i64 = sqlx::query_scalar(
            "insert into sync_logs (source_id, connector) values ($1,$2) returning id",
        )
        .bind(id)
        .bind(&connector)
        .fetch_one(&app.db)
        .await
        .unwrap_or(0);
        send(&tx, json!({"type":"step","step":"sync","detail": format!("Running {connector} via PyAirbyte")})).await;
        match runner::ingest(&connector, &config).await {
            Ok(streams) => {
                let _ = sqlx::query("update sync_logs set status='done', finished_at=now(), streams=$2 where id=$1")
                    .bind(sync_id).bind(&streams).execute(&app.db).await;
                let _ = sqlx::query("update sources set last_sync_at=now(), status='connected' where id=$1")
                    .bind(id).execute(&app.db).await;
                app.cache.lock().map(|mut c| c.clear()).ok(); // data changed
                let _ = runner::index_context().await; // keep context fresh; warnings non-fatal
                send(&tx, json!({"type":"done","streams": streams})).await;
            }
            Err(e) => {
                let _ = sqlx::query("update sync_logs set status='failed', finished_at=now(), error=$2 where id=$1")
                    .bind(sync_id).bind(&e).execute(&app.db).await;
                let _ = sqlx::query("update sources set status='error' where id=$1")
                    .bind(id).execute(&app.db).await;
                send(&tx, json!({"type":"error","error": e})).await;
            }
        }
    });
    Sse::new(rx).keep_alive(KeepAlive::default()).into_response()
}

pub async fn spec_by_name(
    State(app): State<App>,
    axum::Json(body): axum::Json<Value>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let connector = body
        .get("connector")
        .and_then(|v| v.as_str())
        .ok_or((axum::http::StatusCode::BAD_REQUEST, "missing connector".into()))?
        .to_string();
    spec_for(&app, &connector).await.map(axum::Json)
}

pub async fn connector_spec(
    State(app): State<App>,
    Path(id): Path<uuid::Uuid>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let connector: String = sqlx::query_scalar("select connector from sources where id=$1")
        .bind(id)
        .fetch_optional(&app.db)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((axum::http::StatusCode::NOT_FOUND, "source not found".into()))?;
    spec_for(&app, &connector).await.map(axum::Json)
}

async fn spec_for(_app: &App, connector: &str) -> Result<Value, (axum::http::StatusCode, String)> {
    // 1) the OSS registry ships the spec inline — instant, no connector install
    let from_registry = load_registry().into_iter().find(|c| {
        let slug = c
            .get("dockerRepository")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("");
        slug == connector
    });
    if let Some(entry) = from_registry {
        if let Some(spec) = entry.get("spec") {
            return Ok(json!({
                "connector": connector,
                "spec": spec.get("connectionSpecification").cloned().unwrap_or(json!({})),
                "documentationUrl": entry.get("documentationUrl").cloned().unwrap_or(json!("")),
            }));
        }
    }
    // 2) fallback: ask PyAirbyte (covers connectors outside the OSS registry)
    let spec = runner::connector_spec(connector)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(json!({ "connector": connector, "spec": spec }))
}

// -- connector catalog (the full Airbyte registry) ---------------------------

#[derive(Deserialize)]
pub struct CatalogQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    category: String,
    #[serde(default = "default_kind")]
    kind: String, // sources | destinations
    #[serde(default = "default_catalog_limit")]
    limit: i64,
    #[serde(default)]
    offset: i64,
}
fn default_catalog_limit() -> i64 { 60 }
fn default_kind() -> String { "sources".into() }

fn load_registry() -> Vec<Value> {
    let path = runner::project_root().join("runner/registry.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|v| {
            v.get("sources")
                .or_else(|| v.get("destinations"))
                .and_then(|s| s.as_array())
                .cloned()
                .or_else(|| v.as_array().cloned())
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

fn registry_project(c: &Value, kind: &str) -> Value {
    let name = c.get("name").and_then(|n| n.as_str()).unwrap_or("Unknown");
    let slug = c
        .get("dockerRepository")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .rsplit('/')
        .next()
        .unwrap_or(name)
        .to_string();
    json!({
        "name": name,
        "slug": slug,
        "category": c.get("sourceType").and_then(|n| n.as_str()).unwrap_or("api"),
        "kind": kind,
        "iconUrl": c.get("iconUrl").cloned().unwrap_or(json!("")),
        "documentationUrl": c.get("documentationUrl").cloned().unwrap_or(json!("")),
        "releaseStage": c.get("releaseStage").cloned().unwrap_or(json!("")),
        "supportLevel": c.get("supportLevel").cloned().unwrap_or(json!("")),
    })
}

pub async fn catalog(
    State(app): State<App>,
    Query(q): Query<CatalogQuery>,
) -> axum::Json<Value> {
    ensure_registry(&app).await;
    let all = load_registry();
    let needle = q.q.to_lowercase();
    let cat = q.category.to_lowercase();
    let mut projected: Vec<Value> = all
        .iter()
        .map(|c| registry_project(c, &q.kind))
        .filter(|c| {
            let name = c.get("name").and_then(|n| n.as_str()).unwrap_or("").to_lowercase();
            let slug = c.get("slug").and_then(|n| n.as_str()).unwrap_or("").to_lowercase();
            let category = c.get("category").and_then(|n| n.as_str()).unwrap_or("").to_lowercase();
            (needle.is_empty() || name.contains(&needle) || slug.contains(&needle))
                && (cat.is_empty() || category.contains(&cat))
        })
        .collect();
    projected.sort_by(|a, b| {
        a.get("name").and_then(|n| n.as_str()).unwrap_or("").cmp(b.get("name").and_then(|n| n.as_str()).unwrap_or(""))
    });
    let total = projected.len() as i64;
    let page: Vec<Value> = projected
        .iter()
        .skip(q.offset.max(0) as usize)
        .take(q.limit.clamp(1, 200) as usize)
        .cloned()
        .collect();
    axum::Json(json!({ "total": total, "items": page }))
}

// Registry is plain HTTPS JSON — fetch once to runner/registry.json (Rust, no python).
async fn ensure_registry(app: &App) {
    let path = runner::project_root().join("runner/registry.json");
    if path.exists() {
        return;
    }
    let url = "https://connectors.airbyte.com/files/registries/v0/oss_registry.json";
    if let Ok(resp) = app.http.get(url).timeout(std::time::Duration::from_secs(60)).send().await {
        if let Ok(body) = resp.text().await {
            if body.contains("\"sources\"") {
                let _ = std::fs::write(&path, &body);
                return;
            }
        }
    }
    // ponytail: silent empty catalog if the registry is unreachable; UI shows "no results".
}

// -- warehouse ---------------------------------------------------------------

#[derive(Deserialize)]
pub struct PreviewQuery {
    #[serde(default = "default_preview_limit")]
    limit: i64,
}
fn default_preview_limit() -> i64 { 20 }

pub async fn warehouse_tables(State(app): State<App>) -> axum::Json<Value> {
    let rows = sqlx::query(
        "select schemaname, relname, n_live_tup as rows,
                pg_total_relation_size(schemaname || '.' || relname) as bytes
         from pg_stat_user_tables
         where relname not like '\\_airbyte\\_%'
         order by n_live_tup desc",
    )
    .fetch_all(&app.db)
    .await
    .unwrap_or_default();
    let tables: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "schema": r.get::<String, _>(0),
                "name": r.get::<String, _>(1),
                "rows": r.get::<i64, _>(2),
                "bytes": r.get::<i64, _>(3),
            })
        })
        .collect();
    axum::Json(json!({ "tables": tables }))
}

fn valid_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub async fn warehouse_preview(
    State(app): State<App>,
    Path((schema, name)): Path<(String, String)>,
    Query(q): Query<PreviewQuery>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    if !valid_ident(&schema) || !valid_ident(&name) {
        return Err((axum::http::StatusCode::BAD_REQUEST, "invalid identifier".into()));
    }
    let limit = q.limit.clamp(1, 200);
    let cols = sqlx::query(
        "select column_name, data_type from information_schema.columns
         where table_schema=$1 and table_name=$2 order by ordinal_position",
    )
    .bind(&schema)
    .bind(&name)
    .fetch_all(&app.db)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if cols.is_empty() {
        return Err((axum::http::StatusCode::NOT_FOUND, "table not found".into()));
    }
    // to_jsonb(row)::text sidesteps per-type decoding of arbitrary cache columns
    let rows = sqlx::query(&format!(
        "select to_jsonb(q)::text from (select * from \"{}\".\"{}\" limit {limit}) q",
        schema.replace('"', ""),
        name.replace('"', "")
    ))
    .fetch_all(&app.db)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let out: Vec<Value> = rows
        .iter()
        .filter_map(|r| {
            r.try_get::<String, _>(0)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        })
        .collect();
    Ok(axum::Json(json!({
        "columns": cols.iter().map(|r| json!({"name": r.get::<String,_>(0), "type": r.get::<String,_>(1)})).collect::<Vec<_>>(),
        "rows": out,
    })))
}

pub async fn sync_history(
    State(app): State<App>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let rows = sqlx::query(
        "select s.id, s.connector, coalesce(src.name, s.connector) as source_name,
                s.started_at, s.finished_at, s.status, s.streams, s.error
         from sync_logs s left join sources src on src.id = s.source_id
         order by s.started_at desc limit 50",
    )
    .fetch_all(&app.db)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>(0),
                "connector": r.get::<String, _>(1),
                "source": r.get::<String, _>(2),
                "started_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>(3),
                "finished_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>(4),
                "status": r.get::<String, _>(5),
                "streams": r.get::<Value, _>(6),
                "error": r.get::<Option<String>, _>(7),
            })
        })
        .collect();
    Ok(axum::Json(json!({ "syncs": items })))
}
