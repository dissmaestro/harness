#!/usr/bin/env python3
"""Read-only query runner for Oracle Database (12.1+), used by the `oracle-query` agent tool.

Protection layers (the first one is the real guarantee, the rest are a safety net):
  1. Connect as a DB user that has only SELECT / READ grants (see README.md).
  2. The statement is checked here: exactly one SELECT or WITH ... SELECT,
     no PL/SQL (WITH FUNCTION, BEGIN/DECLARE), no FOR UPDATE, no second statement.
  3. The session runs inside SET TRANSACTION READ ONLY and is always rolled back.

Input comes from env: ARG_SQL, ARG_MAX_ROWS, ARG_CONNECTION (set by the agent's script loader).
Connections: ~/.agent/oracle/connections.json (chmod 600), never shown to the model.
"""
import datetime
import decimal
import json
import os
import re
import stat
import sys

HOME = os.path.expanduser("~")
CONF_DIR = os.environ.get("AGENT_ORACLE_DIR", os.path.join(HOME, ".agent", "oracle"))
CONF_FILE = os.path.join(CONF_DIR, "connections.json")
DEFAULT_ROWS = 200
MAX_ROWS = 2000
MAX_CELL = 300
CALL_TIMEOUT_MS = 120_000
# Read-only system packages that are useful in SELECTs; any other DBMS_*/UTL_* is refused.
SAFE_PACKAGES = {"DBMS_LOB", "DBMS_METADATA", "DBMS_XPLAN"}


class Refused(Exception):
    pass


def code_only(sql: str) -> str:
    """Returns the SQL with comments removed and string/quoted-identifier contents blanked out,
    so keyword checks never trigger on (or get fooled by) text inside literals and comments."""
    out = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if c == "-" and nxt == "-":  # line comment
            j = sql.find("\n", i)
            i = n if j < 0 else j
            out.append(" ")
        elif c == "/" and nxt == "*":  # block comment (also /*+ hints */)
            j = sql.find("*/", i + 2)
            if j < 0:
                raise Refused("unterminated /* comment")
            i = j + 2
            out.append(" ")
        elif c in "qQ" and nxt == "'" and i + 2 < n and (i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] in "_$#")):
            # q'[...]' alternative quoting (also nq'...')
            open_ch = sql[i + 2]
            close_ch = {"[": "]", "{": "}", "(": ")", "<": ">"}.get(open_ch, open_ch)
            j = sql.find(close_ch + "'", i + 3)
            if j < 0:
                raise Refused("unterminated q'' literal")
            i = j + 2
            out.append("''")
        elif c == "'":
            j = i + 1
            while True:
                j = sql.find("'", j)
                if j < 0:
                    raise Refused("unterminated string literal")
                if j + 1 < n and sql[j + 1] == "'":
                    j += 2
                    continue
                break
            i = j + 1
            out.append("''")
        elif c == '"':
            j = sql.find('"', i + 1)
            if j < 0:
                raise Refused("unterminated quoted identifier")
            i = j + 1
            out.append('"x"')
        else:
            out.append(c)
            i += 1
    return "".join(out)


def check_sql(sql: str) -> str:
    """Returns the statement to execute (without the trailing ';' or '/') or raises Refused."""
    sql = sql.strip()
    # sqlplus-style terminators at the very end
    sql = re.sub(r"(\s*(;|\n\s*/))+\s*$", "", sql)
    if not sql:
        raise Refused("empty statement")
    code = code_only(sql)
    if ";" in code:
        raise Refused("only one statement is allowed (found ';' in the middle)")
    upper = re.sub(r"\s+", " ", code.upper()).strip()
    if not re.match(r"^\(*\s*(SELECT|WITH)\b", upper):
        raise Refused("only SELECT or WITH ... SELECT queries are allowed")
    if re.match(r"^WITH\s+(FUNCTION|PROCEDURE)\b", upper):
        raise Refused("WITH FUNCTION / PROCEDURE (inline PL/SQL) is not allowed")
    forbidden = [
        (r"\bFOR\s+UPDATE\b", "SELECT ... FOR UPDATE locks rows"),
        (r"\b(INSERT|UPDATE|DELETE|MERGE|UPSERT)\b", "DML keyword"),
        (r"\b(CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|COMMENT|AUDIT|ANALYZE|FLASHBACK|PURGE)\b", "DDL keyword"),
        (r"\b(BEGIN|DECLARE|EXECUTE|EXEC|CALL|COMMIT|ROLLBACK|SAVEPOINT|LOCK)\b", "PL/SQL or transaction control"),
    ]
    for pattern, why in forbidden:
        m = re.search(pattern, upper)
        if m:
            raise Refused(f"{why} is not allowed: {m.group(0)} (a column with this name must be written in double quotes)")
    for pkg in re.findall(r"\b(?:DBMS|UTL)_\w+", upper):
        if pkg not in SAFE_PACKAGES:
            raise Refused(f"system package {pkg} is not allowed (allowed: {', '.join(sorted(SAFE_PACKAGES))})")
    return sql


