// Metric registry: every dashboard card query lives here, run against the
// LOCAL warehouse only (never source systems). Table names are resolved
// dynamically because PyAirbyte's cache naming can vary by connector version.

use serde_json::{json, Value};
use sqlx::{PgPool, Row};

pub async fn resolve_tables(db: &PgPool) -> sqlx::Result<Vec<(String, String)>> {
    let rows = sqlx::query(
        "select schemaname, relname from pg_stat_user_tables
         where relname not like '\\_airbyte\\_%'
         order by schemaname, relname",
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|r| (r.get(0), r.get(1))).collect())
}

/// Map a logical table (e.g. "incidents") to its quoted "schema"."table" in
/// the warehouse cache. Exact name wins, then suffix/substring match.
pub async fn find_table(db: &PgPool, logical: &str) -> Option<String> {
    let tables = resolve_tables(db).await.ok()?;
    let mut best: Option<(usize, String)> = None;
    for (schema, name) in tables {
        let score = if name == logical {
            0
        } else if name.ends_with(logical) {
            1
        } else if name.contains(logical) {
            2
        } else {
            continue;
        };
        let quoted = format!("\"{}\".\"{}\"", schema.replace('"', ""), name.replace('"', ""));
        if best.as_ref().map(|(s, _)| score < *s).unwrap_or(true) {
            best = Some((score, quoted));
        }
    }
    best.map(|(_, t)| t)
}

#[derive(Clone, Copy)]
pub struct Window {
    pub from: chrono::DateTime<chrono::Utc>,
    pub to: chrono::DateTime<chrono::Utc>,
    pub bucket: &'static str, // SQL date_trunc unit
}

pub fn parse_window(range: &str) -> Window {
    let now = chrono::Utc::now();
    let (from, bucket) = match range {
        "24h" => (now - chrono::Duration::hours(24), "hour"),
        "7d" => (now - chrono::Duration::days(7), "day"),
        "90d" => (now - chrono::Duration::days(90), "day"),
        _ => (now - chrono::Duration::days(30), "day"),
    };
    Window { from, to: now, bucket }
}

fn svc_filter(services: &[String], col: &str) -> String {
    if services.is_empty() {
        return String::new();
    }
    let list: Vec<String> = services
        .iter()
        .map(|s| format!("'{}'", s.replace('\'', "''")))
        .collect();
    format!(" and {} in ({})", col, list.join(","))
}

/// Generic KPI: scalar expr over [from,to] plus the same over the previous
/// window for the delta. Returns { value, prev, delta_pct }.
async fn kpi(
    db: &PgPool,
    table: &str,
    expr: &str,
    ts_col: &str,
    extra: &str,
    w: Window,
    services: &[String],
) -> Value {
    let span = w.to - w.from;
    let prev_from = w.from - span;
    let q = |from: chrono::DateTime<chrono::Utc>, to: chrono::DateTime<chrono::Utc>| {
        format!(
            // ::float8 — count/avg/sum return bigint/numeric which don't decode to f64
            "select coalesce({expr}, 0)::double precision from {table}
             where {ts_col} >= '{}' and {ts_col} < '{}'{}{extra}",
            from.to_rfc3339(),
            to.to_rfc3339(),
            svc_filter(services, "service")
        )
    };
    let cur: f64 = sqlx::query_scalar(&q(w.from, w.to)).fetch_one(db).await.unwrap_or(0.0);
    let prev: f64 = sqlx::query_scalar(&q(prev_from, w.from)).fetch_one(db).await.unwrap_or(0.0);
    let delta = if prev.abs() > 1e-9 { Some(((cur - prev) / prev) * 100.0) } else { None };
    json!({ "value": cur, "prev": prev, "delta_pct": delta })
}

