# Скилл `oracle`: Oracle 12.1 только на чтение

Агент получает один инструмент `oracle-query`, который выполняет **один SELECT** и возвращает строки.
Изменить базу через него нельзя. Защита в три слоя, и главный из них первый:

| Слой | Что делает | Почему не хватает одного его |
|---|---|---|
| 1. Пользователь БД только с `SELECT` | Oracle сам отказывает в любой записи (`ORA-01031`) | — это настоящая гарантия |
| 2. Проверка SQL в `oraquery.py` | Пропускает только `SELECT`/`WITH … SELECT`; запрещает `;` между запросами, DML, DDL, PL/SQL, `WITH FUNCTION`, `FOR UPDATE`, `DBMS_*`/`UTL_*` (кроме `DBMS_LOB`, `DBMS_METADATA`, `DBMS_XPLAN`) | функция с `AUTONOMOUS_TRANSACTION`, вызванная из SELECT, может писать — её остановит только слой 1 |
| 3. `SET TRANSACTION READ ONLY` + всегда `ROLLBACK` | DML внутри транзакции падает с `ORA-01456` | DDL делает неявный COMMIT и обходит это |
| + хук `guard-hook.sh` | Модели запрещено звать `sqlplus`/`sql`/`oracledb` из Bash и читать `connections.json` | без него модель могла бы пойти в базу мимо инструмента |

Пароль хранится в `~/.agent/oracle/connections.json` (права 600) и в контекст модели не попадает.

## 1. Пользователь только на чтение (делает DBA)

```sql
CREATE USER agent_ro IDENTIFIED BY "сложный_пароль";
GRANT CREATE SESSION TO agent_ro;

-- С 12.1.0.2 есть привилегия READ: как SELECT, но без SELECT … FOR UPDATE (блокировок).
-- На 12.1.0.1 её нет — используйте GRANT SELECT вместо GRANT READ.
-- Выдать на нужные таблицы/представления схемы APP:
BEGIN
  FOR t IN (SELECT object_name FROM all_objects
            WHERE owner = 'APP' AND object_type IN ('TABLE','VIEW')) LOOP
    EXECUTE IMMEDIATE 'GRANT READ ON APP."' || t.object_name || '" TO agent_ro';
  END LOOP;
END;
/
-- Или на всё сразу (шире, осторожно): GRANT READ ANY TABLE TO agent_ro;
-- Для словаря (all_tables/all_tab_columns видят и так только доступное):
-- GRANT SELECT_CATALOG_ROLE TO agent_ro;   -- по желанию, если нужны v$/dba_ представления

-- Чтобы тяжёлый запрос не положил прод: профиль с лимитами
CREATE PROFILE agent_ro_prof LIMIT SESSIONS_PER_USER 2 CPU_PER_CALL 6000 LOGICAL_READS_PER_CALL 5000000;
ALTER USER agent_ro PROFILE agent_ro_prof;
```

Не давайте этому пользователю `EXECUTE` на свои пакеты/функции, которые что-то пишут, и роли вроде `RESOURCE`/`DBA`.
`CPU_PER_CALL` работает, только если `RESOURCE_LIMIT = TRUE` (`ALTER SYSTEM SET resource_limit = TRUE`).

## 2. Установка

```bash
cd extras/oracle-readonly
./install.sh                         # нужен интернет один раз (pip install oracledb в ~/.agent/oracle/venv)
./install.sh --wheel oracledb-*.whl  # без интернета: колесо скачать на другой машине `pip download oracledb`
nano ~/.agent/oracle/connections.json
```

`connections.json` (можно несколько баз, модель выбирает аргументом `connection`):

```json
{
  "default": { "user": "AGENT_RO", "password": "…", "dsn": "db-host:1521/ORCLPDB" },
  "report":  { "user": "AGENT_RO", "password_env": "ORA_REPORT_PW", "dsn": "rep-host:1521/REP", "timeout_ms": 60000 }
}
```

Проверка без агента:

```bash
ARG_SQL="select user, sys_context('USERENV','DB_NAME') db from dual" ~/.agent/scripts/oracle-query.sh
ARG_SQL="delete from emp" ~/.agent/scripts/oracle-query.sh        # → REFUSED
```

В агенте: `/oracle какие таблицы есть в схеме APP?` или просто вопрос про данные — модель сама найдёт скилл.

## Проблемы

- **`DPY-3015: password verifier type 0x939 is not supported`** — у пользователя старый (10G) хеш пароля,
  тонкий режим его не умеет. Лучше: DBA пересоздаёт пароль (`ALTER USER agent_ro IDENTIFIED BY …`) при
  `SQLNET.ALLOWED_LOGON_VERSION_SERVER=11` или выше. Иначе: поставить Oracle Instant Client и добавить в
  подключение `"thick": true, "lib_dir": "/opt/oracle/instantclient_19_…"`.
- **`ORA-01031` / `ORA-00942`** — у `agent_ro` нет прав на объект: так и задумано, выдайте `READ` на нужное.
- **`REFUSED: DDL keyword … COMMENT`** — колонка называется как ключевое слово; модель должна писать её в
  двойных кавычках: `"COMMENT"`.
- Режим `yolo` хуки не отключает, но правки в `~/.agent/` в нём не спрашиваются — для работы с базой
  используйте `ask`/`auto`.
