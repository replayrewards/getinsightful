// AI Chat: BYO provider over the Anthropic Messages protocol (works for
// Anthropic directly and for Z.ai GLM's Anthropic-compatible endpoint).
// Streaming SSE end-to-end, with a tool loop over warehouse-only tools.

use crate::{api_context, metrics, App};
use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::convert::Infallible;
use tokio_stream::wrappers::ReceiverStream;

const DEFAULTS: &[(&str, &str, &str)] = &[
    // provider, base_url, default model
    ("glm", "https://api.z.ai/api/anthropic", "glm-4.6"),
    ("anthropic", "https://api.anthropic.com", "claude-sonnet-4-5"),
];

async fn load_provider(app: &App) -> Value {
    let v: Option<Value> =
        sqlx::query_scalar("select value from settings where key='ai_provider'")
            .fetch_optional(&app.db)
            .await
            .ok()
            .flatten();
    v.unwrap_or_else(|| json!({ "provider": "glm" }))
}

fn resolve_endpoint(cfg: &Value) -> (String, String, bool) {
    // (base_url, model, bearer_auth)
    let provider = cfg.get("provider").and_then(|v| v.as_str()).unwrap_or("glm");
    let default = DEFAULTS
        .iter()
        .find(|(p, _, _)| *p == provider)
        .map(|(_, b, m)| (b.to_string(), m.to_string()))
        .unwrap_or_else(|| (DEFAULTS[0].1.into(), DEFAULTS[0].2.into()));
    let base = cfg
        .get("base_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(&default.0)
        .to_string();
    let model = cfg
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(&default.1)
        .to_string();
    let bearer = cfg
        .get("auth_mode")
        .and_then(|v| v.as_str())
        .map(|m| m == "bearer")
        .unwrap_or(provider == "glm");
    (base, model, bearer)
}

pub async fn get_config(State(app): State<App>) -> axum::Json<Value> {
    let cfg = load_provider(&app).await;
    let key = cfg.get("api_key").and_then(|v| v.as_str()).unwrap_or("");
    axum::Json(json!({
        "provider": cfg.get("provider").cloned().unwrap_or(json!("glm")),
        "base_url": cfg.get("base_url").cloned().unwrap_or(Value::Null),
        "model": cfg.get("model").cloned().unwrap_or(Value::Null),
        "has_key": !key.is_empty(),
        "key_hint": if key.len() > 6 { format!("…{}", &key[key.len()-4..]) } else { String::new() },
    }))
}

#[derive(Deserialize)]
pub struct ConfigBody {
    provider: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    api_key: String,
}

pub async fn set_config(
    State(app): State<App>,
    axum::Json(body): axum::Json<ConfigBody>,
) -> axum::Json<Value> {
    let mut merged = load_provider(&app).await;
    if let Some(o) = merged.as_object_mut() {
        o.insert("provider".into(), json!(body.provider));
        if !body.base_url.is_empty() {
            o.insert("base_url".into(), json!(body.base_url));
        }
        if !body.model.is_empty() {
            o.insert("model".into(), json!(body.model));
        }
        if !body.api_key.is_empty() {
            o.insert("api_key".into(), json!(body.api_key));
        }
    }
    let _ = sqlx::query(
        "insert into settings (key, value) values ('ai_provider', $1)
         on conflict (key) do update set value = $1",
    )
    .bind(&merged)
    .execute(&app.db)
    .await;
    axum::Json(json!({"ok": true}))
}

// -- chat session persistence + continuous learning ----------------------------

fn first_user_text(messages: &[Value]) -> String {
    messages
        .iter()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string()
}

/// Upsert the session and replace its messages (client sends full history each
/// turn, so it stays the source of truth; the DB just makes history durable).
/// Returns the session id — a new one when the client's id was missing/stale.
async fn persist_session(app: &App, session_id: Option<&str>, messages: &[Value]) -> Option<String> {
    let mut sid = String::new();
    if let Some(id) = session_id {
        let exists: Option<i32> = sqlx::query_scalar(
            "update chat_sessions set updated_at = now() where id = $1::uuid returning 1",
        )
        .bind(id)
        .fetch_optional(&app.db)
        .await
        .unwrap_or(None);
        if exists.is_some() {
            sid = id.to_string();
        }
    }
    if sid.is_empty() {
        let title = first_user_text(messages);
        sid = sqlx::query_scalar::<_, String>(
            "insert into chat_sessions (title) values ($1) returning id::text",
        )
        .bind(if title.is_empty() { "New chat".to_string() } else { truncate(&title, 60) })
        .fetch_one(&app.db)
        .await
        .ok()?;
    }
    let mut tx = app.db.begin().await.ok()?;
    let _ = sqlx::query("delete from chat_messages where session_id = $1::uuid")
        .bind(&sid)
        .execute(&mut *tx)
        .await;
    for (i, m) in messages.iter().enumerate() {
        let Some(role) = m.get("role").and_then(|r| r.as_str()) else { continue };
        if role != "user" && role != "assistant" {
            continue;
        }
        let content = m.get("content").cloned().unwrap_or(json!(""));
        let _ = sqlx::query(
            "insert into chat_messages (session_id, seq, role, content) values ($1::uuid, $2, $3, $4)",
        )
        .bind(&sid)
        .bind(i as i32)
        .bind(role)
        .bind(content)
        .execute(&mut *tx)
        .await;
    }
    tx.commit().await.ok()?;
    Some(sid)
}

pub async fn sessions_list(State(app): State<App>) -> axum::Json<Value> {
    let rows = sqlx::query(
        "select s.id::text, s.title, s.updated_at,
                (select count(*) from chat_messages m where m.session_id = s.id) as n
         from chat_sessions s order by s.updated_at desc limit 50",
    )
    .fetch_all(&app.db)
    .await
    .unwrap_or_default();
    let sessions: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String, _>(0),
                "title": r.get::<String, _>(1),
                "updated_at": r.get::<chrono::DateTime<chrono::Utc>, _>(2),
                "messages": r.get::<i64, _>(3),
            })
        })
        .collect();
    axum::Json(json!({ "sessions": sessions }))
}

