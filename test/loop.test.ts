import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/core/loop.ts";
import { loadSettings as loadSettingsFull } from "../src/core/settings.ts";
const loadSettings = (cwd: string, home: string) => ({ ...loadSettingsFull(cwd, home), builtins: false });
import { loadRegistry } from "../src/registry/load.ts";
import { fakeServer, noWarn, put, silentUI, tempDir, text } from "./helpers.ts";

test("end to end: ToolSearch -> deferred script via text tool call -> hook -> answer", async () => {
  const srv = await fakeServer([
    // 1. native streamed tool call, arguments split across chunks
    [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "ToolSearch", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query": "select:db' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '-migrate"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ],
    // 2. Qwen3-Coder style call written as text (server didn't parse it)
    text("<tool_call>\n<function=db-migrate>\n<parameter=name>\nusers\n</parameter>\n</function>\n</tool_call>"),
    // 3. final answer
    text("Создал миграцию."),
  ]);
  try {
    const home = tempDir();
    const cwd = tempDir();
    put(
      cwd,
      ".agent/scripts/db-migrate.sh",
      '#!/usr/bin/env bash\n# @description: Create SQL migration\n# @arg name: string (required) — name\nmkdir -p migrations && touch "migrations/$1.sql" && echo "created $1"\n',
      true,
    );
    put(cwd, ".agent/skills/commit/SKILL.md", "---\ndescription: make commits\n---\nbody");
    put(
      cwd,
      ".agent/settings.json",
      JSON.stringify({
        baseUrl: srv.url,
        permissionMode: "ask",
        hooks: { PostToolUse: [{ matcher: "db-.*", hooks: [{ type: "command", command: "echo lint-feedback >&2; exit 2" }] }] },
      }),
    );
    const settings = loadSettings(cwd, home);
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    const log: string[] = [];
    const answer = await agent.send("создай миграцию users", silentUI(log), new AbortController().signal);

    assert.equal(answer, "Создал миграцию.");
    assert.deepEqual(log, ["start ToolSearch", "end ToolSearch", "start db-migrate", "end db-migrate"]);
    assert.deepEqual(readdirSync(join(cwd, "migrations")), ["users.sql"]);
    assert.equal(srv.requests.length, 3);

    // The catalog went to the user message as a system-reminder, with names only.
    const firstUser = srv.requests[0].messages[1].content as string;
    assert.match(firstUser, /<system-reminder>[\s\S]*- commit: make commits[\s\S]*db-migrate/);
    assert.doesNotMatch(firstUser, /"required"/);

    // Prompt-cache stability: identical tools every request; each request extends the previous one.
    for (const r of srv.requests.slice(1)) {
      assert.deepEqual(r.tools, srv.requests[0].tools);
      assert.ok(!r.tools.some((t: any) => t.function.name === "db-migrate"), "deferred tool never enters the tools list");
    }
    for (let i = 1; i < srv.requests.length; i++) {
      const prev = srv.requests[i - 1].messages;
      assert.deepEqual(srv.requests[i].messages.slice(0, prev.length), prev);
    }

    // The tool result carries script output plus PostToolUse hook feedback.
    const toolMsgs = srv.requests[2].messages.filter((m: any) => m.role === "tool");
    assert.match(toolMsgs[0].content, /<functions>/);
    assert.match(toolMsgs[1].content, /created users[\s\S]*lint-feedback/);
  } finally {
    srv.close();
  }
});

test("calling a deferred tool without ToolSearch returns a helpful error", async () => {
  const srv = await fakeServer([
    [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "hello", arguments: "{}" } }] } }] },
    ],
    text("ok"),
  ]);
  try {
    const home = tempDir();
    const cwd = tempDir();
    put(cwd, ".agent/scripts/hello.sh", "# @description: hi\necho hi\n");
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    const log: string[] = [];
    await agent.send("hi", silentUI(log), new AbortController().signal);
    assert.deepEqual(log, ["start hello", "end hello ERROR"]);
    const toolMsg = srv.requests[1].messages.find((m: any) => m.role === "tool");
    assert.match(toolMsg.content, /select:hello/);
  } finally {
    srv.close();
  }
});

test("catalog is re-sent only when it changes; denied calls are reported", async () => {
  const srv = await fakeServer([
    text("one"),
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "Bash", arguments: '{"command":"touch x"}' } }] } }] }],
    text("two"),
  ]);
  try {
    const home = tempDir();
    const cwd = tempDir();
    put(cwd, ".agent/skills/s/SKILL.md", "---\ndescription: d\n---\n");
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    const log: string[] = [];
    const ui = { ...silentUI(log), confirm: async () => "no" as const };
    await agent.send("first", ui, new AbortController().signal);
    await agent.send("second", ui, new AbortController().signal);
    const users = srv.requests[2].messages.filter((m: any) => m.role === "user");
    assert.match(users[0].content, /system-reminder/);
    assert.equal(users[1].content, "second");
    const toolMsg = srv.requests[2].messages.find((m: any) => m.role === "tool");
    assert.match(toolMsg.content, /denied/);
  } finally {
    srv.close();
  }
});

test("UseTool: calls a loaded deferred tool, arguments may be a JSON string; refuses unloaded tools", async () => {
  const call = (id: string, name: string, args: object) => [
    { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
  ];
  const srv = await fakeServer([
    call("c1", "UseTool", { name: "greet", arguments: { who: "early" } }),
    call("c2", "ToolSearch", { query: "select:greet" }),
    call("c3", "UseTool", { name: "greet", arguments: '{"who": "max"}' }),
    text("done"),
  ]);
  try {
    const home = tempDir();
    const cwd = tempDir();
    put(cwd, ".agent/scripts/greet.sh", '# @description: greet someone\n# @arg who: string (required) — name\necho "hi $1"\n');
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url, permissionMode: "yolo" as const };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    const log: string[] = [];
    assert.equal(await agent.send("greet max", silentUI(log), new AbortController().signal), "done");
    assert.deepEqual(log, ["start greet", "end greet ERROR", "start ToolSearch", "end ToolSearch", "start greet", "end greet"]);
    const tools = srv.requests[3].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    assert.match(tools[0], /not loaded yet/);
    assert.match(tools[1], /Call them with UseTool/);
    assert.equal(tools[2], "hi max");
  } finally {
    srv.close();
  }
});
