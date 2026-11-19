//! Bridge to the local Ollama server.
//!
//! All model traffic goes through here. The web view itself is not allowed to
//! make network requests (see the CSP in tauri.conf.json), and this module
//! refuses any address that is not on this computer.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::{ipc::Channel, State};
use tokio::sync::Notify;

const DEFAULT_BASE: &str = "http://127.0.0.1:11434";
const GET_PATHS: &[&str] = &["/api/tags", "/api/ps", "/api/version"];
const POST_PATHS: &[&str] = &["/api/show", "/api/generate"];
const STREAM_PATHS: &[&str] = &["/api/chat", "/api/pull"];

pub struct OllamaState {
    client: reqwest::Client,
    base: Mutex<String>,
    cancels: Mutex<HashMap<String, Arc<Notify>>>,
}

impl OllamaState {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            // Never route through a system proxy: traffic must stay on this machine.
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .build()
            .expect("failed to build HTTP client");
        Self {
            client,
            base: Mutex::new(DEFAULT_BASE.to_string()),
            cancels: Mutex::new(HashMap::new()),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base.lock().unwrap(), path)
    }
}

/// Accepts "127.0.0.1:11434", "http://localhost:11434", "[::1]:8080", "localhost" ...
/// and rejects anything that is not this computer.
pub fn normalize_local(input: &str) -> Result<String, String> {
    let mut s = input.trim().trim_end_matches('/').to_string();
    if let Some(rest) = s.strip_prefix("http://") {
        s = rest.to_string();
    }
    if s.is_empty() || s.contains("://") || s.contains('/') {
        return Err("Use host:port only, for example 127.0.0.1:11434".into());
    }
    let (host, port): (String, u16) = if s.starts_with('[') {
        let end = s.find(']').ok_or("Invalid address")?;
        let rest = &s[end + 1..];
        let port = if rest.is_empty() {
            11434
        } else {
            rest.strip_prefix(':')
                .ok_or("Invalid address")?
                .parse::<u16>()
                .map_err(|_| "Invalid port")?
        };
        (s[..=end].to_string(), port)
    } else {
        match s.split_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| "Invalid port")?),
            None => (s.clone(), 11434),
        }
    };
    let host = host.to_ascii_lowercase();
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]") {
        return Err(
            "For privacy, Hush only connects to Ollama on this computer (127.0.0.1, localhost or [::1])."
                .into(),
        );
    }
    Ok(format!("http://{host}:{port}"))
}

fn net_err(e: reqwest::Error) -> String {
    if e.is_connect() {
        "Can't reach Ollama. Start the Ollama app (or run `ollama serve`) and try again.".into()
    } else if e.is_timeout() {
        "Ollama took too long to answer.".into()
    } else {
        format!("Connection error: {e}")
    }
}

fn ollama_error(status: reqwest::StatusCode, text: &str) -> String {
    let msg = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
        .unwrap_or_else(|| text.trim().to_string());
    format!("Ollama error ({}): {}", status.as_u16(), msg)
}

async fn into_json(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let text = resp.text().await.map_err(net_err)?;
    if !status.is_success() {
        return Err(ollama_error(status, &text));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("Unexpected reply from Ollama: {e}"))
}

#[tauri::command]
pub fn ollama_get_url(state: State<'_, OllamaState>) -> String {
    state.base.lock().unwrap().clone()
}

#[tauri::command]
pub fn ollama_set_url(state: State<'_, OllamaState>, url: String) -> Result<String, String> {
    let normalized = normalize_local(&url)?;
    *state.base.lock().unwrap() = normalized.clone();
    Ok(normalized)
}

#[tauri::command]
pub async fn ollama_get(state: State<'_, OllamaState>, path: String) -> Result<Value, String> {
    if !GET_PATHS.contains(&path.as_str()) {
        return Err(format!("Not allowed: {path}"));
    }
    let resp = state
        .client
        .get(state.url(&path))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(net_err)?;
    into_json(resp).await
}