pub async fn query_metric(
    db: &PgPool,
    metric: &str,
    range: &str,
    services: &[String],
) -> Result<Value, String> {
    let w = parse_window(range);
    match metric {
        "kpi_active_incidents" => {
            let Some(t) = find_table(db, "incidents").await else { return Err("incidents table not synced yet".into()) };
            // Open incidents right now, delta vs open at the start of the window.
            let cur: f64 = sqlx::query_scalar(&format!(
                "select count(*)::double precision from {t} where resolved_at is null"
            ))
            .fetch_one(db)
            .await
            .unwrap_or(0.0);
            let prev: f64 = sqlx::query_scalar(&format!(
                "select count(*)::double precision from {t} where opened_at < '{}' and (resolved_at is null or resolved_at >= '{}'){}",
                w.from.to_rfc3339(),
                w.from.to_rfc3339(),
                svc_filter(services, "service")
            ))
            .fetch_one(db)
            .await
            .unwrap_or(0.0);
            let delta = if prev > 0.0 { Some((cur - prev) / prev * 100.0) } else { None };
            Ok(json!({ "value": cur, "prev": prev, "delta_pct": delta }))
        }
        "kpi_mttr" => {
            let Some(t) = find_table(db, "incidents").await else { return Err("incidents table not synced yet".into()) };
            Ok(kpi(db, &t, "avg(mttr_minutes)", "opened_at", " and resolved_at is not null", w, services).await)
        }
        "kpi_deploys" => {
            let Some(t) = find_table(db, "deployments").await else { return Err("deployments table not synced yet".into()) };
            Ok(kpi(db, &t, "count(*)", "started_at", "", w, services).await)
        }
        "kpi_error_rate" => {
            let Some(t) = find_table(db, "metric_samples").await else { return Err("metrics not synced yet".into()) };
            Ok(kpi(db, &t, "avg(value)", "ts", " and metric = 'error_rate'", w, services).await)
        }
        "kpi_p95_latency" => {
            let Some(t) = find_table(db, "metric_samples").await else { return Err("metrics not synced yet".into()) };
            Ok(kpi(db, &t, "percentile_cont(0.95) within group (order by value)", "ts", " and metric = 'p95_latency_ms'", w, services).await)
        }
        "kpi_firing_alerts" => {
            let Some(t) = find_table(db, "alerts").await else { return Err("alerts table not synced yet".into()) };
            let cur: f64 = sqlx::query_scalar(&format!(
                "select count(*)::double precision from {t} where resolved_at is null"
            ))
            .fetch_one(db).await.unwrap_or(0.0);
            Ok(json!({ "value": cur, "delta_pct": Value::Null }))
        }
        "hero_requests" => {
            let Some(t) = find_table(db, "metric_samples").await else { return Err("metrics not synced yet".into()) };
            // rps sampled hourly → requests ≈ sum(rps) * 3600
            let v: f64 = sqlx::query_scalar(&format!(
                "select (coalesce(sum(value), 0) * 3600)::double precision from {t}
                 where metric = 'rps' and ts >= '{}' and ts < '{}'{}",
                w.from.to_rfc3339(),
                w.to.to_rfc3339(),
                svc_filter(services, "service")
            ))
            .fetch_one(db)
            .await
            .unwrap_or(0.0);
            Ok(json!({ "value": v }))
        }
        "incidents_by_service" => {
            let Some(t) = find_table(db, "incidents").await else { return Err("incidents table not synced yet".into()) };
            let rows = sqlx::query(&format!(
                "select service, count(*) as n from {t}
                 where opened_at >= '{}' and opened_at < '{}'{}
                 group by service order by n asc limit 14",
                w.from.to_rfc3339(),
                w.to.to_rfc3339(),
                svc_filter(services, "service")
            ))
            .fetch_all(db)
            .await
            .map_err(|e| e.to_string())?;
            let items: Vec<Value> = rows
                .iter()
                .map(|r| json!({ "label": r.get::<String, _>(0), "value": r.get::<i64, _>(1) }))
                .collect();
            Ok(json!({ "items": items }))
        }
        "deploys_per_day" => {
            let Some(t) = find_table(db, "deployments").await else { return Err("deployments table not synced yet".into()) };
            let rows = sqlx::query(&format!(
                "select date_trunc('{}', started_at)::timestamptz as b, count(*) as n from {t}
                 where started_at >= '{}' and started_at < '{}'{}
                 group by b order by b",
                w.bucket, w.from.to_rfc3339(), w.to.to_rfc3339(), svc_filter(services, "service")
            ))
            .fetch_all(db)
            .await
            .map_err(|e| e.to_string())?;
            let items: Vec<Value> = rows
                .iter()
                .map(|r| json!({ "label": r.get::<chrono::DateTime<chrono::Utc>, _>(0).format("%m-%d").to_string(), "value": r.get::<i64, _>(1) }))
                .collect();
            Ok(json!({ "items": items }))
        }
        "latency_by_service" => {
            let Some(t) = find_table(db, "metric_samples").await else { return Err("metrics not synced yet".into()) };
            let rows = sqlx::query(&format!(
                "select service, date_trunc('{}', ts)::timestamptz as b,
                        percentile_cont(0.95) within group (order by value) as p95
                 from {t}
                 where metric = 'p95_latency_ms' and ts >= '{}' and ts < '{}'{}
                 group by service, b order by b",
                w.bucket, w.from.to_rfc3339(), w.to.to_rfc3339(), svc_filter(services, "service")
            ))
            .fetch_all(db)
            .await
            .map_err(|e| e.to_string())?;
            Ok(pivot_series(rows))
        }
        "db_replica_lag" => {
            let Some(t) = find_table(db, "db_health").await else { return Err("db_health table not synced yet".into()) };
            let rows = sqlx::query(&format!(
                "select database, date_trunc('{}', ts)::timestamptz as b, avg(replica_lag_ms)::double precision as v
                 from {t} where ts >= '{}' and ts < '{}'
                 group by database, b order by b",
                w.bucket, w.from.to_rfc3339(), w.to.to_rfc3339()
            ))
            .fetch_all(db)
            .await
            .map_err(|e| e.to_string())?;
            Ok(pivot_series(rows))
        }
        "recent_incidents" => {
            let Some(t) = find_table(db, "incidents").await else { return Err("incidents table not synced yet".into()) };
            let rows = sqlx::query(&format!(
                "select id, service, severity, title, opened_at::timestamptz, coalesce(mttr_minutes, 0)::double precision, status
                 from {t} where 1=1{} order by opened_at desc limit 10",
                svc_filter(services, "service")
            ))
            .fetch_all(db)
            .await
            .map_err(|e| e.to_string())?;
            let items: Vec<Value> = rows
                .iter()
                .map(|r| {
                    json!({
                        "id": r.get::<String, _>(0),
                        "service": r.get::<String, _>(1),
                        "severity": r.get::<String, _>(2),
                        "title": r.get::<String, _>(3),
                        "opened_at": r.get::<chrono::DateTime<chrono::Utc>, _>(4),
                        "mttr_minutes": r.get::<f64, _>(5),
                        "status": r.get::<String, _>(6),
                    })
                })
                .collect();
            Ok(json!({ "columns": [
                {"key":"id","label":"ID"},{"key":"service","label":"Service"},
                {"key":"severity","label":"Sev"},{"key":"title","label":"Title"},
                {"key":"opened_at","label":"Opened"},{"key":"mttr_minutes","label":"MTTR (min)"},
                {"key":"status","label":"Status"}
            ], "rows": items }))
        }
        "insight_main" => insight_main(db, services).await,
        _ => Err(format!("unknown metric: {metric}")),
    }
}

