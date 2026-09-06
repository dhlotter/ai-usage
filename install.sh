#!/bin/bash
#
# AI Usage installer.
#
#   curl -fsSL https://raw.githubusercontent.com/dhlotter/ai-usage/main/install.sh | bash
#
# Downloads the latest release, verifies it against the checksum published with
# that release, and installs it to /Applications.
#
# Why a script rather than a browser download: macOS Gatekeeper enforces on the
# com.apple.quarantine attribute, which browsers set and curl does not. The app
# is ad-hoc signed rather than notarised (an Apple Developer account is $99/yr
# for a free tool), so a browser download gets blocked and this does not. Nothing
# here disables or bypasses a security feature; the file is simply never
# quarantined, the same way every Homebrew formula install works.
#
# Read it first if you would rather not pipe a script from the internet to bash:
#   curl -fsSL https://raw.githubusercontent.com/dhlotter/ai-usage/main/install.sh | less

set -euo pipefail

REPO="dhlotter/ai-usage"
APP="AI Usage.app"
DEST="/Applications"
TMP="$(mktemp -d)"
MNT="$TMP/mnt"

cleanup() {
  [ -d "$MNT" ] && hdiutil detach "$MNT" -quiet 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "Error: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "AI Usage is macOS only."

echo "Finding the latest release..."
API="https://api.github.com/repos/$REPO/releases/latest"
DMG_URL="$(curl -fsSL "$API" | grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -1 | cut -d'"' -f4)"
[ -n "$DMG_URL" ] || fail "No .dmg asset found on the latest release."

TAG="$(curl -fsSL "$API" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)"
echo "Downloading $TAG..."
curl -fsSL -o "$TMP/app.dmg" "$DMG_URL" || fail "Download failed."

# The release notes carry the sha256 as a bare 64-char hex string. Verify when
# one is published, and say so plainly when there is nothing to check against
# rather than pretending the download was verified.
EXPECTED="$(curl -fsSL "$API" | grep -oE '\b[a-f0-9]{64}\b' | head -1 || true)"
ACTUAL="$(shasum -a 256 "$TMP/app.dmg" | cut -d' ' -f1)"
if [ -n "$EXPECTED" ]; then
  [ "$EXPECTED" = "$ACTUAL" ] || fail "Checksum mismatch. Expected $EXPECTED, got $ACTUAL. Not installing."
  echo "Checksum verified."
else
  echo "Note: no checksum published with this release, skipping verification."
fi

echo "Installing to $DEST..."
mkdir -p "$MNT"
hdiutil attach -nobrowse -quiet "$TMP/app.dmg" -mountpoint "$MNT" || fail "Could not mount the disk image."
[ -d "$MNT/$APP" ] || fail "The disk image does not contain $APP."

# Replacing a running app leaves the old process holding a deleted bundle, and
# the tray icon then stops responding with no visible cause.
if pgrep -f "$DEST/$APP" >/dev/null 2>&1; then
  echo "Quitting the running copy..."
  osascript -e 'quit app "AI Usage"' 2>/dev/null || pkill -f "$DEST/$APP" || true
  sleep 1
fi

rm -rf "${DEST:?}/$APP"
cp -R "$MNT/$APP" "$DEST/" || fail "Could not copy to $DEST. Try again, or install to ~/Applications."

echo
echo "Installed $TAG to $DEST/$APP"
echo "Starting it now. Look for the icon in your menu bar."
open "$DEST/$APP"
