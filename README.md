# agent

CLI-агент для программирования на локальных моделях (llama.cpp, Ollama, vLLM, LM Studio).
Устроен как Claude Code: в контексте лежат только имена возможностей, а модель сама находит
и загружает нужное. Поэтому контекст не забивается, сколько бы скиллов и инструментов ни было.

Зависимостей нет. Нужен Node ≥ 23.6 (он запускает TypeScript напрямую) или Bun, а также `rg` (ripgrep).

## Запуск

```bash
# 1. Модель. llama.cpp (--jinja включает тулколлы):
llama-server -m Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf --jinja -c 65536 --port 8081
#    или Ollama: AGENT_BASE_URL=http://localhost:11434/v1 AGENT_MODEL=qwen3-coder:30b

# 2. Агент
AGENT_BASE_URL=http://localhost:8081/v1 node src/cli.ts          # интерактивно
node src/cli.ts -p "почини падающий тест" --accept-edits          # одна задача, без вопросов о правках
npm link                                                          # команда `agent` везде
```

Попробовать на готовом примере: `cd examples/demo && node ../../src/cli.ts`.

## Как экономится контекст

| Что | Всегда в контексте | Загружается по требованию |
|---|---|---|
| Базовые инструменты `Read Write Edit Bash Grep Glob Skill ToolSearch UseTool` | полные схемы | — |
| **Скиллы** `skills/<name>/SKILL.md` | `имя: описание` (≤120 символов) | текст инструкции через `Skill` |
| **Отложенные инструменты**: скрипты, плагины, MCP | только **имя** | схема через `ToolSearch` |

1. Список скиллов и имён инструментов отправляется в `<system-reminder>` первого сообщения и потом
   только при изменениях.
2. Модель вызывает `ToolSearch("select:db-migrate")` или `ToolSearch("database migration")`
   (BM25-поиск) и получает схему в блоке `<functions>`.
3. Модель вызывает его через `UseTool({"name": "db-migrate", "arguments": {...}})`. Если вызвать
   раньше, чем загружена схема, она получит подсказку «сначала ToolSearch».

**Почему `UseTool`, а не вызов по имени, как в Claude Code.** llama-server ограничивает тулколлы
грамматикой: модель может вызвать только инструмент из списка `tools` в запросе. Проверено:
попытка вызвать `hello`, которого нет в списке, превратилась в вызов `Bash`. Поэтому все
отложенные инструменты вызываются через один постоянный `UseTool`. На серверах без такого
ограничения вызов по имени тоже работает.

**Почему список инструментов в запросе не меняется.** В llama.cpp список tools вшит в начало
промпта. Если его изменить, весь контекст будет пересчитываться на каждом шаге. Поэтому схемы
дописываются в конец истории, а начало промпта остаётся одинаковым, и KV-кэш переиспользуется.
Тест `test/loop.test.ts` это проверяет.

С 25 скиллами и 25 отложенными инструментами постоянная часть контекста около 2.4k токенов.

## Проверено на реальной модели

Qwen3.6-35B-A3B (UD-Q4_K_XL) на RTX 3050 8 GB + 32 GB RAM через llama-server
(`-c 65536 -fit on -b 4096 -ub 4096 --spec-type draft-mtp -ctk q8_0 -ctv q8_0`):
обработка промпта ~700 ток/с, генерация 32–45 ток/с. Задачи в `examples/demo`: найти TODO
(ToolSearch → скрипт, 16 с), создать миграцию (скрипт + Write, 38 с), исправить код с проверкой
хуком (19 с), закоммитить по скиллу `commit` (49 с). Между шагами сервер считает только новые
токены (~150), остальное берётся из кэша.

## Где что лежит

Папки ищутся в `~/.agent/` и `<проект>/.agent/` (проектные важнее). Для совместимости с Claude Code
читаются `~/.claude/` и `.claude/`: оттуда берутся skills, commands и `CLAUDE.md`.

```
.agent/
  settings.json          настройки и хуки
  skills/<name>/SKILL.md скиллы (формат Claude Code)
  commands/<name>.md     слэш-команды: /name аргументы ($ARGUMENTS, $1…)
  scripts/*.sh           bash-скрипты → отложенные инструменты
  plugins/*.ts           TS-модули → отложенные инструменты (export default Tool | Tool[])
AGENTS.md                инструкции проекта (всегда в контексте)
```

### Скрипт как инструмент

```bash
#!/usr/bin/env bash
# @name: db-migrate
# @description: Create a new timestamped SQL migration file
# @tags: database, sql, migration
# @arg name: string (required) — migration name
# @readonly                     ← (по желанию) запускать без подтверждения
```
Аргументы приходят позиционно (`$1`…) и в переменных `ARG_NAME`. Скрипты без `@description` игнорируются.

