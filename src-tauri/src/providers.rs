use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

const USER_AGENT: &str = "ai-usage-monitor/0.1";
/// Bounds the request rate for every caller at once. Two windows polling
/// independently is what makes this the right place for the limit rather than
/// each poller's interval, and a 5-hour window does not move fast enough to
/// justify anything tighter.
const MIN_FETCH_INTERVAL_SECS: i64 = 60;
const ERROR_BACKOFF_SECS: i64 = 60;
const RATE_LIMITED_BACKOFF_SECS: i64 = 120;
/// However long a server asks us to wait, stop hiding the numbers after this.
const MAX_BACKOFF_SECS: i64 = 600;
/// The IDE is not open yet, which is far more likely to resolve on its own
/// within seconds than a real auth failure is, most often because this app
/// starts at login before the IDE has had a chance to.
const AG_NOT_RUNNING_BACKOFF_SECS: i64 = 10;
/// Every provider, in display order. The cached-paint path walks this, so a new
/// provider missing from it would simply never appear on a cold start.
const PROVIDER_IDS: [&str; 4] = ["claude", "codex", "glm", "antigravity"];

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

/// Drop a cached result so the next fetch retries immediately. Without this a
/// failed auth sits behind ERROR_BACKOFF_SECS, and saving a key looks like it
/// did nothing for a minute.
fn invalidate(id: &str) {
    if let Ok(mut map) = cache().lock() { map.remove(id); }
    if let Ok(mut map) = last_good().lock() { map.remove(id); }
}

/// The most recent successful reading, kept separately from the TTL cache.
fn last_good() -> &'static Mutex<HashMap<String, ProviderUsage>> {
    static G: OnceLock<Mutex<HashMap<String, ProviderUsage>>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(HashMap::new()))
}

fn put_good(id: &str, result: ProviderUsage) {
    if let Ok(mut map) = last_good().lock() {
        map.insert(id.to_string(), result);
    }
}

/// A rate limit or a dropped connection says nothing about the numbers we
/// already have, so keep showing the last good reading instead of replacing it
/// with an error. Only failures the user must act on (missing or rejected
/// credentials) are allowed to blank the card.
fn degrade(id: &str, failure: ProviderUsage, backoff_secs: i64) -> ProviderUsage {
    let backoff = backoff_secs.clamp(1, MAX_BACKOFF_SECS);
    let transient = matches!(failure.auth_state.as_str(), "rate_limited" | "network_error");

    if transient {
        if let Ok(map) = last_good().lock() {
            if let Some(good) = map.get(id).cloned() {
                put_cache(id, good.clone(), backoff);
                return good;
            }
        }
    }
    put_cache(id, failure.clone(), backoff);
    failure
}

/// One limit window. Providers report anywhere from one of these to four, on
/// windows that are not always a tidy five-hour plus weekly pair, so they are a
/// list rather than fixed slots. Every window ranks equally: the frontend picks
/// whichever is closest to its limit, because that is the one that stops you.
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct UsageWindow {
    pub label: String,
    pub used_percent: f64,
    /// 0 when the provider reports no reset time, which reads as "ready".
    pub resets_at_unix: i64,
}

