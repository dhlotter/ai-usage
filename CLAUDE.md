# Workflow

This is a distributed macOS app, not a website. No preview deploy, no staging
server. The loop is local build, review, PR, release.

## Day to day

1. Work on a branch off `main`, named `feat/...` or `fix/...`.
2. Commit locally as you go, no gate on this. Commit whenever a piece of work
   is done, even mid-feature.
3. Before pushing: `npx tsc --noEmit`, `cd src-tauri && cargo test`, and a real
   `npm run tauri build` you actually launch and click through. A type check
   and a test pass are not the same as having opened the popover.
4. Push the branch, open a PR into `main`.
5. Merge via **merge commit**, never squash. Commit messages here carry the
   why, not just the what. Squashing throws that away.
6. Delete the branch after merge.

## Cutting a release

Not every merge needs one. A real user-facing change does; an internal fix or
a docs change can wait for the next one that does.

1. Bump the version in three places, they must move together:
   `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
2. `npm run tauri build -- --target universal-apple-darwin` (Apple Silicon
   and Intel, both architectures, always).
3. `shasum -a 256` the `.dmg`.
4. `gh release create vX.Y.Z <dmg-path> --notes "..."`.

The checksum goes **in the release notes body as a bare 64-character hex
string**, not a separate file or field. `install.sh` finds it with a regex
over the notes text. Match the existing format
(`` `sha256  <hash>` ``) or the installer silently stops verifying.

`install.sh` always fetches whatever GitHub calls "latest", so publishing the
release is the entire "make it live" step. Nothing else to do after step 4.

## Signing

Ad-hoc signed, not notarised. An Apple Developer account is $99/year for a
free tool. `install.sh` sidesteps the Gatekeeper quarantine prompt this
causes because `curl` never sets `com.apple.quarantine`, the same way every
Homebrew cask install works. A browser download of the `.dmg` still hits the
prompt; that's expected, not a bug.

## Two real gotchas already hit once each

- `tauri.conf.json` must never declare a `trayIcon` block. Tauri auto-builds
  a second tray icon from it, one with no click handling wired up, alongside
  the one built in `setup()` in `lib.rs`.
- The window-focus-loss handler in `lib.rs` must stay scoped to the `main`
  window label. Unscoped, it hides the Settings window the instant you click
  into another app.
