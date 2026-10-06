use crate::{metrics, App};
use axum::extract::{Path, State};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

// -- result cache -------------------------------------------------------------

fn cache_get(app: &App, key: &str) -> Option<Value> {
    app.cache.lock().ok()?.get(key).cloned()
}

fn cache_put(app: &App, key: String, v: Value) {
    if let Ok(mut map) = app.cache.lock() {
        map.insert(key, v);
    }
}

// The seeded Engineering Health dashboard. Grid is 12 columns (react-grid-layout).
pub fn default_layout() -> Value {
    json!({ "cards": [
        { "id": "c1",  "type": "kpi",   "title": "Active incidents",   "metric": "kpi_active_incidents", "x": 0,  "y": 0, "w": 2, "h": 2, "options": { "goodDirection": "down" } },
        { "id": "c2",  "type": "kpi",   "title": "p95 latency",        "metric": "kpi_p95_latency",      "x": 2,  "y": 0, "w": 2, "h": 2, "options": { "unit": "ms", "goodDirection": "down" } },
        { "id": "c3",  "type": "kpi",   "title": "Error rate",         "metric": "kpi_error_rate",       "x": 4,  "y": 0, "w": 2, "h": 2, "options": { "unit": "%", "goodDirection": "down" } },
        { "id": "c4",  "type": "kpi",   "title": "Deployments",        "metric": "kpi_deploys",          "x": 6,  "y": 0, "w": 2, "h": 2, "options": { "goodDirection": "up" } },
        { "id": "c5",  "type": "kpi",   "title": "MTTR",               "metric": "kpi_mttr",             "x": 8,  "y": 0, "w": 2, "h": 2, "options": { "unit": "min", "goodDirection": "down" } },
        { "id": "c6",  "type": "kpi",   "title": "Alerts firing",      "metric": "kpi_firing_alerts",    "x": 10, "y": 0, "w": 2, "h": 2, "options": { "goodDirection": "down" } },
        { "id": "c7",  "type": "hero",  "title": "Requests served",    "metric": "hero_requests",        "x": 0,  "y": 2, "w": 4, "h": 3, "options": {} },
        { "id": "c8",  "type": "hbar",  "title": "Incidents by service", "metric": "incidents_by_service", "x": 4, "y": 2, "w": 4, "h": 4, "options": {} },
        { "id": "c9",  "type": "bar",   "title": "Deployments per day", "metric": "deploys_per_day",     "x": 8,  "y": 2, "w": 4, "h": 3, "options": {} },
        { "id": "c10", "type": "line",  "title": "p95 latency by service", "metric": "latency_by_service", "x": 8, "y": 5, "w": 4, "h": 4, "options": { "unit": "ms" } },
        { "id": "c11", "type": "table", "title": "Recent incidents",   "metric": "recent_incidents",     "x": 0,  "y": 5, "w": 4, "h": 4, "options": {} },
        { "id": "c12", "type": "line",  "title": "DB replica lag",     "metric": "db_replica_lag",       "x": 4,  "y": 6, "w": 4, "h": 3, "options": { "unit": "ms" } },
        { "id": "c13", "type": "insight", "title": "AI insight",       "metric": "insight_main",         "x": 8,  "y": 9, "w": 4, "h": 3, "options": {} }
    ] })
}

pub async fn list(
    State(app): State<App>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    // heal fresh setups: seed the Engineering Health dashboard once data exists
    let count: i64 = sqlx::query_scalar("select count(*) from dashboards")
        .fetch_one(&app.db)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if count == 0 && crate::metrics::find_table(&app.db, "incidents").await.is_some() {
        let _ = sqlx::query("insert into dashboards (slug, name, layout) values ('engineering-health', $1, $2)")
            .bind("Engineering Health")
            .bind(default_layout())
            .execute(&app.db)
            .await;
    }
    let rows = sqlx::query(
        "select id, slug, name, layout, created_at, updated_at from dashboards order by created_at",
    )
    .fetch_all(&app.db)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let items: Vec<Value> = rows.iter().map(row_to_dash).collect();
    Ok(axum::Json(json!({ "dashboards": items })))
}