impl UsageWindow {
    fn new(label: &str, used_percent: f64, resets_at_unix: i64) -> Self {
        Self { label: label.into(), used_percent, resets_at_unix }
    }
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct ProviderUsage {
    pub id: String,
    pub display_name: String,
    pub short_label: String,
    pub windows: Vec<UsageWindow>,
    pub plan_type: Option<String>,
    /// "ok" | "no_credentials" | "auth_failed" | "network_error" | "not_running" | "not_implemented"
    pub auth_state: String,
    pub auth_error: Option<String>,
    /// Whether this provider can be authenticated with a user-supplied API key.
    /// False where the vendor exposes plan usage only to its own CLI's credential.
    pub accepts_key: bool,
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
        Err(_) => { return degrade("claude", u, ERROR_BACKOFF_SECS); }
    };
    let kc: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => { u.auth_state = "auth_failed".into(); u.auth_error = Some(format!("parse keychain: {e}")); return degrade("claude", u, ERROR_BACKOFF_SECS); }
    };
    let token = match kc["claudeAiOauth"]["accessToken"].as_str() {
        Some(t) => t.to_string(),
        None => { u.auth_state = "auth_failed".into(); u.auth_error = Some("no access token".into()); return degrade("claude", u, ERROR_BACKOFF_SECS); }
    };

    let resp = ureq::get(CLAUDE_USAGE)
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", CLAUDE_BETA)
        .set("User-Agent", USER_AGENT)
        .call();

    let body: Value = match resp {
        Ok(r) => match r.into_json() {
            Ok(v) => v,
            Err(e) => { u.auth_state = "network_error".into(); u.auth_error = Some(format!("json: {e}")); return degrade("claude", u, ERROR_BACKOFF_SECS); }
        },
        Err(ureq::Error::Status(401, _)) => { u.auth_state = "auth_failed".into(); u.auth_error = Some("401 — run `claude` to refresh".into()); return degrade("claude", u, ERROR_BACKOFF_SECS); }
        Err(ureq::Error::Status(429, r)) => {
            let retry = r.header("retry-after").and_then(|s| s.parse::<i64>().ok()).unwrap_or(RATE_LIMITED_BACKOFF_SECS);
            u.auth_state = "rate_limited".into();
            u.auth_error = Some(format!("rate limited — retrying in {retry}s"));
            return degrade("claude", u, retry);
        }
        Err(e) => { u.auth_state = "network_error".into(); u.auth_error = Some(e.to_string()); return degrade("claude", u, ERROR_BACKOFF_SECS); }
    };

    u.auth_state = "ok".into();
    u.plan_type = kc["claudeAiOauth"]["subscriptionType"].as_str().map(String::from);

    // Keyed off the utilization, not the reset time: a window with no reset time
    // is still a window worth showing, it just has no countdown yet.
    if let Some(pct) = body["five_hour"]["utilization"].as_f64() {
        u.windows.push(UsageWindow::new("5 hour", pct,
            body["five_hour"]["resets_at"].as_str().and_then(iso_to_unix).unwrap_or(0)));
    }
    if let Some(pct) = body["seven_day"]["utilization"].as_f64() {
        u.windows.push(UsageWindow::new("Weekly", pct,
            body["seven_day"]["resets_at"].as_str().and_then(iso_to_unix).unwrap_or(0)));
    }
    put_good("claude", u.clone());
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

    let home = match dirs::home_dir() { Some(h) => h, None => { return degrade("codex", u, ERROR_BACKOFF_SECS); } };
    let path = home.join(".codex/auth.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => { return degrade("codex", u, ERROR_BACKOFF_SECS); }
    };
    let auth: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => { u.auth_state = "auth_failed".into(); u.auth_error = Some(format!("parse auth.json: {e}")); return degrade("codex", u, ERROR_BACKOFF_SECS); }
    };
    let token = match auth["tokens"]["access_token"].as_str() {
        Some(t) => t.to_string(),
        None => { u.auth_state = "auth_failed".into(); u.auth_error = Some("no access token".into()); return degrade("codex", u, ERROR_BACKOFF_SECS); }
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
            Err(e) => { u.auth_state = "network_error".into(); u.auth_error = Some(format!("json: {e}")); return degrade("codex", u, ERROR_BACKOFF_SECS); }
        },
        Err(ureq::Error::Status(401, _)) => { u.auth_state = "auth_failed".into(); u.auth_error = Some("401 — run `codex` to refresh".into()); return degrade("codex", u, ERROR_BACKOFF_SECS); }
        Err(ureq::Error::Status(429, r)) => {
            let retry = r.header("retry-after").and_then(|s| s.parse::<i64>().ok()).unwrap_or(RATE_LIMITED_BACKOFF_SECS);
            u.auth_state = "rate_limited".into();
            u.auth_error = Some(format!("rate limited — retrying in {retry}s"));
            return degrade("codex", u, retry);
        }
        Err(e) => { u.auth_state = "network_error".into(); u.auth_error = Some(e.to_string()); return degrade("codex", u, ERROR_BACKOFF_SECS); }
    };

    u.auth_state = "ok".into();
    u.plan_type = body["plan_type"].as_str().map(String::from);

    let rl = &body["rate_limit"];
    if let Some(pct) = rl["primary_window"]["used_percent"].as_f64() {
        u.windows.push(UsageWindow::new("5 hour", pct,
            rl["primary_window"]["reset_at"].as_i64().unwrap_or(0)));
    }
    if let Some(pct) = rl["secondary_window"]["used_percent"].as_f64() {
        u.windows.push(UsageWindow::new("Weekly", pct,
            rl["secondary_window"]["reset_at"].as_i64().unwrap_or(0)));
    }
    put_good("codex", u.clone());
    put_cache("codex", u.clone(), MIN_FETCH_INTERVAL_SECS);
    u
}

