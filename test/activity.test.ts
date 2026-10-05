import assert from "node:assert/strict";
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
