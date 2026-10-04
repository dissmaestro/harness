import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/core/loop.ts";
import { findSession, readSession, sanitizeHistory } from "../src/core/sessions.ts";
import { loadSettings as loadSettingsFull } from "../src/core/settings.ts";
import { looksTruncated } from "../src/providers/toolcall-parse.ts";
import { loadRegistry } from "../src/registry/load.ts";
import type { Message } from "../src/types.ts";
import { call, fakeServer, noWarn, put, silentUI, tempDir, text, type Reply } from "./helpers.ts";

const FAST_RETRY = { maxSeconds: 20, firstByteSeconds: 5, idleSeconds: 2 };

async function setup(url: string, extra: Record<string, unknown> = {}) {
  const home = tempDir();
  const cwd = tempDir();
  const settings = { ...loadSettingsFull(cwd, home), builtins: false, baseUrl: url, permissionMode: "yolo" as const, retry: FAST_RETRY, ...extra };
  const registry = await loadRegistry(cwd, settings, noWarn, home);
  return { home, cwd, settings, registry };
}

const cutOff = (name: string, partialArgs: string): Reply => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "cut", type: "function", function: { name, arguments: partialArgs } }] } }] },
  { choices: [{ delta: {}, finish_reason: "length" }] },
];

test("looksTruncated tells cut-off JSON from sloppy JSON", () => {
  assert.equal(looksTruncated('{"file_path":"a.ts","content":"line1\\nline2 half'), true);
  assert.equal(looksTruncated('{"a": [1, 2'), true);
  assert.equal(looksTruncated('{"a": 1,}'), false);
  assert.equal(looksTruncated('{"a": 1}'), false);
});

test("a 503 from the server is retried and the turn succeeds", async () => {
  const srv = await fakeServer([{ status: 503, body: { error: { message: "Loading model" } } }, text("ok after retry")]);
  try {
    const { cwd, settings, registry, home } = await setup(srv.url);
    const agent = new Agent({ cwd, settings, registry, home });
    const log: string[] = [];
    assert.equal(await agent.send("hi", silentUI(log), new AbortController().signal), "ok after retry");
    assert.equal(srv.requests.length, 2);
    assert.ok(log.some((l) => /retry 1/.test(l)), log.join("\n"));
  } finally {
    srv.close();
  }
});

test("a connection dropped mid-answer is regenerated", async () => {
  let n = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "GET") return res.end("{}");
    for await (const _ of req);
    n++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (n === 1) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "half an ans" } }] })}\n\n`);
      setTimeout(() => res.socket?.destroy(), 20); // server crash
      return;
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "full answer" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { cwd, settings, registry, home } = await setup(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    const agent = new Agent({ cwd, settings, registry, home });
    const log: string[] = [];
    assert.equal(await agent.send("hi", silentUI(log), new AbortController().signal), "full answer");
    assert.equal(n, 2);
    assert.ok(log.some((l) => /retry/.test(l)));
  } finally {
    server.close();
  }
});

test("a stalled stream times out and is retried", async () => {
  let n = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "GET") return res.end("{}");
    for await (const _ of req);
    n++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (n === 1) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "..." } }] })}\n\n`);
      return; // never finishes
    }
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { cwd, settings, registry, home } = await setup(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, { retry: { ...FAST_RETRY, idleSeconds: 0.3 } });
    const agent = new Agent({ cwd, settings, registry, home });
    assert.equal(await agent.send("hi", silentUI([]), new AbortController().signal), "recovered");
    assert.equal(n, 2);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("non-retryable errors are not retried", async () => {
  const srv = await fakeServer([{ status: 401, body: { error: { message: "bad key" } } }, text("never")]);
  try {
    const { cwd, settings, registry, home } = await setup(srv.url);
    const agent = new Agent({ cwd, settings, registry, home });
    await assert.rejects(agent.send("hi", silentUI([]), new AbortController().signal), /HTTP 401/);
    assert.equal(srv.requests.length, 1);
  } finally {
    srv.close();
  }
});

test("a tool call cut off by the token limit is not executed", async () => {
  const srv = await fakeServer([cutOff("Write", '{"file_path":"big.txt","content":"line1\\nline2 ha'), text("I will retry in pieces.")]);
  try {
    const { cwd, settings, registry, home } = await setup(srv.url);
    const agent = new Agent({ cwd, settings, registry, home });
    const log: string[] = [];
    await agent.send("write big.txt", silentUI(log), new AbortController().signal);
    assert.equal(existsSync(join(cwd, "big.txt")), false, "truncated Write must not run");
    const tool = srv.requests[1].messages.find((m: any) => m.role === "tool");
    assert.match(tool.content, /token limit/);
  } finally {
    srv.close();
  }
});

test("a text answer cut off by the token limit is continued", async () => {
  const srv = await fakeServer([
    [{ choices: [{ delta: { content: "first half" } }] }, { choices: [{ delta: {}, finish_reason: "length" }] }],
    text("second half"),
  ]);
  try {
    const { cwd, settings, registry, home } = await setup(srv.url);
    const agent = new Agent({ cwd, settings, registry, home });
    assert.equal(await agent.send("explain", silentUI([]), new AbortController().signal), "first half\nsecond half");
    assert.match(srv.requests[1].messages.at(-1).content, /cut off/);
  } finally {
    srv.close();
  }
});

