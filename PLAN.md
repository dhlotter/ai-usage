# AI Usage Monitor — Plan & Progress

## Current state ✅

The unified data model shipped as a **self-contained `App.tsx`** (main view + settings view inline).
The old multi-file frontend (`Dashboard.tsx`, `Settings.tsx`, `types.ts`, `store.ts`) was orphaned
in the rewrite and has been deleted.

### Working today
- [x] Tauri 2 menubar app (React/TS + Rust), Accessory activation policy, popover vibrancy
- [x] Tray icon: click toggle, right-click menu (Open / Quit), hides on focus loss
- [x] Window auto-resizes to content height (`resize_window` + ResizeObserver)
- [x] Single Rust command `get_providers(enabled)` → `ProviderUsage[]` with in-process cache
      (30s TTL, 60s error backoff, 120s rate-limit backoff)
- [x] **Claude** — `api.anthropic.com/api/oauth/usage`, OAuth token from Keychain
      (`Claude Code-credentials` service); 5-hour + weekly windows, plan type
- [x] **Codex** — `chatgpt.com/backend-api/wham/usage`, token from `~/.codex/auth.json`;
      primary + secondary windows, plan type
- [x] Per-provider cards: progress bar, used %, live countdown ("resets in 2h 14m", 1s tick)
- [x] Auth state rendering: not signed in / token expired / connection error / coming soon,
      dimmed card + detail line
- [x] Settings: provider toggles, menu-bar countdown source, alert threshold, refresh interval, Quit
- [x] Notifications when a provider crosses the configured % of its 5-hour window
      (deduped per reset window)

## Deliberately dropped (decide if wanted)

The lean rewrite is rate-limits only. These features from the first prototype have no backend anymore:

- **Claude Code local spend** — the JSONL parser (`~/.claude/projects/**/*.jsonl`) that produced
  today/month cost, token counts, cache hit rate, session count and the 7-day sparkline is gone.
  If wanted, fold into `ProviderUsage` as optional cost fields (only the `claude` provider fills them).
- **Cursor prorated budget** — manual monthly-cost estimate, no API.
- **OpenAI platform API spend** — endpoint changed/dead even before the rewrite.

## Remaining work 🔜

### Polish
- [ ] Real tray/menu bar icon (16×16 template PNG, dark-mode safe); currently default Tauri icon
- [ ] Launch at login via `tauri-plugin-autostart`
- [ ] Rename package from `tauri-app` to `ai-usage-monitor`
- [ ] Git init + private remote when this graduates from testing

### Features
- [ ] Antigravity — investigate local Google OAuth storage, then implement `fetch_antigravity()`
- [ ] Optional: bring back Claude Code cost data (see above) as a secondary line on the Claude card

## Notes

- Build cache gotcha: `target/` embeds absolute paths. If the project moves (e.g. old `/hub/...`
  location), run `cargo clean` or the tauri build script fails reading permission files from the
  stale path.
- Keychain service names: Claude = `Claude Code-credentials`; Codex reads `~/.codex/auth.json`.