pub async fn session_get(
    State(app): State<App>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::Json<Value> {
    let rows = sqlx::query(
        "select role, content from chat_messages where session_id = $1::uuid order by seq",
    )
    .bind(&id)
    .fetch_all(&app.db)
    .await
    .unwrap_or_default();
    let messages: Vec<Value> = rows
        .iter()
        .map(|r| json!({ "role": r.get::<String, _>(0), "content": r.get::<Value, _>(1) }))
        .collect();
    axum::Json(json!({ "id": id, "messages": messages }))
}

const LEARNING_PROMPT: &str = "You extract durable knowledge from a data-assistant exchange. \
Return ONLY a JSON array (max 3 items) of objects {\"kind\": ..., \"text\": ...}. \
kinds: \"fact\" (stable truth about the business or its data), \"preference\" (how the user wants answers), \
\"procedure\" (how to accomplish something), \"learning\" (a stored answer to a prior question worth reusing). \
Exclude ephemeral numbers, SQL text, and small talk. Return [] when nothing durable.";

/// The Hyperspell-style continuous-learning loop: after a chat exchange, ask
/// the same provider to distill durable memories, stored pending approval.
/// Best-effort — failures are silently dropped, never surfaced to the chat.
async fn learn_from_exchange(app: App, question: String, answer: String, session_id: String) {
    if question.trim().is_empty() || answer.trim().is_empty() {
        return;
    }
    let cfg = load_provider(&app).await;
    let key = cfg.get("api_key").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if key.is_empty() {
        return;
    }
    let (base, model, bearer) = resolve_endpoint(&cfg);
    let payload = json!({
        "model": model,
        "max_tokens": 512,
        "system": LEARNING_PROMPT,
        "messages": [{
            "role": "user",
            "content": format!("Question:\n{question}\n\nAnswer:\n{}", truncate(&answer, 4000))
        }],
    });
    let mut req = app
        .http
        .post(format!("{base}/v1/messages"))
        .header("anthropic-version", "2023-06-01")
        .json(&payload);
    req = if bearer {
        req.header("Authorization", format!("Bearer {key}"))
    } else {
        req.header("x-api-key", &key)
    };
    let Ok(resp) = req.send().await else { return };
    if !resp.status().is_success() {
        return;
    }
    let Ok(text) = resp.text().await else { return };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return };
    let out = v
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|a| a.iter().find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text")))
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    // lenient JSON extraction: the model may wrap the array in prose or fences
    let (Some(start), Some(end)) = (out.find('['), out.rfind(']')) else { return };
    let Ok(items) = serde_json::from_str::<Vec<Value>>(&out[start..=end]) else { return };
    for item in items.into_iter().take(3) {
        let kind = match item.get("kind").and_then(|k| k.as_str()).unwrap_or("") {
            "fact" => "fact",
            "preference" => "preference",
            "procedure" => "procedure",
            _ => "learning",
        };
        let Some(text) = item.get("text").and_then(|t| t.as_str()).map(str::trim) else { continue };
        if text.len() < 8 {
            continue;
        }
        let prov = json!({ "session_id": session_id, "question": truncate(&question, 200) });
        let _ = sqlx::query(
            "insert into memories (kind, text, status, source, provenance)
             values ($1, $2, 'pending', 'chat', $3)
             on conflict (lower(md5(text))) do nothing",
        )
        .bind(kind)
        .bind(text)
        .bind(prov)
        .execute(&app.db)
        .await;
    }
}