def load_connection(name: str) -> dict:
    if not os.path.exists(CONF_FILE):
        raise Refused(f"no connection config: create {CONF_FILE} (see README.md)")
    mode = stat.S_IMODE(os.stat(CONF_FILE).st_mode)
    if mode & 0o077:
        raise Refused(f"{CONF_FILE} is readable by others; run: chmod 600 {CONF_FILE}")
    with open(CONF_FILE, encoding="utf-8") as f:
        conns = json.load(f)
    if name not in conns:
        raise Refused(f"unknown connection '{name}'. Available: {', '.join(sorted(conns)) or 'none'}")
    c = dict(conns[name])
    if "password_env" in c:
        c["password"] = os.environ.get(c.pop("password_env"), "")
    return c


def fmt(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (bytes, bytearray)):
        s = "0x" + bytes(v[: MAX_CELL // 2]).hex()
    elif isinstance(v, (datetime.datetime, datetime.date)):
        s = v.isoformat(sep=" ") if isinstance(v, datetime.datetime) else v.isoformat()
    elif isinstance(v, decimal.Decimal):
        s = format(v, "f")
    else:
        s = str(v)
    s = s.replace("\t", " ").replace("\r", " ").replace("\n", "\\n")
    return s if len(s) <= MAX_CELL else s[:MAX_CELL] + "…"


def main() -> int:
    sql = os.environ.get("ARG_SQL") or (sys.argv[1] if len(sys.argv) > 1 else "")
    try:
        max_rows = int(os.environ.get("ARG_MAX_ROWS") or DEFAULT_ROWS)
    except ValueError:
        max_rows = DEFAULT_ROWS
    max_rows = max(1, min(max_rows, MAX_ROWS))
    conn_name = os.environ.get("ARG_CONNECTION") or "default"

    try:
        stmt = check_sql(sql)
    except Refused as e:
        print(f"REFUSED: {e}. This tool is read-only: send a single SELECT.", file=sys.stderr)
        return 3

    try:
        import oracledb
    except ImportError:
        print("python module 'oracledb' is missing; re-run extras/oracle-readonly/install.sh", file=sys.stderr)
        return 4

    try:
        c = load_connection(conn_name)
    except (Refused, ValueError) as e:
        print(f"CONFIG: {e}", file=sys.stderr)
        return 5

    oracledb.defaults.fetch_lobs = False  # CLOB/BLOB come back as str/bytes
    if c.get("thick") or os.environ.get("ORACLE_THICK"):
        # Thick mode (Instant Client) is needed only for very old password verifiers (DPY-3015).
        oracledb.init_oracle_client(lib_dir=c.get("lib_dir") or None)

    if c.get("password") in (None, "", "CHANGE_ME"):
        print(f"CONFIG: fill in user/password/dsn for '{conn_name}' in {CONF_FILE}", file=sys.stderr)
        return 5
    try:
        conn = oracledb.connect(user=c["user"], password=c["password"], dsn=c["dsn"])
    except (oracledb.Error, OSError) as e:
        print(f"CONNECT ({c.get('dsn')}): {e}", file=sys.stderr)
        return 1
    try:
        conn.autocommit = False
        conn.call_timeout = int(c.get("timeout_ms", CALL_TIMEOUT_MS))
        cur = conn.cursor()
        cur.execute("SET TRANSACTION READ ONLY")
        cur.arraysize = min(max_rows + 1, 500)
        cur.execute(stmt)
        if cur.description is None:
            print("(statement returned no result set)")
            return 0
        cols = [d[0] for d in cur.description]
        rows = cur.fetchmany(max_rows + 1)
        more = len(rows) > max_rows
        rows = rows[:max_rows]
        print("\t".join(cols))
        for r in rows:
            print("\t".join(fmt(v) for v in r))
        print(f"-- {len(rows)} row(s)" + (f"; more rows exist, raise max_rows (≤{MAX_ROWS}) or add WHERE/FETCH FIRST" if more else ""))
        return 0
    except oracledb.Error as e:
        print(f"ORACLE: {e}", file=sys.stderr)
        return 1
    finally:
        try:
            conn.rollback()
        finally:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
