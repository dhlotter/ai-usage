# AI Usage

A small macOS menu bar app showing how much of your AI coding limits you have used.
One icon, a percentage on hover, a click for the detail. Nothing else.

Built with Tauri 2, a Rust backend and a React/TypeScript frontend.

---

## What it does

- **Menu bar icon** with every provider's usage in the hover tooltip, and an optional countdown next to it
- **Click for a popover** with a bar per limit window, the used percentage, and a live reset countdown
- **Settings window** with General and Providers sections
- **Notifications** when a provider crosses a threshold you choose
- **Launch at login**

Usage is shown as **used**, not remaining, so the bar fills and turns red as you approach the limit.

---

## Providers

| Provider | Source | Credential | Windows shown |
|---|---|---|---|
| **Claude Code** | `api.anthropic.com/api/oauth/usage` | Keychain item Claude Code wrote (`Claude Code-credentials`) | 5-hour, weekly |
| **Codex** | `chatgpt.com/backend-api/wham/usage` | `~/.codex/auth.json` | 5-hour, weekly |
| **GLM** | `api.z.ai/api/monitor/usage/quota/limit` | Your Z.ai API key, in Settings | 5-hour |

### Why the credentials differ

These are not interchangeable auth methods, they are what each vendor allows.

Claude and Codex expose subscription limits only to their own CLI's stored credential.
Anthropic [banned third-party OAuth for subscription accounts in February 2026](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use),
and its API keys report organisation spend in dollars, which is a different measurement
entirely. So for those two, the app reads the credential the official CLI already stored.
Install and sign into the CLI once and they work with no further setup.

GLM is the opposite: ZCode's stored OAuth token is rejected by the quota endpoint, while a
normal Z.ai API key works. So GLM takes a key, entered in Settings and stored in the
Keychain as `ai-usage-glm`.

Keys only ever travel inward. The app can store one and report whether one exists, but never
reads a stored key back out to the frontend, and passes it to `security` over stdin rather
than on the command line where it would appear in the process list.

**These endpoints are undocumented.** They can change or be locked down without notice.

---

## Install

Requires macOS 14 or later. Universal, both Apple Silicon and Intel.

Download the `.dmg` from Releases, or build it yourself (below).

The app is not signed with an Apple Developer ID, so the first launch needs
right-click → Open rather than a double-click.

---

## Layout

```
src/
  main.tsx        Mounts App or Settings, chosen by window label
  App.tsx         Popover: the usage list
  Settings.tsx    Settings window: General and Providers
  shared.tsx      Types, provider table, settings storage, shared controls
  App.css         Palette and shared controls
  Settings.css    Settings window layout

src-tauri/src/
  lib.rs          Tray icon, popover positioning, settings window, autostart
  providers.rs    Fetching, caching, and API key storage
```

Both windows load the same bundle. `main.tsx` renders one or the other based on
`getCurrentWindow().label`. They keep separate React state and stay in sync over a
`settings-changed` Tauri event.

---

## Dev

```bash
npm install
npm run tauri dev
```

Run the tests:

```bash
cd src-tauri && cargo test
```

Build a universal release:

```bash
rustup target add x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

Output lands in `src-tauri/target/universal-apple-darwin/release/bundle/`.

---

## Notes

- Fetches run in parallel and start at launch rather than waiting for the webview,
  so the popover has content by the time you click it.
- Results are cached for 30s, with a 60s backoff on errors and a longer one when
  rate limited. Saving or clearing an API key clears that provider's cache so a
  correct key takes effect immediately.
- The tray icon is a template image, so macOS tints it for light and dark menu bars.
