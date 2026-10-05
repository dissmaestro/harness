#!/usr/bin/env bash
# Builds the Arch package from this checkout and installs it (command `agent`).
#
#   git clone https://github.com/dissmaestro/harness.git && cd harness && ./install.sh
#
#   ./install.sh                         dependencies, build, install, ~/.agent/settings.json, check
#   ./install.sh --server URL            model server for a new settings.json (default http://192.168.0.3:8081/v1)
#   ./install.sh --model NAME            model name (default qwen3.6)
#   ./install.sh --api-key KEY           API key for the server
#   ./install.sh --profile NAME          auto | qwen3.6 | qwen3 | none (for a model behind an alias, e.g. "smart")
#   ./install.sh --nocheck               skip the test suite while building
#   ./install.sh --no-install            only build the package
#   DRY_RUN=1 ./install.sh               show what would be done
# Update later: git pull && ./install.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="http://192.168.0.3:8081/v1"
MODEL="qwen3.6"
API_KEY=""
PROFILE=""
MAKEPKG_ARGS=()
INSTALL=1

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift ;;
    --model) MODEL="$2"; shift ;;
    --api-key) API_KEY="$2"; shift ;;
    --profile) PROFILE="$2"; shift ;;
    --nocheck) MAKEPKG_ARGS+=(--nocheck) ;;
    --no-install) INSTALL=0 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see ./install.sh --help)" >&2; exit 2 ;;
  esac
  shift
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
run() {
  if [ "${DRY_RUN:-0}" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi
}

command -v pacman >/dev/null || fail "pacman not found: this installer is for Arch Linux (elsewhere: npm link, see README)"
[ "$(id -u)" != 0 ] || fail "run it as your user, not root: makepkg refuses to build as root (sudo is asked for when needed)"

bold "1. Dependencies (nodejs, ripgrep, git, curl, base-devel for makepkg)"
run sudo pacman -S --needed --noconfirm nodejs ripgrep git curl base-devel
if [ "${DRY_RUN:-0}" != 1 ]; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>23||(a===23&&b>=6)?0:1)' \
    || fail "Node.js $(node -v) is too old: need 23.6+. Run: sudo pacman -Syu nodejs"
  ok "node $(node -v), $(rg --version | head -1)"
fi

VER="$(node -p 'require(process.argv[1]).version' "$HERE/package.json" 2>/dev/null || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json")"
PKG="$HERE/packaging/arch/local-agent-$VER-1-any.pkg.tar.zst"

bold "2. Build local-agent $VER (makepkg${MAKEPKG_ARGS[*]:+ ${MAKEPKG_ARGS[*]}}; the tests take ~15s)"
run bash "$HERE/packaging/arch/build.sh" "${MAKEPKG_ARGS[@]}"
[ "${DRY_RUN:-0}" = 1 ] || [ -f "$PKG" ] || fail "the build did not produce $PKG"
[ "${DRY_RUN:-0}" = 1 ] || ok "built $(basename "$PKG")"

if [ "$INSTALL" = 0 ]; then
  echo "  install it with: sudo pacman -U $PKG"
  exit 0
fi

bold "3. Install"
# no --needed: a rebuild of the same version must replace the installed files
run sudo pacman -U --noconfirm "$PKG"
[ "${DRY_RUN:-0}" = 1 ] || ok "installed: $(pacman -Q local-agent)"

bold "4. Settings ~/.agent/settings.json"
if [ -f "$HOME/.agent/settings.json" ]; then
  ok "already exists, left as is (edit it to change the server or model)"
else
  run mkdir -p "$HOME/.agent"
  json="{\n  \"baseUrl\": \"$SERVER\",\n  \"model\": \"$MODEL\""
  [ -n "$API_KEY" ] && json="$json,\n  \"apiKey\": \"$API_KEY\""
  [ -n "$PROFILE" ] && json="$json,\n  \"profile\": \"$PROFILE\""
  json="$json\n}\n"
  if [ "${DRY_RUN:-0}" = 1 ]; then
    printf '  [dry-run] write settings: baseUrl %s, model %s\n' "$SERVER" "$MODEL"
  else
    printf '%b' "$json" > "$HOME/.agent/settings.json"
    chmod 600 "$HOME/.agent/settings.json"
    ok "created: baseUrl $SERVER, model $MODEL${PROFILE:+, profile $PROFILE}"
  fi
fi

bold "5. Old alias"
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  if [ -f "$rc" ] && grep -qE "^\s*alias agent=" "$rc"; then
    warn "$rc has 'alias agent=…': it would shadow the installed command. Remove that line and run: source $rc"
  fi
done
ok "checked"

bold "Check"
[ "${DRY_RUN:-0}" = 1 ] && { echo "  dry run finished"; exit 0; }
ok "agent $(agent --version)"
BASE="$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((process.env.AGENT_BASE_URL||s.baseUrl||"").replace(/\/v1\/?$/,""))}catch{}' "$HOME/.agent/settings.json")"
if [ -n "$BASE" ] && { curl -fsS -m 5 "$BASE/health" >/dev/null 2>&1 || curl -fsS -m 5 "$BASE/v1/models" >/dev/null 2>&1; }; then
  ok "model server $BASE answers"
  if out="$(cd "$(mktemp -d)" && timeout 180 agent -p "Reply with exactly: OK" 2>/dev/null)"; then
    ok "test request answered: $(printf '%s' "$out" | tail -1 | cut -c1-60)"
  else
    warn "the server is up, but a test request failed: run  agent -p \"hi\"  to see the error"
  fi
else
  warn "model server ${BASE:-?} does not answer (or needs an API key). Is it on and reachable?"
fi

echo
bold "Done. Start in any project folder:"
echo "  cd ~/my-project && agent        (/help inside)"
echo "  update later:  cd $HERE && git pull && ./install.sh"