// ── GLM (Z.ai coding plan) ──────────────────────────────────────────

const GLM_QUOTA: &str = "https://api.z.ai/api/monitor/usage/quota/limit";

/// Z.ai returns HTTP 200 even for auth failures, with the real status in the
/// body as `code` / `success`, so the body has to be checked, not just the status.
fn fetch_glm() -> ProviderUsage {
    if let Some(c) = cached("glm") { return c; }

    let mut u = ProviderUsage {
        id: "glm".into(),
        display_name: "GLM".into(),
        short_label: "GLM".into(),
        auth_state: "no_credentials".into(),
        accepts_key: true,
        ..Default::default()
    };

    // Keychain first (survives a GUI launch at login), env var as a dev fallback.
    let token = match read_keychain(&keychain_service("glm")).ok().or_else(|| std::env::var("ZAI_API_KEY").ok()) {
        Some(t) if !t.is_empty() => t,
        _ => { return degrade("glm", u, ERROR_BACKOFF_SECS); }
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
            Err(e) => { u.auth_state = "network_error".into(); u.auth_error = Some(format!("json: {e}")); return degrade("glm", u, ERROR_BACKOFF_SECS); }
        },
        Err(ureq::Error::Status(429, r)) => {
            let retry = r.header("retry-after").and_then(|s| s.parse::<i64>().ok()).unwrap_or(RATE_LIMITED_BACKOFF_SECS);
            u.auth_state = "rate_limited".into();
            u.auth_error = Some(format!("rate limited — retrying in {retry}s"));
            return degrade("glm", u, retry);
        }
        Err(e) => { u.auth_state = "network_error".into(); u.auth_error = Some(e.to_string()); return degrade("glm", u, ERROR_BACKOFF_SECS); }
    };

    if body["success"].as_bool() != Some(true) {
        let code = body["code"].as_i64().unwrap_or(0);
        let msg = body["msg"].as_str().unwrap_or("unknown error");
        u.auth_state = if code == 401 { "auth_failed".into() } else { "network_error".into() };
        u.auth_error = Some(if code == 401 { format!("{msg} — check the API key in Settings") } else { msg.to_string() });
        return degrade("glm", u, ERROR_BACKOFF_SECS);
    }

    u.auth_state = "ok".into();
    u.plan_type = body["data"]["level"].as_str().map(String::from);

    // TOKENS_LIMIT is the rolling coding-token window, the one that blocks you.
    // TIME_LIMIT is a daily allowance for the built-in tools (search, zread);
    // exhausting it costs you those tools inside a session, so it earns a row.
    if let Some(limits) = body["data"]["limits"].as_array() {
        let at = |kind: &str| limits.iter().find(|l| l["type"].as_str() == Some(kind)).cloned();
        // A freshly reset window comes back as percentage 0 with no
        // nextResetTime at all, so the reset time never gates the window.
        if let Some(t) = at("TOKENS_LIMIT") {
            u.windows.push(UsageWindow::new("5 hour",
                t["percentage"].as_f64().unwrap_or(0.0),
                t["nextResetTime"].as_i64().map(|ms| ms / 1000).unwrap_or(0)));
        }
        if let Some(t) = at("TIME_LIMIT") {
            u.windows.push(UsageWindow::new("Tools",
                t["percentage"].as_f64().unwrap_or(0.0),
                t["nextResetTime"].as_i64().map(|ms| ms / 1000).unwrap_or(0)));
        }
    }
    put_good("glm", u.clone());
    put_cache("glm", u.clone(), MIN_FETCH_INTERVAL_SECS);
    u
}

