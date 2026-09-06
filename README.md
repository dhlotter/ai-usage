# AI Usage Monitor — macOS Menubar App

A native macOS menubar app that shows real-time rate-limit status for your AI developer tools.
Built with **Tauri 2 + React/TypeScript** (Rust backend, React/TS frontend).

---

## What it does

- **Menubar tray icon** — click to toggle a popover panel positioned below the icon
- **Per-provider cards** — usage bar, used %, live reset countdown, plan type
- **Auth state handling** — dimmed cards with a clear message when a token is missing or expired
- **macOS notifications** when a provider crosses your alert threshold
- **Settings view** — provider toggles, menu-bar countdown source, alert threshold, refresh interval
- Right-click tray menu → Open / Quit; hides on focus loss

---

## Providers

| Provider | Data Source | Auth Method | Status |
|---|---|---|---|
| **Claude** | `api.anthropic.com/api/oauth/usage` | macOS Keychain (`Claude Code-credentials`) | ✅ Working |
| **Codex (ChatGPT)** | `chatgpt.com/backend-api/wham/usage` | `~/.codex/auth.json` | ✅ Working |
| **Antigravity** | — | Google OAuth (local encrypted storage) | 🔜 Placeholder |

No credentials ever touch the frontend: the Rust backend reads tokens directly.

---

## Tech Stack

```
src/
  main.tsx        Entry point
  App.tsx         Main view + settings view (self-contained)
  App.css         Dark-mode design system

src-tauri/src/
  lib.rs          Tray icon, window positioning, vibrancy, auto-resize
  providers.rs    get_providers command: HTTP fetches + in-process cache
```

**Rust deps:** `tauri 2`, `tauri-plugin-notification`, `ureq`, `chrono`, `serde_json`, `dirs`
**JS deps:** `@tauri-apps/api`, `@tauri-apps/plugin-notification`

---

## Dev Setup

```bash
# 1. Install Rust (one-time)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 2. Install JS deps
npm install

# 3. Run with hot-reload
npm run tauri dev
```

If the build fails reading permission files from a path that doesn't exist,
the project moved and `target/` holds stale absolute paths. Run `cargo clean` in `src-tauri/`.

## Build release `.app`

```bash
source "$HOME/.cargo/env"
npm run tauri build
# → src-tauri/target/release/bundle/macos/AI Usage.app
```

---

## Rust → Frontend data contract

```typescript
interface LimitBucket {
  used_percent: number;         // 0–100+
  resets_at_unix: number;       // epoch seconds
  window_seconds: number;
}

interface ProviderUsage {
  id: 'claude' | 'codex' | 'antigravity';
  display_name: string;
  short_label: string;
  five_hour: LimitBucket | null;   // primary window
  weekly: LimitBucket | null;      // secondary window
  plan_type: string | null;        // "pro", "max5", "enterprise", ...
  auth_state:
    | 'ok'
    | 'no_credentials'
    | 'auth_failed'
    | 'network_error'
    | 'rate_limited'
    | 'not_implemented';
  auth_error: string | null;
}

interface ProvidersResponse {
  providers: ProviderUsage[];
  last_updated: string;           // HH:MM:SS
  now_unix: number;
}
```

---

See [PLAN.md](PLAN.md) for remaining tasks and roadmap.