fn row_to_dash(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": r.get::<uuid::Uuid, _>("id"),
        "slug": r.get::<String, _>("slug"),
        "name": r.get::<String, _>("name"),
        "layout": r.get::<Value, _>("layout"),
        "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        "updated_at": r.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
    })
}

#[derive(Deserialize)]
pub struct NewDashboard {
    name: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    layout: Value,
}

fn slugify(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

pub async fn create(
    State(app): State<App>,
    axum::Json(body): axum::Json<NewDashboard>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let slug = if body.slug.is_empty() {
        let base = slugify(&body.name);
        let suffix: String = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
        format!("{base}-{suffix}")
    } else {
        body.slug
    };
    let row = sqlx::query(
        "insert into dashboards (slug, name, layout) values ($1,$2,$3)
         returning id, slug, name, layout, created_at, updated_at",
    )
    .bind(&slug)
    .bind(&body.name)
    .bind(if body.layout.is_null() { json!({"cards": []}) } else { body.layout })
    .fetch_one(&app.db)
    .await
    .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(axum::Json(row_to_dash(&row)))
}

pub async fn get_one(
    State(app): State<App>,
    Path(id): Path<uuid::Uuid>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let row = sqlx::query(
        "select id, slug, name, layout, created_at, updated_at from dashboards where id=$1",
    )
    .bind(id)
    .fetch_optional(&app.db)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .ok_or((axum::http::StatusCode::NOT_FOUND, "dashboard not found".into()))?;
    Ok(axum::Json(row_to_dash(&row)))
}

pub async fn update(
    State(app): State<App>,
    Path(id): Path<uuid::Uuid>,
    axum::Json(body): axum::Json<Value>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let row = sqlx::query(
        "update dashboards set
            name = coalesce($2, name),
            layout = coalesce($3, layout),
            updated_at = now()
         where id = $1
         returning id, slug, name, layout, created_at, updated_at",
    )
    .bind(id)
    .bind(body.get("name").and_then(|v| v.as_str()))
    .bind(body.get("layout").filter(|v| !v.is_null()))
    .fetch_one(&app.db)
    .await
    .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(axum::Json(row_to_dash(&row)))
}

pub async fn remove(
    State(app): State<App>,
    Path(id): Path<uuid::Uuid>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    sqlx::query("delete from dashboards where id=$1")
        .bind(id)
        .execute(&app.db)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(axum::Json(json!({"ok": true})))
}

#[derive(Deserialize)]
pub struct QueryBody {
    pub metric: String,
    #[serde(default = "default_range")]
    pub range: String,
    #[serde(default)]
    pub services: Vec<String>,
    #[serde(default)]
    pub force: bool,
}
fn default_range() -> String { "30d".into() }

pub async fn query(
    State(app): State<App>,
    axum::Json(body): axum::Json<QueryBody>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let key = format!(
        "metric|{}|{}|{}",
        body.metric,
        body.range,
        body.services.join(",")
    );
    if !body.force {
        if let Some(v) = cache_get(&app, &key) {
            return Ok(axum::Json(v));
        }
    }
    let v = metrics::query_metric(&app.db, &body.metric, &body.range, &body.services)
        .await
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e))?;
    cache_put(&app, key, v.clone());
    Ok(axum::Json(v))
}

// -- custom SQL cards ---------------------------------------------------------

#[derive(Deserialize)]
pub struct SqlQueryBody {
    pub sql: String,
    #[serde(default)]
    pub params: std::collections::HashMap<String, Value>, // custom {{vars}} (string/number)
    #[serde(default = "default_range")]
    pub range: String,
    #[serde(default = "default_freq")]
    pub freq: String,
    #[serde(default)]
    pub services: Vec<String>,
    #[serde(default)]
    pub force: bool,
}
fn default_freq() -> String { "day".into() }

