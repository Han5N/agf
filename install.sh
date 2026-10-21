#!/usr/bin/env bash
#
# curl -fsSL https://raw.githubusercontent.com/Han5N/agf/main/install.sh | bash -s -- [--client opencode|pi|claude-code]
#
set -euo pipefail

REPO="${AGF_REPO:-Han5N/agf}"
BRANCH="${AGF_BRANCH:-main}"
AGF_HOME="${AGF_HOME:-$HOME/.local/share/agf}"
BIN_DIR="${AGF_BIN_DIR:-$HOME/.local/bin}"

CLIENT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --client)
      CLIENT="${2:-}"
      [ -n "$CLIENT" ] || { echo "error: --client needs a value" >&2; exit 2; }
      shift 2
      ;;
    --client=*)
      CLIENT="${1#*=}"
      shift
      ;;
    -h|--help)
      echo "Usage: install.sh [--client opencode|pi|claude-code]"
      exit 0
      ;;
    *)
      echo "error: unknown argument $1" >&2
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js is required (https://nodejs.org)"
command -v npm  >/dev/null 2>&1 || die "npm is required (it ships with Node.js)"
command -v git  >/dev/null 2>&1 || die "git is required"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 or newer is required (found $(node -v))"

if [ -d "$AGF_HOME/.git" ]; then
  say "Updating $AGF_HOME"
  git -C "$AGF_HOME" fetch --depth 1 origin "$BRANCH" >/dev/null 2>&1
  git -C "$AGF_HOME" reset --hard "origin/$BRANCH" >/dev/null
else
  say "Cloning into $AGF_HOME"
  mkdir -p "$(dirname "$AGF_HOME")"
  git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$AGF_HOME" >/dev/null
fi

say "Installing dependencies"
( cd "$AGF_HOME" && npm install --no-audit --no-fund --loglevel=error >/dev/null )

say "Building"
( cd "$AGF_HOME" && npm run build --silent >/dev/null )

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/agf" <<WRAPPER
#!/bin/sh
exec node "$AGF_HOME/dist/cli.js" "\$@"
WRAPPER
chmod +x "$BIN_DIR/agf"

say ""
say "agf installed at $AGF_HOME"
say "command: $BIN_DIR/agf"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say ""
    say "Add this to your shell profile, then reopen the terminal:"
    say "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

if [ -n "$CLIENT" ]; then
  say ""
  say "Registering with $CLIENT"
  "$BIN_DIR/agf" setup --client "$CLIENT" --yes
  say ""
  say "Restart $CLIENT to load the MCP server and skill."
else
  say ""
  say "Next, register with your agent:"
  say "  agf setup --client opencode --yes"
  say "  agf setup --client pi --yes"
  say ""
  say "Then restart the agent."
fi