fn pivot_series(rows: Vec<sqlx::postgres::PgRow>) -> Value {
    // rows: (name, ts, value) → { series: [{name, points:[{label, value}]}] }
    let mut order: Vec<String> = vec![];
    let mut buckets: Vec<String> = vec![];
    let mut map: std::collections::BTreeMap<(String, String), f64> = Default::default();
    for r in &rows {
        let name: String = r.get(0);
        let b: chrono::DateTime<chrono::Utc> = r.get(1);
        let v: f64 = r.get::<Option<f64>, _>(2).unwrap_or(0.0);
        let bl = b.format("%m-%d %H:%M").to_string();
        if !order.contains(&name) {
            order.push(name.clone());
        }
        if !buckets.contains(&bl) {
            buckets.push(bl.clone());
        }
        map.insert((name, bl), v);
    }
    let series: Vec<Value> = order
        .iter()
        .map(|name| {
            let points: Vec<Value> = buckets
                .iter()
                .map(|b| json!({ "label": b, "value": map.get(&(name.clone(), b.clone())).copied().unwrap_or(0.0) }))
                .collect();
            json!({ "name": name, "points": points })
        })
        .collect();
    json!({ "series": series })
}

/// Deterministic AI insight: top incident driver + latency trend, composed from
/// real warehouse aggregates. Replaced by LLM generation when chat is wired.
async fn insight_main(db: &PgPool, services: &[String]) -> Result<Value, String> {
    let Some(t) = find_table(db, "incidents").await else { return Err("incidents table not synced yet".into()) };
    let now = chrono::Utc::now();
    let from = now - chrono::Duration::days(7);
    let top: Option<(String, i64, i64)> = sqlx::query_as(
        &format!(
            "select service, count(*) as n,
                    count(*) filter (where severity in ('sev1','SEV1','critical')) as sev1
             from {t}
             where opened_at >= '{}' and opened_at < '{}'{}
             group by service order by n desc limit 1",
            from.to_rfc3339(),
            now.to_rfc3339(),
            svc_filter(services, "service")
        ),
    )
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;

    let Some((svc, n, sev1)) = top else {
        return Ok(json!({ "text": "Not enough synced data for insights yet. Run a sync from the Data page.", "basis": "incidents (7d)" }));
    };
    Ok(json!({
        "text": format!(
            "{svc} is the noisiest service this week with {n} incidents, including {sev1} sev1/critical pages. Consider a reliability review of its latest deploys and alert rules before it drives MTTR up further."
        ),
        "basis": "incidents (7d)"
    }))
}
