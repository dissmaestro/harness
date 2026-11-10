#!/usr/bin/env bash
# @name: oracle-query
# @description: Run ONE read-only SELECT on the Oracle 12.1 database and get rows as TSV. Any write/DDL/PL-SQL is refused.
# @tags: oracle, sql, database, db, select, query, table, schema
# @arg sql: string (required) — a single SELECT or WITH ... SELECT; Oracle 12.1 syntax (FETCH FIRST n ROWS ONLY works)
# @arg max_rows: integer — how many rows to return, default 200, at most 2000
# @arg connection: string — connection name from connections.json, default "default"
# @readonly
# Arguments arrive as ARG_SQL / ARG_MAX_ROWS / ARG_CONNECTION (env), so quoting in SQL is safe.
dir="$HOME/.agent/oracle"
exec "$dir/venv/bin/python" -I "$dir/oraquery.py"
