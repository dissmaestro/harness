import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ActivityBoard, formatDuration } from "../src/core/activity.ts";
import { Agent } from "../src/core/loop.ts";
import { loadSettings } from "../src/core/settings.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { renderStatus } from "../src/ui/status.ts";
import { call, fakeServer, noWarn, silentUI, tempDir, text } from "./helpers.ts";

test("activity board: steps, tools, checklist and subagents are tracked", async () => {
  const srv = await fakeServer([
    call("Agent", { subagent_type: "explore", description: "find it", prompt: "find the config parser" }),
    call("TodoWrite", { todos: [{ content: "grep", status: "completed" }, { content: "read", status: "in_progress" }] }),
    text("report: it is in src/config.ts"),
    text("done"),
  ]);
  try {
    const home = tempDir();
    const cwd = tempDir();
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    const seen: string[] = [];
    const ui = {
      ...silentUI([]),
      onToolStart: () => seen.push(agent.board.snapshot()),
    };
    await agent.send("where is the config parsed?", ui, new AbortController().signal);

    const root = agent.board.root;
    assert.equal(root.state, "done");
    assert.equal(root.step, 2);
    assert.equal(root.tool, undefined);
    const [child] = root.children;
    assert.equal(child.label, "#1 explore");
    assert.equal(child.description, "find it");
    assert.equal(child.state, "done");
    assert.equal(child.todoProgress(), "1/2");
    assert.equal(child.currentTodo(), "read");
    assert.match(child.lastText, /src\/config.ts/);
    // while the subagent ran, the snapshot showed the main agent inside its Agent call
    assert.ok(seen.some((s) => /now running: Agent\(explore: find it\)/.test(s)), seen.join("\n---\n"));
    assert.match(agent.board.snapshot(), /#1 explore "find it": done/);
    assert.match(renderStatus(agent.board).replace(/\x1b\[[0-9;]*m/g, ""), /└ ✓ #1 explore "find it"  step 2\/30/);
  } finally {
    srv.close();
  }
});

test("a failed subagent is marked failed; a new turn forgets finished subagents", async () => {
  const srv = await fakeServer([
    call("Agent", { subagent_type: "explore", prompt: "x" }),
    { status: 400, body: { error: { message: "bad request" } } },
    text("the subagent failed"),
    text("second turn"),
  ]);
  try {
    const home = tempDir();
    const cwd = tempDir();
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    await agent.send("go", silentUI([]), new AbortController().signal);
    assert.equal(agent.board.root.children[0].state, "failed");
    await agent.send("again", silentUI([]), new AbortController().signal);
    assert.equal(agent.board.root.children.length, 0);
  } finally {
    srv.close();
  }
});

test("idle status and durations", () => {
  const board = new ActivityBoard("/", 60);
  assert.match(renderStatus(board), /Idle/);
  assert.equal(formatDuration(5_000), "5s");
  assert.equal(formatDuration(65_000), "1m05s");
  assert.equal(formatDuration(3_660_000), "1h01m");
});

test("steer: a note goes with the next tool result; a note during the final answer gets its own request", async () => {
  const srv = await fakeServer([call("Read", { file_path: "a.txt" }), text("first answer"), text("answer with the note")]);
  try {
    const home = tempDir();
    const cwd = tempDir();
    writeFileSync(join(cwd, "a.txt"), "hello\n");
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    let sentDuringText = false;
    const ui = {
      ...silentUI([]),
      onToolStart: () => assert.equal(agent.steer("use tabs"), true),
      onText: () => {
        if (!sentDuringText) sentDuringText = agent.steer("and add a test");
      },
    };
    const answer = await agent.send("go", ui, new AbortController().signal);
    const toolMsg = srv.requests[1].messages.find((m: any) => m.role === "tool");
    assert.match(toolMsg.content, /wrote this while you were working[\s\S]*- use tabs/);
    assert.equal(srv.requests.length, 3);
    assert.match(srv.requests[2].messages.at(-1).content, /- and add a test/);
    assert.equal(answer, "first answer\nanswer with the note");
    assert.equal(agent.steer("too late"), false, "nothing is running any more");
  } finally {
    srv.close();
  }
});

test("askAside: no tools, answer from the board, history untouched", async () => {
  const srv = await fakeServer([text("it is reading files")]);
  try {
    const home = tempDir();
    const cwd = tempDir();
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    const before = agent.messages.length;
    const a = await agent.askAside("what is going on?", new AbortController().signal);
    assert.equal(a, "it is reading files");
    assert.equal(agent.messages.length, before);
    assert.equal(srv.requests[0].tools, undefined);
    assert.match(srv.requests[0].messages[1].content, /Agents right now:[\s\S]*main[\s\S]*Question: what is going on\?/);
  } finally {
    srv.close();
  }
});