fn valid_var(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn sql_literal(v: &Value) -> String {
    match v {
        Value::Number(n) => n.to_string(),
        Value::Null => "NULL".into(),
        other => format!("'{}'", other.as_str().unwrap_or_default().replace('\'', "''")),
    }
}

/// Render `{{name}}` placeholders: built-ins first, then user params. Unknown
/// vars are left as-is so the error comes from Postgres, pointing at the text.
fn substitute_vars(sql: &str, body: &SqlQueryBody) -> String {
    let w = metrics::parse_window(&body.range);
    let services = if body.services.is_empty() {
        "''".to_string()
    } else {
        body.services
            .iter()
            .map(|s| format!("'{}'", s.replace('\'', "''")))
            .collect::<Vec<_>>()
            .join(",")
    };
    let mut out = sql.to_string();
    let svc_filter = if body.services.is_empty() {
        String::new()
    } else {
        format!(" and service in ({services})")
    };
    let literal_vars: [(&str, String); 4] = [
        ("freq", body.freq.clone()),
        ("range", body.range.clone()),
        ("range_start", w.from.to_rfc3339()),
        ("range_end", w.to.to_rfc3339()),
    ];
    for (name, value) in literal_vars {
        // both styles yield one quoted literal — nothing can double-quote
        let quoted = sql_literal(&json!(value));
        out = out.replace(&format!("'{{{{{name}}}}}'"), &quoted);
        out = out.replace(&format!("{{{{{name}}}}}"), &quoted);
    }
    for (name, frag) in [("services", services), ("services_filter", svc_filter)] {
        // SQL fragments substitute bare
        out = out.replace(&format!("'{{{{{name}}}}}'"), &frag);
        out = out.replace(&format!("{{{{{name}}}}}"), &frag);
    }
    for (name, value) in &body.params {
        if valid_var(name) {
            let lit = sql_literal(value);
            out = out.replace(&format!("'{{{{{name}}}}}'"), &lit);
            out = out.replace(&format!("{{{{{name}}}}}"), &lit);
        }
    }
    out
}

pub async fn query_sql(
    State(app): State<App>,
    axum::Json(body): axum::Json<SqlQueryBody>,
) -> Result<axum::Json<Value>, (axum::http::StatusCode, String)> {
    let sql = body.sql.trim().trim_end_matches(';').to_string();
    // validate without comment lines (-- …) — they're legal SQL but hide the statement
    let no_comments = sql
        .lines()
        .map(|l| match l.find("--") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let lower = no_comments.to_lowercase();
    if !(lower.trim().starts_with("select") || lower.trim().starts_with("with")) {
        return Err((axum::http::StatusCode::BAD_REQUEST, "only SELECT/WITH queries are allowed".into()));
    }
    if no_comments.contains(';') {
        return Err((axum::http::StatusCode::BAD_REQUEST, "a single statement only (no `;`)".into()));
    }
    let rendered = substitute_vars(&sql, &body);
    // row_to_json preserves column order (jsonb would sort keys)
    let wrapped = format!("select row_to_json(q)::text from ({rendered}) as q limit 5000");

    let key = format!(
        "sql|{}|{}|{}|{}|{}",
        body.range,
        body.freq,
        body.services.join(","),
        serde_json::to_string(&body.params).unwrap_or_default(),
        rendered
    );
    if !body.force {
        if let Some(v) = cache_get(&app, &key) {
            return Ok(axum::Json(v));
        }
    }

    let mut tx = app
        .db
        .begin()
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // read-only blocks data-modifying CTEs that a bare SELECT/WITH check admits
    sqlx::query("set local default_transaction_read_only = on")
        .execute(&mut *tx)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    sqlx::query("set local statement_timeout = '15s'")
        .execute(&mut *tx)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let rows = sqlx::query(&wrapped)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e.to_string()))?;
    let _ = tx.rollback().await; // read-only; nothing to commit

    let out: Vec<Value> = rows
        .iter()
        .filter_map(|r| {
            r.try_get::<String, _>(0)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
        })
        .collect();
    let columns: Vec<String> = out
        .first()
        .and_then(|o| o.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let result = json!({ "columns": columns, "rows": out });
    cache_put(&app, key, result.clone());
    Ok(axum::Json(result))
}