### settings.json

```json
{
  "baseUrl": "http://localhost:8081/v1",
  "model": "qwen3-coder",
  "temperature": 0.7,
  "permissionMode": "ask",
  "claudeCompat": true,
  "mcpServers": {
    "github": { "command": "github-mcp-server", "args": ["stdio"], "env": { "GITHUB_TOKEN": "…" } }
  },
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "./lint-changed.sh" }] }
    ]
  }
}
```

- `permissionMode`: `ask`, `acceptEdits` (правки без вопросов) или `yolo`. Чтение и инструменты
  с `@readonly`/`readOnlyHint` никогда не требуют подтверждения.
- **Хуки** (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`) работают как в Claude Code:
  получают JSON на stdin. Код выхода `2` блокирует действие, а stderr уходит модели. Для
  `UserPromptSubmit` stdout при коде `0` добавляется в контекст.
- **MCP** (stdio): инструменты называются `mcp__<server>__<tool>`. Список кэшируется в
  `~/.agent/cache/mcp/`, и при следующих запусках сервер стартует только при первом вызове.

## Возможности для слабых моделей

- Тулколлы, написанные текстом (`<tool_call>{…}`, Qwen3-Coder `<function=…>`), распознаются и выполняются.
- Сломанный JSON аргументов чинится, а `"5"` и `"true"` приводятся к нужным типам по схеме.
- `Edit` при неточном совпадении сравнивает строки без учёта отступов. Если и это не помогло,
  он показывает ближайший похожий фрагмент.
- `Edit` и `Write` требуют свежего `Read`, поэтому модель не правит файл вслепую.
- Блоки `<think>…</think>` не сохраняются в историю.

## Режимы, план, интернет, субагенты, сжатие

- **Режимы** (Shift+Tab по кругу, `--mode`, `/mode`): `ask` → `acceptEdits` → `plan` → `auto`, плюс `yolo`.
  Команды «только чтение» (`ls`, `git status`, `rg`…) никогда не требуют подтверждения. В `auto`
  спрашивается только опасное (`sudo`, `rm -rf /`, `git push --force`, `curl | sh`…) и правки вне проекта.
  Политика — `src/core/modes.ts`.
- **План** (`/plan задача`, `--plan`): модель только читает, затем `ExitPlanMode` показывает план в рамке;
  после утверждения режим переключается и начинается работа.
- **Интернет**: `WebSearch` (Bing без ключа / SearXNG / Brave) и `WebFetch` (HTML → markdown, постранично).
  Это отложенные инструменты.
- **Субагенты** (`Agent`): отдельный контекст, наружу возвращается только отчёт. Встроенные: `explore`,
  `web-researcher` (оба только для чтения) и `general-purpose`. Свои — `agents/*.md` в формате Claude Code.
- **Сжатие**: автоматически при 80% контекста (размер берётся из `/props` llama-server), при ошибке
  переполнения от сервера и вручную через `/compact [фокус]`. Запрос на пересказ дописывается к
  текущей истории, поэтому сервер берёт её из кэша.
- **Встроенные скиллы** (`skills/`): commit, code-review, debug, write-tests, refactor, web-research,
  explain-codebase. Отключаются через `"builtins": false`.
- **Интерфейс**: значок режима в приглашении, спиннер, markdown, diff правок, чеклист `TodoWrite`,
  строка статуса (контекст в %, ток/с).

## REPL

`/help`, `/mode`, `/plan`, `/auto`, `/compact`, `/context`, `/clear`, `/skills`, `/agents`, `/tools`,
`/commands`, `/thinking`, `/exit`, `/<skill> args`, `/<command> args`. Ctrl+C прерывает ответ.

## Разработка

```bash
npm test          # node --test (фейковые OpenAI- и MCP-серверы, реальная модель не нужна)
npm run typecheck # нужен npm install
```

Код: `src/core/loop.ts` (цикл агента, субагенты, сжатие), `src/core/modes.ts` (режимы и разрешения),
`src/registry/` (реестр, поиск, загрузчики), `src/tools/` (инструменты), `src/web/` (поиск, HTML → текст),
`src/ui/` (REPL, markdown, спиннер), `src/providers/` (API и разбор тулколлов).
Полная документация: `~/Docs/Docs/local-ai/`.

## Что дальше

Чекпоинты и undo, LSP-диагностика, параллельные субагенты (нужен `--parallel 2 --kv-unified` на сервере).
