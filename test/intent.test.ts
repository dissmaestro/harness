import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { classifyIntent } from "../src/core/intent.ts";
import { Agent } from "../src/core/loop.ts";
import { loadSettings } from "../src/core/settings.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { call, fakeServer, noWarn, silentUI, tempDir, text } from "./helpers.ts";

test("intent: explicit 'don't change anything' is read-only, constraints inside a task are not", () => {
  const readonly = [
    "посмотри что в конфиге, ничего не трогай",
    "Ничего не меняй, просто скажи почему падает",
    "почему падает тест? не трогай код",
    "глянь src/app.ts и только ответь",
    "просто посмотри логи",
    "объясни как работает авторизация, без изменений",
    "не меняй ничего",
    "проверь сборку. не трогай!",
    "just answer: why does the build fail",
    "look at main.go but don't change anything",
    "read-only: list the endpoints",
    "explain this without modifying files",
  ];
  for (const t of readonly) assert.equal(classifyIntent(t), "readonly", t);
  const tasks = [
    "почини баг в парсере, не трогай тесты",
    "добавь эндпоинт /users, не меняй API старых",
    "fix the login bug but don't touch the tests",
    "перепиши функцию parse",
    "можешь исправить падающий тест?",
    "can you add a --json flag?",
  ];
  for (const t of tasks) assert.equal(classifyIntent(t), "task", t);
  for (const t of ["почему падает тест?", "как устроен модуль sessions", "where is the config parsed?", "что делает функция compact"]) {
    assert.equal(classifyIntent(t), "question", t);
  }
  assert.equal(classifyIntent("почему так?\n\n<stdin>\nне трогай\n</stdin>"), "question", "pasted text doesn't count");
});

test("a read-only message: edits are refused even in auto mode; a question gets the reminder only", async () => {
  const srv = await fakeServer([
    call("Read", { file_path: "a.txt" }),
    call("Write", { file_path: "a.txt", content: "changed\n" }),
    text("It says hello."),
    text("Because of X."),
  ]);
  try {
    const cwd = tempDir();
    const home = tempDir();
    writeFileSync(join(cwd, "a.txt"), "hello\n");
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url, permissionMode: "auto" as const, repoMap: false as const };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    const log: string[] = [];
    await agent.send("что в a.txt? ничего не трогай", silentUI(log), new AbortController().signal);
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "hello\n");
    assert.match(String(srv.requests[0].messages.at(-1).content), /NOT to change anything/);
    const denied = agent.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    assert.match(denied[1], /Not run: Write would change something, and the user asked not to change anything/);
    assert.ok(log.some((l) => /read-only for this message/.test(l)));

    await agent.send("почему так?", silentUI([]), new AbortController().signal);
    assert.equal(agent.turnReadOnly, false);
    assert.match(String(srv.requests.at(-1).messages.findLast((m: any) => m.role === "user").content), /The user's message is a question/);
  } finally {
    srv.close();
  }
});

test("/ask forces read-only for one message", async () => {
  const srv = await fakeServer([call("Bash", { command: "rm -f a.txt" }), text("no"), call("Bash", { command: "rm -f a.txt" }), text("done")]);
  try {
    const cwd = tempDir();
    const home = tempDir();
    writeFileSync(join(cwd, "a.txt"), "x\n");
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url, permissionMode: "yolo" as const, repoMap: false as const, checkpoints: false };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    agent.forceReadOnly = true;
    await agent.send("clean up", silentUI([]), new AbortController().signal);
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "x\n", "even yolo can't change anything in a read-only message");
    await agent.send("clean up", silentUI([]), new AbortController().signal);
    assert.throws(() => readFileSync(join(cwd, "a.txt")), "the next message is a normal task again");
  } finally {
    srv.close();
  }
});