#[tauri::command]
pub async fn ollama_post(
    state: State<'_, OllamaState>,
    path: String,
    mut body: Value,
) -> Result<Value, String> {
    if !POST_PATHS.contains(&path.as_str()) {
        return Err(format!("Not allowed: {path}"));
    }
    if let Some(obj) = body.as_object_mut() {
        obj.insert("stream".into(), Value::Bool(false));
    }
    let resp = state
        .client
        .post(state.url(&path))
        .json(&body)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(net_err)?;
    into_json(resp).await
}

#[tauri::command]
pub async fn ollama_delete_model(
    state: State<'_, OllamaState>,
    model: String,
) -> Result<(), String> {
    let resp = state
        .client
        .delete(state.url("/api/delete"))
        .json(&json!({ "model": model }))
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(net_err)?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Err(ollama_error(status, &text))
    }
}

/// Streams NDJSON from /api/chat or /api/pull to the UI, one JSON object per message.
#[tauri::command]
pub async fn ollama_stream(
    state: State<'_, OllamaState>,
    request_id: String,
    path: String,
    body: Value,
    on_event: Channel<Value>,
) -> Result<(), String> {
    if !STREAM_PATHS.contains(&path.as_str()) {
        return Err(format!("Not allowed: {path}"));
    }
    let cancel = Arc::new(Notify::new());
    state
        .cancels
        .lock()
        .unwrap()
        .insert(request_id.clone(), cancel.clone());
    let result = run_stream(state.inner(), &path, body, &on_event, &cancel).await;
    state.cancels.lock().unwrap().remove(&request_id);
    result
}

#[tauri::command]
pub fn ollama_cancel(state: State<'_, OllamaState>, request_id: String) {
    if let Some(n) = state.cancels.lock().unwrap().get(&request_id) {
        // notify_one stores a permit, so a cancel is never lost even if it
        // arrives between two reads.
        n.notify_one();
    }
}

async fn run_stream(
    st: &OllamaState,
    path: &str,
    mut body: Value,
    ch: &Channel<Value>,
    cancel: &Notify,
) -> Result<(), String> {
    if let Some(obj) = body.as_object_mut() {
        obj.insert("stream".into(), Value::Bool(true));
    }
    let request = st.client.post(st.url(path)).json(&body).send();
    let resp = tokio::select! {
        _ = cancel.notified() => {
            let _ = ch.send(json!({ "hush_cancelled": true }));
            return Ok(());
        }
        r = request => r.map_err(net_err)?,
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(ollama_error(status, &text));
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let next = tokio::select! {
            _ = cancel.notified() => {
                // Dropping the response closes the connection, which makes
                // Ollama stop generating.
                let _ = ch.send(json!({ "hush_cancelled": true }));
                return Ok(());
            }
            n = stream.next() => n,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(net_err)?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            emit_line(&line, ch)?;
        }
    }
    if !buf.is_empty() {
        emit_line(&buf, ch)?;
    }
    Ok(())
}

fn emit_line(line: &[u8], ch: &Channel<Value>) -> Result<(), String> {
    let text = String::from_utf8_lossy(line);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let v: Value =
        serde_json::from_str(trimmed).map_err(|e| format!("Bad data from Ollama: {e}"))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    ch.send(v).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::normalize_local;

    #[test]
    fn accepts_local_addresses() {
        assert_eq!(
            normalize_local("127.0.0.1:11434").unwrap(),
            "http://127.0.0.1:11434"
        );
        assert_eq!(
            normalize_local("http://localhost:8080/").unwrap(),
            "http://localhost:8080"
        );
        assert_eq!(
            normalize_local("localhost").unwrap(),
            "http://localhost:11434"
        );
        assert_eq!(normalize_local("[::1]:9000").unwrap(), "http://[::1]:9000");
        assert_eq!(normalize_local("[::1]").unwrap(), "http://[::1]:11434");
    }

    #[test]
    fn rejects_remote_addresses() {
        assert!(normalize_local("example.com:11434").is_err());
        assert!(normalize_local("192.168.1.20:11434").is_err());
        assert!(normalize_local("https://127.0.0.1:11434").is_err());
        assert!(normalize_local("127.0.0.1:11434/evil").is_err());
        assert!(normalize_local("127.0.0.1:notaport").is_err());
    }
}
