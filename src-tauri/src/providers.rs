use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

const USER_AGENT: &str = "ai-usage-monitor/0.1";
const MIN_FETCH_INTERVAL_SECS: i64 = 30;
const ERROR_BACKOFF_SECS: i64 = 60;
const RATE_LIMITED_BACKOFF_SECS: i64 = 120;

#[derive(Clone)]
struct Cached {
    result: ProviderUsage,
    valid_until_unix: i64,
}

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static C: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached(id: &str) -> Option<ProviderUsage> {
    let now = Local::now().timestamp();
    let map = cache().lock().ok()?;
    let entry = map.get(id)?;
    if entry.valid_until_unix > now { Some(entry.result.clone()) } else { None }
}

fn put_cache(id: &str, result: ProviderUsage, ttl_secs: i64) {
    let now = Local::now().timestamp();
    if let Ok(mut map) = cache().lock() {
        map.insert(id.to_string(), Cached { result, valid_until_unix: now + ttl_secs });
    }
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct LimitBucket {
    pub used_percent: f64,
    pub resets_at_unix: i64,
    pub window_seconds: i64,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct ProviderUsage {
    pub id: String,
    pub display_name: String,
    pub short_label: String,
    pub five_hour: Option<LimitBucket>,
    pub weekly: Option<LimitBucket>,
    pub plan_type: Option<String>,
    /// "ok" | "no_credentials" | "auth_failed" | "network_error" | "not_implemented"
    pub auth_state: String,
    pub auth_error: Option<String>,
}

// ── Claude ──────────────────────────────────────────────────────────

const CLAUDE_USAGE: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_BETA: &str = "oauth-2025-04-20";

fn read_keychain(service: &str) -> Result<String, String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", service, "-w"])
        .output()
        .map_err(|e| format!("security cmd: {e}"))?;
    if !out.status.success() {
        return Err("no_credentials".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn iso_to_unix(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp())
}

fn fetch_claude() -> ProviderUsage {
    if let Some(c) = cached("claude") { return c; }

    let mut u = ProviderUsage {
        id: "claude".into(),
        display_name: "Claude Code".into(),
        short_label: "Claude".into(),
        auth_state: "no_credentials".into(),
        ..Default::default()
    };

    let raw = match read_keychain("Claude Code-credentials") {
        Ok(s) => s,
        Err(_) => { put_cache("claude", u.clone(), ERROR_BACKOFF_SECS); return u; }
    };
    let kc: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => { u.auth_state = "auth_failed".into(); u.auth_error = Some(format!("parse keychain: {e}")); put_cache("claude", u.clone(), ERROR_BACKOFF_SECS); return u; }
    };
    let token = match kc["claudeAiOauth"]["accessToken"].as_str() {
        Some(t) => t.to_string(),
        None => { u.auth_state = "auth_failed".into(); u.auth_error = Some("no access token".into()); put_cache("claude", u.clone(), ERROR_BACKOFF_SECS); return u; }
    };

    let resp = ureq::get(CLAUDE_USAGE)
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", CLAUDE_BETA)
        .set("User-Agent", USER_AGENT)
        .call();

    let body: Value = match resp {
        Ok(r) => match r.into_json() {
            Ok(v) => v,
            Err(e) => { u.auth_state = "network_error".into(); u.auth_error = Some(format!("json: {e}")); put_cache("claude", u.clone(), ERROR_BACKOFF_SECS); return u; }
        },
        Err(ureq::Error::Status(401, _)) => { u.auth_state = "auth_failed".into(); u.auth_error = Some("401 — run `claude` to refresh".into()); put_cache("claude", u.clone(), ERROR_BACKOFF_SECS); return u; }
        Err(ureq::Error::Status(429, r)) => {
            let retry = r.header("retry-after").and_then(|s| s.parse::<i64>().ok()).unwrap_or(RATE_LIMITED_BACKOFF_SECS);
            u.auth_state = "rate_limited".into();
            u.auth_error = Some(format!("rate limited — retrying in {retry}s"));
            put_cache("claude", u.clone(), retry);
            return u;
        }
        Err(e) => { u.auth_state = "network_error".into(); u.auth_error = Some(e.to_string()); put_cache("claude", u.clone(), ERROR_BACKOFF_SECS); return u; }
    };

    u.auth_state = "ok".into();
    u.plan_type = kc["claudeAiOauth"]["subscriptionType"].as_str().map(String::from);

    if let Some(rfc) = body["five_hour"]["resets_at"].as_str() {
        if let Some(unix) = iso_to_unix(rfc) {
            u.five_hour = Some(LimitBucket {
                used_percent: body["five_hour"]["utilization"].as_f64().unwrap_or(0.0),
                resets_at_unix: unix,
                window_seconds: 5 * 3600,
            });
        }
    }
    if let Some(rfc) = body["seven_day"]["resets_at"].as_str() {
        if let Some(unix) = iso_to_unix(rfc) {
            u.weekly = Some(LimitBucket {
                used_percent: body["seven_day"]["utilization"].as_f64().unwrap_or(0.0),
                resets_at_unix: unix,
                window_seconds: 7 * 24 * 3600,
            });
        }
    }
    put_cache("claude", u.clone(), MIN_FETCH_INTERVAL_SECS);
    u
}

// ── Codex (ChatGPT) ─────────────────────────────────────────────────

const CODEX_USAGE: &str = "https://chatgpt.com/backend-api/wham/usage";

fn fetch_codex() -> ProviderUsage {
    if let Some(c) = cached("codex") { return c; }

    let mut u = ProviderUsage {
        id: "codex".into(),
        display_name: "Codex".into(),
        short_label: "Codex".into(),
        auth_state: "no_credentials".into(),
        ..Default::default()
    };

    let home = match dirs::home_dir() { Some(h) => h, None => { put_cache("codex", u.clone(), ERROR_BACKOFF_SECS); return u; } };
    let path = home.join(".codex/auth.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => { put_cache("codex", u.clone(), ERROR_BACKOFF_SECS); return u; }
    };
    let auth: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => { u.auth_state = "auth_failed".into(); u.auth_error = Some(format!("parse auth.json: {e}")); put_cache("codex", u.clone(), ERROR_BACKOFF_SECS); return u; }
    };
    let token = match auth["tokens"]["access_token"].as_str() {
        Some(t) => t.to_string(),
        None => { u.auth_state = "auth_failed".into(); u.auth_error = Some("no access token".into()); put_cache("codex", u.clone(), ERROR_BACKOFF_SECS); return u; }
    };
    let account_id = auth["tokens"]["account_id"].as_str().unwrap_or("").to_string();

    let resp = ureq::get(CODEX_USAGE)
        .set("Authorization", &format!("Bearer {token}"))
        .set("ChatGPT-Account-ID", &account_id)
        .set("User-Agent", USER_AGENT)
        .call();

    let body: Value = match resp {
        Ok(r) => match r.into_json() {
            Ok(v) => v,
            Err(e) => { u.auth_state = "network_error".into(); u.auth_error = Some(format!("json: {e}")); put_cache("codex", u.clone(), ERROR_BACKOFF_SECS); return u; }
        },
        Err(ureq::Error::Status(401, _)) => { u.auth_state = "auth_failed".into(); u.auth_error = Some("401 — run `codex` to refresh".into()); put_cache("codex", u.clone(), ERROR_BACKOFF_SECS); return u; }
        Err(ureq::Error::Status(429, r)) => {
            let retry = r.header("retry-after").and_then(|s| s.parse::<i64>().ok()).unwrap_or(RATE_LIMITED_BACKOFF_SECS);
            u.auth_state = "rate_limited".into();
            u.auth_error = Some(format!("rate limited — retrying in {retry}s"));
            put_cache("codex", u.clone(), retry);
            return u;
        }
        Err(e) => { u.auth_state = "network_error".into(); u.auth_error = Some(e.to_string()); put_cache("codex", u.clone(), ERROR_BACKOFF_SECS); return u; }
    };

    u.auth_state = "ok".into();
    u.plan_type = body["plan_type"].as_str().map(String::from);

    let rl = &body["rate_limit"];
    if let Some(reset_at) = rl["primary_window"]["reset_at"].as_i64() {
        u.five_hour = Some(LimitBucket {
            used_percent: rl["primary_window"]["used_percent"].as_f64().unwrap_or(0.0),
            resets_at_unix: reset_at,
            window_seconds: rl["primary_window"]["limit_window_seconds"].as_i64().unwrap_or(5 * 3600),
        });
    }
    if let Some(reset_at) = rl["secondary_window"]["reset_at"].as_i64() {
        u.weekly = Some(LimitBucket {
            used_percent: rl["secondary_window"]["used_percent"].as_f64().unwrap_or(0.0),
            resets_at_unix: reset_at,
            window_seconds: rl["secondary_window"]["limit_window_seconds"].as_i64().unwrap_or(7 * 24 * 3600),
        });
    }
    put_cache("codex", u.clone(), MIN_FETCH_INTERVAL_SECS);
    u
}

// ── GLM (Z.ai coding plan) ──────────────────────────────────────────

const GLM_QUOTA: &str = "https://api.z.ai/api/monitor/usage/quota/limit";
const GLM_KEYCHAIN_SERVICE: &str = "ai-usage-zai";

/// Z.ai returns HTTP 200 even for auth failures, with the real status in the
/// body as `code` / `success`, so the body has to be checked, not just the status.
fn fetch_glm() -> ProviderUsage {
    if let Some(c) = cached("glm") { return c; }

    let mut u = ProviderUsage {
        id: "glm".into(),
        display_name: "GLM".into(),
        short_label: "GLM".into(),
        auth_state: "no_credentials".into(),
        ..Default::default()
    };

    // Keychain first (survives a GUI launch at login), env var as a dev fallback.
    let token = match read_keychain(GLM_KEYCHAIN_SERVICE).ok().or_else(|| std::env::var("ZAI_API_KEY").ok()) {
        Some(t) if !t.is_empty() => t,
        _ => { put_cache("glm", u.clone(), ERROR_BACKOFF_SECS); return u; }
    };

    let resp = ureq::get(GLM_QUOTA)
        .set("Authorization", &token)
        .set("Accept-Language", "en-US,en")
        .set("Content-Type", "application/json")
        .set("User-Agent", USER_AGENT)
        .call();

    let body: Value = match resp {
        Ok(r) => match r.into_json() {
            Ok(v) => v,
            Err(e) => { u.auth_state = "network_error".into(); u.auth_error = Some(format!("json: {e}")); put_cache("glm", u.clone(), ERROR_BACKOFF_SECS); return u; }
        },
        Err(ureq::Error::Status(429, r)) => {
            let retry = r.header("retry-after").and_then(|s| s.parse::<i64>().ok()).unwrap_or(RATE_LIMITED_BACKOFF_SECS);
            u.auth_state = "rate_limited".into();
            u.auth_error = Some(format!("rate limited — retrying in {retry}s"));
            put_cache("glm", u.clone(), retry);
            return u;
        }
        Err(e) => { u.auth_state = "network_error".into(); u.auth_error = Some(e.to_string()); put_cache("glm", u.clone(), ERROR_BACKOFF_SECS); return u; }
    };

    if body["success"].as_bool() != Some(true) {
        let code = body["code"].as_i64().unwrap_or(0);
        let msg = body["msg"].as_str().unwrap_or("unknown error");
        u.auth_state = if code == 401 { "auth_failed".into() } else { "network_error".into() };
        u.auth_error = Some(if code == 401 { format!("{msg} — update the {GLM_KEYCHAIN_SERVICE} keychain item") } else { msg.to_string() });
        put_cache("glm", u.clone(), ERROR_BACKOFF_SECS);
        return u;
    }

    u.auth_state = "ok".into();
    u.plan_type = body["data"]["level"].as_str().map(String::from);

    // TOKENS_LIMIT is the rolling coding-token window (the one that blocks you).
    // TIME_LIMIT is a separate daily MCP-tool counter, deliberately not shown.
    if let Some(limits) = body["data"]["limits"].as_array() {
        if let Some(t) = limits.iter().find(|l| l["type"].as_str() == Some("TOKENS_LIMIT")) {
            if let Some(reset_ms) = t["nextResetTime"].as_i64() {
                let hours = t["number"].as_i64().unwrap_or(5);
                u.five_hour = Some(LimitBucket {
                    used_percent: t["percentage"].as_f64().unwrap_or(0.0),
                    resets_at_unix: reset_ms / 1000,
                    window_seconds: hours * 3600,
                });
            }
        }
    }
    put_cache("glm", u.clone(), MIN_FETCH_INTERVAL_SECS);
    u
}

// ── Public command ──────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct ProvidersResponse {
    pub providers: Vec<ProviderUsage>,
    pub last_updated: String,
    pub now_unix: i64,
}

