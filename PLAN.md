# Plan

What the README does not cover: what is left, and the decisions behind what is built.

## Left to do

### Before publishing
- [ ] **Decide on signing.** Unsigned means right-click → Open on first launch. It is also a
      real risk: an app that reads the Keychain, reads CLI auth files, and makes network calls
      is the same profile as [RateLimited](https://github.com/max2697/RateLimited), which
      XProtect deleted system-wide on this machine in September 2026. An Apple Developer
      account ($99/yr) plus notarization removes both problems.
- [ ] Public GitHub repo, push, tag a release with the universal `.dmg`
- [ ] Homebrew tap (`dhlotter/homebrew-tap`) with a cask pointing at the release
- [ ] LICENSE (MIT, if it is going out free)

### Nice to have
- [ ] More providers. Each one needs its own answer to "what does this vendor actually expose",
      not an assumption that it works like the last one.
- [ ] GLM's daily MCP tool counter (`TIME_LIMIT`), deliberately left out for now
- [ ] Tracking API spend in dollars, for people on API keys rather than subscriptions.
      A different product from tracking subscription windows, worth not conflating.

## Decisions worth remembering

**Used, not remaining.** ZCode and CodexBar both show "% left". This shows "% used" so the bar
fills and reddens toward the limit. Consistent across every provider.

**No CLI subprocesses.** CodexBar shells out to a real `claude` process per poll, which is why
it idles around 5% CPU with a watchdog process. This reads the stored credential and makes one
HTTPS call instead.

**Deliberately not busy.** The reason this exists rather than using CodexBar: pace forecasting,
deficit modelling, plan badges, cost tracking, reset credits and confetti are not settings you
can turn off there, they are the product. Adding metrics here should clear a high bar.

**Auth is per vendor, not a user preference.** See the README. A "choose your auth method"
setting would offer choices that mostly do not exist, and where they do, they silently change
what is being measured.

## Gotchas

- `target/` embeds absolute paths. If the project moves, `cargo clean` before building.
- The Z.ai quota endpoint returns **HTTP 200 on auth failure**, with the real status in the
  body as `code`/`success`. Check the body, not the status.
- `security -w` with no value reads the password from stdin and asks for it twice. Undocumented,
  so there is a test covering the round trip.
- Do not add a `trayIcon` block to `tauri.conf.json`. Tauri auto-builds a second, click-inert
  tray icon from it alongside the one built in `setup()`.
- The focus-loss handler must stay scoped to the `main` window, or the settings window hides
  itself the moment you click into another app.