// -- warehouse tools (shared with the MCP surface in api_context) -------------

pub async fn execute_tool(app: &App, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "run_sql" => {
            let sql = args
                .get("sql")
                .and_then(|v| v.as_str())
                .ok_or("missing sql")?
                .trim()
                .trim_end_matches(';')
                .to_string();
            // check against comment-stripped SQL — a leading `--` line is legal and common
            let no_comments = sql
                .lines()
                .map(|l| match l.find("--") {
                    Some(i) => &l[..i],
                    None => l,
                })
                .collect::<Vec<_>>()
                .join("\n");
            let lower = no_comments.to_lowercase();
            if !(lower.trim().starts_with("select") || lower.trim().starts_with("with"))
                || no_comments.contains(';')
            {
                return Err("only a single SELECT/WITH statement is allowed".into());
            }
            // to_jsonb(row) sidesteps per-type decoding — every row arrives as JSON text
            let wrapped = format!("select to_jsonb(q)::text from ({sql}) as q limit 200");
            // read-only tx: WITH can carry data-modifying CTEs past the check above
            let mut tx = app.db.begin().await.map_err(|e| e.to_string())?;
            sqlx::query("set local default_transaction_read_only = on")
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            let rows = sqlx::query(&wrapped)
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            let _ = tx.rollback().await;
            let out: Vec<Value> = rows
                .iter()
                .filter_map(|r| {
                    r.try_get::<String, _>(0)
                        .ok()
                        .and_then(|s| serde_json::from_str(&s).ok())
                })
                .collect();
            Ok(json!({ "rows": out, "row_count": out.len() }))
        }
        "context_search" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(10).clamp(1, 50);
            let entities = api_context::search_entities(&app, q, limit).await.map_err(|e| e.to_string())?;
            let memories = api_context::search_memories(&app, q, limit, Some(&["pending", "approved"])).await?;
            Ok(json!({
                "entities": entities["entities"],
                "memories": memories["memories"],
            }))
        }
        "list_tables" => {
            let tables = metrics::resolve_tables(&app.db).await.map_err(|e| e.to_string())?;
            Ok(json!({ "tables": tables.into_iter().map(|(s, t)| format!("{s}.{t}")).collect::<Vec<_>>() }))
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

pub fn tools_json() -> Value {
    json!([
        {
            "name": "run_sql",
            "description": "Run a read-only SELECT/WITH query against the local analytics warehouse (Postgres). Use for counts, aggregates, trends. Results cap at 200 rows. Call list_tables or inspect the system prompt schema first if unsure of table names.",
            "input_schema": {
                "type": "object",
                "properties": { "sql": { "type": "string", "description": "A single SELECT statement." } },
                "required": ["sql"]
            }
        },
        {
            "name": "context_search",
            "description": "Search the pre-indexed business context store. Returns entities (table/service summaries, key objects) and memories — durable facts, procedures, preferences, and learnings extracted from past questions. Approved memories are authoritative prior answers; prefer them before re-running SQL.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "default": 10 }
                },
                "required": ["query"]
            }
        },
        {
            "name": "list_tables",
            "description": "List tables available in the warehouse.",
            "input_schema": { "type": "object", "properties": {} }
        }
    ])
}

