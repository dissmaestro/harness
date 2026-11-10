#!/usr/bin/env bash
# PreToolUse hook: the model must reach Oracle only through the read-only `oracle-query` tool.
# Blocks direct clients in Bash and reading/editing the connection secrets or the guard itself.
# Exit 2 = block (stderr goes to the model).
input=$(cat)
text=$(printf '%s' "$input" | tr '[:upper:]' '[:lower:]')

block() { echo "Blocked: $1. Use the read-only oracle-query tool (skill \"oracle\") for the database." >&2; exit 2; }

case "$text" in
  *'"tool_name":"bash"'*)
    # client binaries; `sql` (SQLcl) only when followed by a connect string like user/pw@db
    if printf '%s' "$text" | grep -Eq '(^|[^a-z0-9_.-])(sqlplus|sqlcl|tnsping|expdp|impdp|sqlldr|rman|dgmgrl)([^a-z0-9_.-]|$)|(^|[^a-z0-9_./-])sql[[:space:]]+[^[:space:]]*[/@]|oracledb|cx_oracle|jdbc:oracle'; then
      block "direct database access from Bash is not allowed"
    fi ;;
esac
if printf '%s' "$text" | grep -Eq 'connections\.json|\.agent/oracle/|oracle-query\.sh|guard-hook\.sh'; then
  block "the Oracle connection settings and guard files are off-limits"
fi
exit 0
