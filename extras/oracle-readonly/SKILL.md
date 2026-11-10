---
name: oracle
description: Query the Oracle 12.1 database read-only (tables, columns, data). Use when the user asks about data or schema in Oracle.
---

You have READ-ONLY access to Oracle Database 12.1 through the `oracle-query` tool. You cannot and must not change anything in the database.

1. Load the tool once: ToolSearch `select:oracle-query`, then call it with UseTool: `{"name": "oracle-query", "arguments": {"sql": "SELECT ..."}}`.
2. Never use Bash, sqlplus, sqlcl or Python to reach the database, and never read `~/.agent/oracle/connections.json`. Only `oracle-query`.
3. One statement per call: `SELECT ...` or `WITH ... SELECT ...`. Refused: INSERT/UPDATE/DELETE/MERGE, DDL, PL/SQL blocks, `FOR UPDATE`, `WITH FUNCTION`, `;` between statements. If the user asks to change data, explain that access is read-only and, if useful, write the SQL for them to run themselves — do not try to work around the restriction.
4. Oracle 12.1 syntax: limit with `FETCH FIRST 50 ROWS ONLY` (or `WHERE ROWNUM <= 50`); no `LIMIT`, no `ILIKE`; boolean is not a SQL type; dates via `DATE '2024-01-01'` / `TO_DATE`. Identifiers are UPPERCASE unless created in double quotes. A column named like a keyword (COMMENT, LOCK…) must be written in double quotes.
5. Explore schema before guessing names:
   - tables: `SELECT owner, table_name, num_rows FROM all_tables WHERE owner = 'SCHEMA' ORDER BY table_name`
   - find a table: `SELECT owner, table_name FROM all_tables WHERE table_name LIKE '%PART%'`
   - columns: `SELECT column_name, data_type, data_length, nullable FROM all_tab_columns WHERE owner = 'S' AND table_name = 'T' ORDER BY column_id`
   - keys: `all_constraints` (P = primary, R = foreign) + `all_cons_columns`; indexes: `all_ind_columns`; views: `all_views`; comments: `all_tab_comments`, `all_col_comments`
   - DDL: `SELECT DBMS_METADATA.GET_DDL('TABLE', 'T', 'S') FROM dual`
6. Be cheap: always restrict rows (WHERE, FETCH FIRST), select only the needed columns, prefer `COUNT(*)`/aggregates over dumping tables. Avoid full scans of huge tables (check `num_rows` first).
7. Output is TSV with a header and a `-- N row(s)` footer; long values are cut at 300 chars. Answer the user with the result and show the SQL you ran.