async fn schema_prompt(app: &App) -> String {
    let rows = sqlx::query(
        "select table_name, column_name, data_type from information_schema.columns
         where table_schema='public' and table_name not like '\\_airbyte\\_%'
         order by table_name, ordinal_position limit 900",
    )
    .fetch_all(&app.db)
    .await
    .unwrap_or_default();
    let mut cur = String::new();
    let mut cols: Vec<String> = vec![];
    let mut out = String::new();
    for r in &rows {
        let t: String = r.get(0);
        if t != cur {
            if !cur.is_empty() {
                out.push_str(&format!("- {cur}({})\n", cols.join(", ")));
            }
            cur = t;
            cols.clear();
        }
        cols.push(format!("{} {}", r.get::<String, _>(1), r.get::<String, _>(2)));
    }
    if !cur.is_empty() {
        out.push_str(&format!("- {cur}({})\n", cols.join(", ")));
    }
    format!(
        "You are the GetInsightful data assistant for this enterprise workspace. Today is {today} UTC.\n\
         The local warehouse (schema public) holds data landed by Airbyte connectors:\n{out}\n\
         Answer data questions by querying run_sql (read-only). For business background, prefer context_search first — it also returns memories: durable facts and learnings from past questions, and approved ones are authoritative prior answers you can rely on without re-deriving them. Keep answers compact and quantitative; show the SQL you ran.",
        today = chrono::Utc::now().format("%Y-%m-%d")
    )
}

#[derive(Deserialize)]
pub struct ChatBody {
    pub messages: Vec<Value>, // [{role: "user"|"assistant", content: string}]
    #[serde(default)]
    pub session_id: Option<String>,
}