#[tauri::command]
pub fn get_providers(enabled: Vec<String>) -> ProvidersResponse {
    let want = |id: &str| enabled.is_empty() || enabled.iter().any(|e| e == id);

    // Fetched in parallel: run back to back these take the sum of all three
    // (~1.8s), which is long enough to show an empty popover on a cold start.
    // ponytail: a thread per provider per refresh, a pool only if this grows.
    let mut handles: Vec<std::thread::JoinHandle<ProviderUsage>> = Vec::new();
    if want("claude") { handles.push(std::thread::spawn(fetch_claude)); }
    if want("codex") { handles.push(std::thread::spawn(fetch_codex)); }
    if want("glm") { handles.push(std::thread::spawn(fetch_glm)); }

    let providers: Vec<ProviderUsage> = handles.into_iter().filter_map(|h| h.join().ok()).collect();

    let now = Local::now();
    ProvidersResponse {
        providers,
        last_updated: now.format("%H:%M:%S").to_string(),
        now_unix: now.timestamp(),
    }
}

/// Populate the cache at launch so the first click renders from a warm cache.
/// Without this nothing is fetched until the webview has booted (~2.4s), and
/// only then does the first request go out.
pub fn warm_cache() {
    std::thread::spawn(|| { get_providers(Vec::new()); });
}