// ── Antigravity ─────────────────────────────────────────────────────
//
// The odd one out. Antigravity has no readable stored credential: the one on
// disk is a dead artifact that signing in never refreshes. Quota lives behind
// an RPC on a language server the IDE starts, whose port and CSRF token are
// generated per launch and only discoverable from its command line. So this is
// the single provider that scrapes a process instead of reading a credential,
// and it only reports while the IDE is open.

const AG_RPC: &str = "exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const AG_PROCESS: &str = "language_server_macos_arm";

/// Every (port, csrf token) pair the running language servers expose. The IDE
/// runs more than one, and only some of their ports speak plain HTTP, so all of
/// them are candidates rather than just the first process found.
fn ag_endpoints() -> Vec<(u16, String)> {
    let Ok(out) = Command::new("/usr/bin/pgrep").args(["-f", AG_PROCESS]).output() else { return Vec::new() };
    let pids = String::from_utf8_lossy(&out.stdout);
    let mut endpoints = Vec::new();

    for pid in pids.split_whitespace() {
        let Ok(out) = Command::new("/bin/ps").args(["-p", pid, "-o", "command="]).output() else { continue };
        let cmd = String::from_utf8_lossy(&out.stdout);

        let mut args = cmd.split_whitespace();
        let token = loop {
            match args.next() {
                Some("--csrf_token") => break args.next().map(String::from),
                Some(_) => continue,
                None => break None,
            }
        };
        let Some(token) = token else { continue };

        let Ok(out) = Command::new("/usr/sbin/lsof")
            .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pid])
            .output() else { continue };

        for line in String::from_utf8_lossy(&out.stdout).lines().skip(1) {
            if let Some(port) = line.split_whitespace().nth(8)
                .and_then(|a| a.rsplit(':').next())
                .and_then(|p| p.parse::<u16>().ok())
            {
                endpoints.push((port, token.clone()));
            }
        }
    }
    endpoints
}