pub async fn chat(
    State(app): State<App>,
    axum::Json(body): axum::Json<ChatBody>,
) -> axum::response::Response {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(64);
    let app2 = app.clone();
    let session_in = body.session_id.clone();
    let question = body
        .messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    tokio::spawn(async move {
        let send = |v: Value| {
            let tx = tx.clone();
            async move { let _ = tx.send(Ok(Event::default().data(v.to_string()))).await; }
        };
        // persist history (durable across restarts) and tell the client its id
        let session_id = persist_session(&app2, session_in.as_deref(), &body.messages).await;
        if let Some(id) = &session_id {
            send(json!({"type":"session","id": id})).await;
        }
        let cfg = load_provider(&app2).await;
        let key = cfg.get("api_key").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if key.is_empty() {
            send(json!({"type":"error","error":"No AI provider key configured. Set one in AI Chat → settings."})).await;
            return;
        }
        let (base, model, bearer) = resolve_endpoint(&cfg);
        let system = schema_prompt(&app2).await;
        let mut messages = body.messages.clone();
        // last round's accumulated blocks (kind, tool_use_id, name, text/json)
        let mut blocks: std::collections::BTreeMap<u64, (String, String, String, String)> =
            Default::default();

        for _round in 0..12 {
            let payload = json!({
                "model": model,
                "max_tokens": 4096,
                "stream": true,
                "system": system,
                "tools": tools_json(),
                "messages": messages,
            });
            let mut req = app2
                .http
                .post(format!("{base}/v1/messages"))
                .header("anthropic-version", "2023-06-01")
                .json(&payload);
            req = if bearer {
                req.header("Authorization", format!("Bearer {key}"))
            } else {
                req.header("x-api-key", &key)
            };
            let resp = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    send(json!({"type":"error","error": format!("provider unreachable: {e}")})).await;
                    return;
                }
            };
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                send(json!({"type":"error","error": format!("provider {status}: {}", truncate(&text, 500))})).await;
                return;
            }

            // Accumulate content blocks while forwarding text deltas.
            blocks = Default::default();
            let mut stop_reason = String::new();
            let mut buf = String::new();
            let mut resp = resp;
            loop {
                let chunk = match resp.chunk().await {
                    Ok(Some(c)) => c,
                    Ok(None) => break,
                    Err(e) => {
                        send(json!({"type":"error","error": format!("stream error: {e}")})).await;
                        return;
                    }
                };
                buf.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(pos) = buf.find('\n') {
                    let line: String = buf.drain(..=pos).collect();
                    let line = line.trim_end();
                    let Some(data) = line.strip_prefix("data:") else { continue };
                    let Ok(ev) = serde_json::from_str::<Value>(data.trim()) else { continue };
                    match ev.get("type").and_then(|t| t.as_str()) {
                        Some("content_block_start") => {
                            let idx = ev.pointer("/index").and_then(|v| v.as_u64()).unwrap_or(0);
                            let cb = ev.pointer("/content_block").cloned().unwrap_or(json!({}));
                            if cb.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                blocks.insert(idx, (
                                    "tool_use".into(),
                                    cb.get("id").and_then(|v| v.as_str()).unwrap_or("").into(),
                                    cb.get("name").and_then(|v| v.as_str()).unwrap_or("").into(),
                                    String::new(),
                                ));
                            } else {
                                blocks.entry(idx).or_insert_with(|| ("text".into(), String::new(), String::new(), String::new()));
                            }
                        }
                        Some("content_block_delta") => {
                            let idx = ev.pointer("/index").and_then(|v| v.as_u64()).unwrap_or(0);
                            match ev.pointer("/delta/type").and_then(|t| t.as_str()) {
                                Some("text_delta") => {
                                    let t = ev.pointer("/delta/text").and_then(|t| t.as_str()).unwrap_or("");
                                    let e = blocks.entry(idx).or_insert_with(|| ("text".into(), String::new(), String::new(), String::new()));
                                    e.3.push_str(t);
                                    send(json!({"type":"text","text": t})).await;
                                }
                                Some("input_json_delta") => {
                                    let p = ev.pointer("/delta/partial_json").and_then(|t| t.as_str()).unwrap_or("");
                                    blocks.entry(idx).or_insert_with(|| ("tool_use".into(), String::new(), String::new(), String::new())).3.push_str(p);
                                }
                                _ => {}
                            }
                        }
                        Some("message_delta") => {
                            if let Some(s) = ev.pointer("/delta/stop_reason").and_then(|t| t.as_str()) {
                                stop_reason = s.to_string();
                            }
                        }
                        Some("error") => {
                            let msg = ev.pointer("/error/message").and_then(|t| t.as_str()).unwrap_or("provider error");
                            send(json!({"type":"error","error": msg})).await;
                            return;
                        }
                        _ => {}
                    }
                }
            }

            if stop_reason != "tool_use" || blocks.is_empty() {
                break;
            }

            // Execute tool calls, feed results back, loop for another round.
            let mut assistant_content: Vec<Value> = vec![];
            let mut tool_results: Vec<Value> = vec![];
            for (_, (kind, id, name, acc)) in blocks.iter() {
                if kind != "tool_use" {
                    continue;
                }
                let input: Value = serde_json::from_str(acc).unwrap_or(json!({}));
                assistant_content.push(json!({"type":"tool_use","id": id, "name": name, "input": input}));
                send(json!({"type":"tool","name": name})).await;
                let result = match execute_tool(&app2, name, &input).await {
                    Ok(v) => v.to_string(),
                    Err(e) => format!("{{\"error\":\"{}\"}}", e.replace('"', "'")),
                };
                tool_results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": truncate(&result, 20000),
                }));
            }
            let text_parts: Vec<Value> = blocks
                .values()
                .filter(|(k, ..)| k == "text")
                .map(|(_, _, _, t)| json!({"type":"text","text": t}))
                .collect();
            if !text_parts.is_empty() {
                assistant_content.splice(..0, text_parts);
            }
            messages.push(json!({"role":"assistant","content": assistant_content}));
            messages.push(json!({"role":"user","content": tool_results}));
        }
        // Answer complete (or out of rounds — stop gracefully rather than
        // erroring; whatever text accumulated stands). Persist the assistant
        // reply so a restart mid-conversation still shows it, then continuous
        // learning: distill the exchange into pending memories. (The client
        // re-sends full history next turn, which replaces these rows anyway.)
        send(json!({"type":"done"})).await;
        let final_text: String = blocks
            .values()
            .filter(|(k, ..)| k == "text")
            .map(|(.., t)| t.clone())
            .collect::<Vec<_>>()
            .join("\n");
        if !final_text.is_empty() {
            if let Some(sid) = &session_id {
                let _ = sqlx::query(
                    "insert into chat_messages (session_id, seq, role, content)
                     select $1::uuid, coalesce(max(seq), -1) + 1, 'assistant', to_jsonb($2)
                     from chat_messages where session_id = $1::uuid",
                )
                .bind(sid)
                .bind(&final_text)
                .execute(&app2.db)
                .await;
            }
        }
        let app3 = app2.clone();
        let q = question.clone();
        let sid = session_id.clone().unwrap_or_default();
        tokio::spawn(learn_from_exchange(app3, q, final_text, sid));
    });
    use axum::response::IntoResponse;
    Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::default()).into_response()
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        let mut cut = n;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}…", &s[..cut])
    }
}
