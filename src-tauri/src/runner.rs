// Bridge to the Python runner (PyAirbyte + context indexer) in `runner/`.
// All heavy connector work happens there in real Airbyte connector processes;
// this module just spawns them and parses the final JSON line from stdout.
// Progress/errors go to stderr and are surfaced as log tails.

use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

pub fn project_root() -> PathBuf {
    // src-tauri's parent is the project root, baked in at compile time.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn venv_python() -> PathBuf {
    // Env override lets CI/dev point elsewhere; default is the uv venv in runner/.
    std::env::var_os("RUNNER_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|| project_root().join("runner/.venv/bin/python"))
}

async fn run_python(script: &str, args: &[String], _timeout: Duration) -> Result<Value, String> {
    let py = venv_python();
    if !py.exists() {
        return Err(format!(
            "runner venv missing at {} — create it with: uv venv runner/.venv && uv pip install --python runner/.venv/bin/python airbyte 'psycopg[binary]'",
            py.display()
        ));
    }
    let script_path = project_root().join("runner").join(script);
    let output = tokio::process::Command::new(py)
        .arg(script_path)
        .args(args)
        .current_dir(project_root())
        .env("DATABASE_URL", crate::database_url())
        .output()
        .await
        .map_err(|e| format!("failed to spawn runner: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    // The runner prints exactly one JSON object as the last stdout line.
    let parsed = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .and_then(|l| serde_json::from_str::<Value>(l).ok());

    if !output.status.success() {
        let tail: String = stderr
            .lines()
            .rev()
            .take(15)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return match parsed {
            Some(v) if v.get("status").and_then(|s| s.as_str()) == Some("ok") => Ok(v),
            Some(v) => Err(v
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("connector run failed")
                .to_string()),
            None => Err(if tail.is_empty() { stdout.to_string() } else { tail }),
        };
    }
    parsed.ok_or_else(|| format!("runner produced no JSON output.\nstderr tail:\n{stderr}"))
}

/// Execute a real Airbyte connector read into the warehouse via PyAirbyte.
pub async fn ingest(connector: &str, config: &Value) -> Result<Value, String> {
    let args = vec![
        connector.to_string(),
        serde_json::to_string(config).unwrap(),
        "--cache-url".into(),
        crate::database_url(),
    ];
    run_python("ingest.py", &args, Duration::from_secs(30 * 60)).await
}

/// JSON schema of a connector's config spec (drives the credential form UI).
pub async fn connector_spec(connector: &str) -> Result<Value, String> {
    run_python("spec.py", &[connector.to_string()], Duration::from_secs(10 * 60)).await
}

/// (Re)build the context store from warehouse contents.
pub async fn index_context() -> Result<Value, String> {
    run_python("context.py", &[], Duration::from_secs(15 * 60)).await
}
