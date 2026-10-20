#!/bin/sh
# Run Pricewatch in the background on macOS: starts at login, restarts if it crashes.
#   ./scripts/install-mac.sh          install (or update) and start
#   ./scripts/install-mac.sh --print  show the launchd file without installing
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LABEL=com.pricewatch
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/Pricewatch"

NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  echo "Node.js not found. Install it first: brew install node" >&2
  exit 1
fi
# process.loadEnvFile (used for .env) needs Node 20.12+.
if ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)'; then
  echo "Node $("$NODE" -v) is too old; Pricewatch needs 20.12 or newer (brew upgrade node)." >&2
  exit 1
fi

# Paths go into XML, so escape the three characters that matter there.
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$ROOT/server.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$ROOT")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOGS/pricewatch.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOGS/pricewatch.log")</string>
</dict>
</plist>
PLIST
}

if [ "${1:-}" = "--print" ]; then
  plist
  exit 0
fi

if [ "$(uname)" != "Darwin" ]; then
  echo "This installer is for macOS (launchd). Elsewhere, run: npm start" >&2
  exit 1
fi

if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "Created $ROOT/.env. Add your SERPAPI_KEY there for real prices (demo prices until then)."
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOGS" "$ROOT/data"
plist > "$PLIST"

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

# Port comes from .env (PORT=...), default 3737. Stop here if another program has it.
PORT=$(sed -n 's/^PORT=\([0-9][0-9]*\).*/\1/p' "$ROOT/.env" | tail -1)
PORT=${PORT:-3737}
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already used by another program (see: lsof -nP -iTCP:$PORT -sTCP:LISTEN)." >&2
  echo "Put a free port in $ROOT/.env, e.g. PORT=3838, then run this script again." >&2
  exit 1
fi

launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Pricewatch is running: http://127.0.0.1:$PORT"
echo "Logs: $LOGS/pricewatch.log"
echo "After editing .env, apply it with: launchctl kickstart -k $DOMAIN/$LABEL"
