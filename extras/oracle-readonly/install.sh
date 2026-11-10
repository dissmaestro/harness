#!/usr/bin/env bash
# Installs the read-only Oracle skill into ~/.agent:
#   ~/.agent/skills/oracle/SKILL.md     skill (how to query, Oracle 12.1 syntax)
#   ~/.agent/scripts/oracle-query.sh    the only tool that talks to the DB (@readonly)
#   ~/.agent/oracle/                    oraquery.py, guard-hook.sh, venv with python-oracledb, connections.json
#   ~/.agent/settings.json              + PreToolUse hook that blocks sqlplus/oracledb in Bash and reading secrets
#
# Usage: ./install.sh                      (needs internet once for `pip install oracledb`)
#        ./install.sh --wheel oracledb.whl (offline: wheel downloaded elsewhere with `pip download oracledb`)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
agent="$HOME/.agent"
ora="$agent/oracle"
wheel=""
[[ "${1:-}" == "--wheel" ]] && wheel="${2:?path to the oracledb wheel}"

command -v python3 >/dev/null || { echo "python3 is required: sudo pacman -S python" >&2; exit 1; }
mkdir -p "$ora" "$agent/scripts" "$agent/skills/oracle"

install -m 755 "$here/oraquery.py"     "$ora/oraquery.py"
install -m 755 "$here/guard-hook.sh"   "$ora/guard-hook.sh"
install -m 755 "$here/oracle-query.sh" "$agent/scripts/oracle-query.sh"
install -m 644 "$here/SKILL.md"        "$agent/skills/oracle/SKILL.md"
echo "✓ files copied to $agent"

if [[ ! -x "$ora/venv/bin/python" ]]; then python3 -m venv "$ora/venv"; fi
if [[ -n "$wheel" ]]; then "$ora/venv/bin/pip" install -q "$wheel"; else "$ora/venv/bin/pip" install -q --upgrade oracledb; fi
echo "✓ python-oracledb $("$ora/venv/bin/python" -c 'import oracledb; print(oracledb.__version__)')"

conf="$ora/connections.json"
if [[ ! -f "$conf" ]]; then
  umask 077
  cat > "$conf" <<'JSON'
{
  "default": {
    "user": "AGENT_RO",
    "password": "CHANGE_ME",
    "dsn": "db-host:1521/SERVICE_NAME"
  }
}
JSON
  echo "✓ created $conf — fill in user/password/dsn"
fi
chmod 600 "$conf"

settings="$agent/settings.json"
hook_cmd="bash \$HOME/.agent/oracle/guard-hook.sh"
node_ok=0; command -v node >/dev/null && node_ok=1
if [[ $node_ok == 1 ]] && node -e '
  const fs = require("fs"), [file, cmd] = process.argv.slice(1);
  const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  s.hooks ??= {}; s.hooks.PreToolUse ??= [];
  const has = s.hooks.PreToolUse.some(m => (m.hooks || []).some(h => h.command === cmd));
  if (!has) s.hooks.PreToolUse.push({ matcher: "*", hooks: [{ type: "command", command: cmd }] });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
' "$settings" "$hook_cmd" 2>/dev/null; then
  echo "✓ guard hook registered in $settings"
else
  cat <<EOF
! Could not edit $settings automatically (it has comments, or node is missing).
  Add this to it by hand, inside "hooks":
    "PreToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "$hook_cmd" } ] } ]
EOF
fi

cat <<EOF

Next:
  1. Create a read-only DB user (README.md, section 1) — this is the main protection.
  2. Edit $conf
  3. Check: ARG_SQL="select user, sys_context('USERENV','DB_NAME') db from dual" $agent/scripts/oracle-query.sh
  4. In the agent: /oracle какие таблицы есть в схеме SCOTT?
EOF