test("an empty reply gets one nudge", async () => {
  const srv = await fakeServer([text(""), text("real answer")]);
  try {
    const { cwd, settings, registry, home } = await setup(srv.url);
    const agent = new Agent({ cwd, settings, registry, home });
    assert.equal(await agent.send("hi", silentUI([]), new AbortController().signal), "real answer");
    assert.match(srv.requests[1].messages.at(-1).content, /empty/);
  } finally {
    srv.close();
  }
});

test("the same call repeated: warning at 3, turn ends with a final answer at 5", async () => {
  const same = () => call("Glob", { pattern: "*.nothing" });
  const srv = await fakeServer([same(), same(), same(), same(), same(), text("I could not find it."), text("unused")]);
  try {
    const { cwd, settings, registry, home } = await setup(srv.url);
    const agent = new Agent({ cwd, settings, registry, home });
    const log: string[] = [];
    assert.equal(await agent.send("find", silentUI(log), new AbortController().signal), "I could not find it.");
    const tools = srv.requests[3].messages.filter((m: any) => m.role === "tool");
    assert.match(tools[2].content, /exact Glob call 3 times/);
    assert.ok(log.some((l) => /repeated the same Glob call 5 times/.test(l)));
    assert.equal(srv.requests[5].messages.at(-1).role, "user");
    assert.match(srv.requests[5].messages.at(-1).content, /Do not call any more tools/);
  } finally {
    srv.close();
  }
});

test("running out of steps forces a final report", async () => {
  const srv = await fakeServer([call("Glob", { pattern: "a*" }), call("Glob", { pattern: "b*" }), text("Report: nothing found."), text("unused")]);
  try {
    const { cwd, settings, registry, home } = await setup(srv.url);
    const agent = new Agent({ cwd, settings, registry, home, maxSteps: 3 });
    assert.equal(await agent.send("search", silentUI([]), new AbortController().signal), "Report: nothing found.");
    // the 3rd request is the final one: it asks for a report instead of more tool calls
    assert.equal(srv.requests.length, 3);
    assert.match(srv.requests[2].messages.at(-1).content, /used all 3 steps/);
  } finally {
    srv.close();
  }
});

test("a failing subagent hands back its partial progress", async () => {
  const srv = await fakeServer([
    call("Agent", { subagent_type: "scout", prompt: "look", description: "look" }),
    call("Read", { file_path: "a.txt" }),
    { status: 400, body: { error: { message: "template error" } } }, // subagent's 2nd request dies
    text("Continuing myself."),
  ]);
  try {
    const { cwd, settings, registry, home } = await setup(srv.url);
    put(cwd, "a.txt", "x\n");
    put(cwd, ".agent/agents/scout.md", "---\nname: scout\ndescription: looks\ntools: Read\n---\nBe brief.");
    const registry2 = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry: registry2, home });
    assert.equal(await agent.send("go", silentUI([]), new AbortController().signal), "Continuing myself.");
    const tool = srv.requests[3].messages.find((m: any) => m.role === "tool");
    assert.match(tool.content, /scout subagent failed/);
    assert.match(tool.content, /Read\(/);
    void registry;
  } finally {
    srv.close();
  }
});

test("sessions: journal survives, restore repairs the history", async () => {
  const srv = await fakeServer([call("Read", { file_path: "a.txt" }), text("done"), text("second turn")]);
  try {
    const { cwd, settings, registry, home } = await setup(srv.url);
    put(cwd, "a.txt", "x\n");
    const agent = new Agent({ cwd, settings, registry, home, persist: true });
    await agent.send("read a.txt", silentUI([]), new AbortController().signal);
    const saved = findSession(cwd, "latest", home);
    assert.ok(saved, "session file written");
    assert.equal(saved!.title, "read a.txt");
    assert.deepEqual(readSession(saved!.file).map((m) => m.role), ["user", "assistant", "tool", "assistant"], "the system prompt is rebuilt on restore, not saved");

    const resumed = new Agent({ cwd, settings, registry, home, persist: true });
    resumed.loadSession(saved!.file, saved!.id);
    assert.equal(await resumed.send("more", silentUI([]), new AbortController().signal), "second turn");
    const last = srv.requests[2].messages;
    assert.deepEqual(last.map((m: any) => m.role), ["system", "user", "assistant", "tool", "assistant", "user"]);
    assert.match(last.at(-1).content, /restored from a saved session/);
    assert.equal(readSession(saved!.file).length, 6, "resumed turn is appended to the same journal");
  } finally {
    srv.close();
  }
});

test("sanitizeHistory closes dangling tool calls and merges user messages", () => {
  const h: Message[] = [
    { role: "system", content: "s" },
    { role: "user", content: "a" },
    { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "user", content: "b" },
    { role: "user", content: "c" },
    { role: "tool", tool_call_id: "zzz", content: "orphan" },
    { role: "assistant", content: "" },
  ];
  const out = sanitizeHistory(h);
  assert.deepEqual(out.map((m) => m.role), ["system", "user", "assistant", "tool", "user"]);
  assert.equal((out[4] as any).content, "b\n\nc");
});