fn fetch_antigravity() -> ProviderUsage {
    if let Some(c) = cached("antigravity") { return c; }

    let mut u = ProviderUsage {
        id: "antigravity".into(),
        display_name: "Antigravity".into(),
        short_label: "AG".into(),
        auth_state: "no_credentials".into(),
        ..Default::default()
    };

    let endpoints = ag_endpoints();
    if endpoints.is_empty() {
        // Not a sign-in problem: there is no credential to hold, only a live IDE.
        u.auth_state = "not_running".into();
        u.auth_error = Some("Open Antigravity to read its quota. It keeps no reusable credential on disk.".into());
        return degrade("antigravity", u, AG_NOT_RUNNING_BACKOFF_SECS);
    }

    // Plain HTTP only: some of these ports serve it unencrypted, and the rest
    // present a self-signed certificate no client should be taught to accept.
    let body = endpoints.iter().find_map(|(port, token)| {
        ureq::post(&format!("http://127.0.0.1:{port}/{AG_RPC}"))
            .set("Content-Type", "application/json")
            .set("X-Codeium-Csrf-Token", token)
            .set("Connect-Protocol-Version", "1")
            .set("User-Agent", USER_AGENT)
            .timeout(std::time::Duration::from_secs(5))
            .send_string(r#"{"metadata":{"ideName":"antigravity","extensionName":"antigravity","locale":"en","ideVersion":"unknown"}}"#)
            .ok()
            .and_then(|r| r.into_json::<Value>().ok())
            .filter(|v| v["response"]["groups"].is_array())
    });

    let Some(body) = body else {
        u.auth_state = "network_error".into();
        u.auth_error = Some("Found Antigravity but its quota service did not answer.".into());
        return degrade("antigravity", u, ERROR_BACKOFF_SECS);
    };

    u.auth_state = "ok".into();

    // Each group is an independent pool with its own windows: the reset times
    // differ and they drain separately, so they are never merged.
    for group in body["response"]["groups"].as_array().into_iter().flatten() {
        let pool = match group["displayName"].as_str() {
            Some(n) if n.starts_with("Gemini") => "Gemini",
            Some(_) => "Claude",
            None => continue,
        };
        // The API lists weekly before the five hour window; every card reads
        // shortest window first, so the buckets are ordered rather than taken
        // as they arrive.
        let mut buckets: Vec<&Value> = group["buckets"].as_array().into_iter().flatten().collect();
        buckets.sort_by_key(|b| match b["window"].as_str() {
            Some("5h") => 0,
            Some("weekly") => 1,
            _ => 2,
        });

        for bucket in buckets {
            // Reported as the fraction still available, the inverse of every
            // other provider, so invert it to keep "used" consistent.
            let Some(remaining) = bucket["remainingFraction"].as_f64() else { continue };
            let short = match bucket["window"].as_str() {
                Some("5h") => "5h",
                Some("weekly") => "wk",
                other => other.unwrap_or("?"),
            };
            u.windows.push(UsageWindow::new(
                &format!("{pool} {short}"),
                (1.0 - remaining) * 100.0,
                bucket["resetTime"].as_str().and_then(iso_to_unix).unwrap_or(0),
            ));
        }
    }

    put_good("antigravity", u.clone());
    put_cache("antigravity", u.clone(), MIN_FETCH_INTERVAL_SECS);
    u
}

// ── API key storage ─────────────────────────────────────────────────

fn keychain_service(provider: &str) -> String {
    format!("ai-usage-{provider}")
}

/// Whether a key is stored, never the key itself: secrets only travel inward.
#[tauri::command]
pub fn has_provider_key(provider: String) -> bool {
    read_keychain(&keychain_service(&provider)).map(|k| !k.is_empty()).unwrap_or(false)
}

#[tauri::command]
pub fn set_provider_key(provider: String, key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() { return Err("key is empty".into()); }

    let service = keychain_service(&provider);
    let account = std::env::var("USER").unwrap_or_else(|_| "ai-usage".into());

    // `-w` with no value reads the password from stdin (asked twice), which keeps
    // the key out of the process list where `-w <key>` would expose it.
    let mut child = Command::new("security")
        .args(["add-generic-password", "-U", "-a", &account, "-s", &service, "-w"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("security: {e}"))?;

    child.stdin.as_mut().ok_or("no stdin")?
        .write_all(format!("{key}\n{key}\n").as_bytes())
        .map_err(|e| format!("write key: {e}"))?;

    let status = child.wait().map_err(|e| format!("security: {e}"))?;
    if !status.success() { return Err("could not write to the keychain".into()); }

    invalidate(&provider);
    Ok(())
}

#[tauri::command]
pub fn clear_provider_key(provider: String) -> Result<(), String> {
    let service = keychain_service(&provider);
    let out = Command::new("security")
        .args(["delete-generic-password", "-s", &service])
        .output()
        .map_err(|e| format!("security: {e}"))?;
    if !out.status.success() { return Err("no key to remove".into()); }
    invalidate(&provider);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_service_is_namespaced() {
        assert_eq!(keychain_service("glm"), "ai-usage-glm");
    }

    fn usage(id: &str, state: &str, pct: f64) -> ProviderUsage {
        ProviderUsage {
            id: id.into(),
            auth_state: state.into(),
            windows: vec![UsageWindow::new("5 hour", pct, 0)],
            ..Default::default()
        }
    }

    #[test]
    fn transient_failure_keeps_the_last_good_reading() {
        let id = "test-transient";
        put_good(id, usage(id, "ok", 42.0));

        let shown = degrade(id, usage(id, "rate_limited", 0.0), 60);

        assert_eq!(shown.auth_state, "ok", "a rate limit should not blank a good reading");
        assert_eq!(shown.windows[0].used_percent, 42.0);
        invalidate(id);
    }

    #[test]
    fn cached_read_falls_back_to_last_good_and_skips_the_unknown() {
        // Uses the real provider ids because get_cached_providers only looks at
        // those three. Cleaned up at the end so the other tests are unaffected.
        invalidate("claude");
        invalidate("codex");
        put_good("claude", usage("claude", "ok", 42.0));

        let res = get_cached_providers(vec!["claude".into(), "codex".into()]);

        assert_eq!(res.providers.len(), 1, "codex has nothing known, so it is omitted rather than faked");
        assert_eq!(res.providers[0].id, "claude");
        assert_eq!(
            res.providers[0].windows[0].used_percent,
            42.0,
            "an expired TTL cache should still paint from the last good reading"
        );

        invalidate("claude");
    }

    #[test]
    fn auth_failure_is_shown_even_with_a_good_reading() {
        let id = "test-auth";
        put_good(id, usage(id, "ok", 42.0));

        let shown = degrade(id, usage(id, "auth_failed", 0.0), 60);

        assert_eq!(shown.auth_state, "auth_failed", "the user has to act on this one");
        invalidate(id);
    }

    #[test]
    fn transient_failure_with_no_history_still_reports() {
        let id = "test-cold";
        invalidate(id);

        let shown = degrade(id, usage(id, "network_error", 0.0), 60);

        assert_eq!(shown.auth_state, "network_error");
        invalidate(id);
    }

    /// A freshly reset Z.ai window returns percentage 0 and omits nextResetTime
    /// entirely. Keying the window off the reset time dropped it and rendered a
    /// provider card with no numbers at all.
    #[test]
    fn a_window_with_no_reset_time_still_produces_a_window() {
        let body: Value = serde_json::from_str(
            r#"{"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":0}]}}"#,
        ).unwrap();

        let t = body["data"]["limits"].as_array().unwrap().iter()
            .find(|l| l["type"].as_str() == Some("TOKENS_LIMIT")).unwrap().clone();
        let w = UsageWindow::new("5 hour",
            t["percentage"].as_f64().unwrap_or(0.0),
            t["nextResetTime"].as_i64().map(|ms| ms / 1000).unwrap_or(0));

        assert_eq!(w.used_percent, 0.0);
        assert_eq!(w.resets_at_unix, 0, "no countdown, rather than no window");
    }

    /// Antigravity reports the fraction still available, the inverse of every
    /// other provider, and its two pools are never merged.
    #[test]
    fn antigravity_groups_become_separate_inverted_windows() {
        // Buckets deliberately in the order the API actually sends them,
        // weekly before five hour, so the ordering is what is under test.
        let body: Value = serde_json::from_str(r#"{"response":{"groups":[
          {"displayName":"Gemini Models","buckets":[
            {"bucketId":"gemini-weekly","window":"weekly","remainingFraction":0.99,"resetTime":"2026-09-19T07:06:34Z"},
            {"bucketId":"gemini-5h","window":"5h","remainingFraction":0.94,"resetTime":"2026-09-12T12:06:34Z"}]},
          {"displayName":"Claude and GPT models","buckets":[
            {"bucketId":"3p-weekly","window":"weekly","remainingFraction":1,"resetTime":"2026-09-19T11:45:07Z"},
            {"bucketId":"3p-5h","window":"5h","remainingFraction":1,"resetTime":"2026-09-12T16:45:07Z"}]}
        ]}}"#).unwrap();

        let mut windows = Vec::new();
        for group in body["response"]["groups"].as_array().into_iter().flatten() {
            let pool = match group["displayName"].as_str() {
                Some(n) if n.starts_with("Gemini") => "Gemini",
                Some(_) => "Claude",
                None => continue,
            };
            let mut buckets: Vec<&Value> = group["buckets"].as_array().into_iter().flatten().collect();
            buckets.sort_by_key(|b| match b["window"].as_str() {
                Some("5h") => 0,
                Some("weekly") => 1,
                _ => 2,
            });
            for bucket in buckets {
                let Some(remaining) = bucket["remainingFraction"].as_f64() else { continue };
                let short = match bucket["window"].as_str() {
                    Some("5h") => "5h",
                    Some("weekly") => "wk",
                    other => other.unwrap_or("?"),
                };
                windows.push(UsageWindow::new(&format!("{pool} {short}"), (1.0 - remaining) * 100.0,
                    bucket["resetTime"].as_str().and_then(iso_to_unix).unwrap_or(0)));
            }
        }

        let labels: Vec<&str> = windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(
            labels,
            ["Gemini 5h", "Gemini wk", "Claude 5h", "Claude wk"],
            "pools stay apart and each reads shortest window first, whatever order the API sent"
        );
        assert!((windows[0].used_percent - 6.0).abs() < 0.001, "0.94 remaining is 6% used");
        assert_eq!(windows[3].used_percent, 0.0, "fully remaining is nothing used");
    }

    #[test]
    fn backoff_is_capped() {
        let id = "test-backoff";
        invalidate(id);
        degrade(id, usage(id, "rate_limited", 0.0), 86_400);

        // Cached, not stuck for a day: still valid now, expired past the cap.
        let map = cache().lock().unwrap();
        let valid_until = map.get(id).unwrap().valid_until_unix;
        assert!(valid_until <= Local::now().timestamp() + MAX_BACKOFF_SECS);
    }

    /// `security -w` reading the value twice from stdin is undocumented, and a
    /// silent change there would break key saving with no compile error.
    #[test]
    fn key_round_trips_through_the_keychain() {
        let provider = format!("selftest-{}", std::process::id());
        let secret = "round-trip-canary";

        set_provider_key(provider.clone(), secret.into()).expect("write key");
        assert!(has_provider_key(provider.clone()), "key should be stored");
        assert_eq!(read_keychain(&keychain_service(&provider)).unwrap(), secret);

        clear_provider_key(provider.clone()).expect("remove key");
        assert!(!has_provider_key(provider), "key should be gone");
    }
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
    if want("antigravity") { handles.push(std::thread::spawn(fetch_antigravity)); }

    let providers: Vec<ProviderUsage> = handles.into_iter().filter_map(|h| h.join().ok()).collect();

    let now = Local::now();
    ProvidersResponse {
        providers,
        last_updated: now.format("%H:%M:%S").to_string(),
        now_unix: now.timestamp(),
    }
}

/// Whatever is already known for these providers, with no network access.
///
/// The popover calls this first so it can paint immediately. `get_providers`
/// joins a thread per provider and returns once, after the SLOWEST one, so on a
/// cold open the whole popover sat on "Loading..." for as long as the worst
/// provider took. The numbers are usually already sitting in memory by then,
/// put there by `warm_cache` at launch, they just had no way to reach the UI.
///
/// Falls back to `last_good` when the TTL cache has expired: a reading a few
/// minutes old renders instantly and is replaced by the live refresh a moment
/// later, which beats a blank panel. Providers with nothing known are omitted
/// rather than faked, so the row appears when it has something to say.
#[tauri::command]
pub fn get_cached_providers(enabled: Vec<String>) -> ProvidersResponse {
    let want = |id: &str| enabled.is_empty() || enabled.iter().any(|e| e == id);

    let providers: Vec<ProviderUsage> = PROVIDER_IDS
        .iter()
        .filter(|id| want(id))
        .filter_map(|id| {
            cached(id).or_else(|| last_good().lock().ok()?.get(*id).cloned())
        })
        .collect();

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
