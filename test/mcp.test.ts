import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadSettings as loadSettingsFull } from "../src/core/settings.ts";
const loadSettings = (cwd: string, home: string) => ({ ...loadSettingsFull(cwd, home), builtins: false });
import { loadRegistry } from "../src/registry/load.ts";
import { Registry } from "../src/registry/registry.ts";
import { McpClient } from "../src/registry/loaders/mcp.ts";
import { noWarn, put, tempDir } from "./helpers.ts";

const server = { command: process.execPath, args: [join(import.meta.dirname, "fixtures", "fake-mcp.mjs")] };

test("MCP tools are deferred, callable, and listed from cache on next start", async () => {
  const home = tempDir();
  const cwd = tempDir();
  const settings = { ...loadSettings(cwd, home), mcpServers: { fake: server } };
  const reg = await loadRegistry(cwd, settings, noWarn, home);
  try {
    const tool = reg.deferred.get("mcp__fake__echo");
    assert.ok(tool, "listed as deferred");
    assert.equal(tool.kind, "read", "readOnlyHint respected");
    assert.ok(existsSync(join(home, ".agent/cache/mcp/fake.json")), "tool list cached");
    const ctx = { cwd, registry: reg, signal: new AbortController().signal, readFiles: new Map() };
    assert.equal(await tool.run({ text: "hi" }, ctx), "echo: hi");
  } finally {
    reg.dispose();
  }

  // Second start: the server command is broken, but names still come from the cache (lazy start).
  const broken = { ...settings, mcpServers: { fake: { command: "/nonexistent/server" } } };
  const reg2 = await loadRegistry(cwd, broken, noWarn, home);
  try {
    const tool = reg2.deferred.get("mcp__fake__echo")!;
    assert.ok(tool);
    const ctx = { cwd, registry: reg2, signal: new AbortController().signal, readFiles: new Map() };
    await assert.rejects(tool.run({ text: "x" }, ctx), /failed to start/);
  } finally {
    reg2.dispose();
  }
});

test("a failing MCP server without cache only produces a warning", async () => {
  const home = tempDir();
  const cwd = tempDir();
  const warnings: string[] = [];
  const settings = { ...loadSettings(cwd, home), mcpServers: { bad: { command: "/nonexistent/server" } } };
  const reg: Registry = await loadRegistry(cwd, settings, (w) => warnings.push(w), home);
  reg.dispose();
  assert.equal(reg.deferred.size, 0);
  assert.match(warnings[0], /MCP server "bad"/);
});

// Fake server with a "hang" tool that never answers; logs its starts and cancellations.
const HANGING_SERVER = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.argv[2];
appendFileSync(log, "start " + process.pid + "\\n");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "notifications/cancelled") appendFileSync(log, "cancelled " + msg.params.requestId + "\\n");
  if (msg.id === undefined) return;
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "h", version: "1" } } });
  else if (msg.method === "tools/call" && msg.params.name === "hang") {}
  else if (msg.method === "tools/call") send({ id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
});
`;

test("MCP: a failed start is retried on the next call", async () => {
  const dir = tempDir();
  const script = put(dir, "flaky.sh", `#!/bin/sh\nif [ -f "${dir}/started" ]; then exec "${process.execPath}" "${server.args[0]}"; fi\ntouch "${dir}/started"; exit 1\n`, true);
  const client = new McpClient("flaky", { command: script });
  try {
    await assert.rejects(client.callTool("echo", { text: "a" }), /exited/);
    assert.equal(client.started, false, "failed start is forgotten");
    assert.equal(await client.callTool("echo", { text: "b" }), "echo: b");
  } finally {
    client.close();
  }
});

test("MCP: abort cancels the call; a timeout restarts the server", async () => {
  const dir = tempDir();
  const log = join(dir, "log");
  const file = put(dir, "hang.mjs", HANGING_SERVER);
  const client = new McpClient("h", { command: process.execPath, args: [file, log] });
  try {
    const ac = new AbortController();
    const call = client.callTool("hang", {}, ac.signal);
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(call, /aborted/);
    assert.equal(await client.callTool("other", {}), "ok", "same server still works");
    assert.match(readFileSync(log, "utf8"), /cancelled \d+/);

    await assert.rejects((client as any).request("tools/call", { name: "hang", arguments: {} }, 100), /timed out/);
    assert.equal(client.started, false, "timed-out server is dropped");
    assert.equal(await client.callTool("other", {}), "ok");
    assert.equal(readFileSync(log, "utf8").match(/^start/gm)!.length, 2, "server was restarted");
  } finally {
    client.close();
  }
});
