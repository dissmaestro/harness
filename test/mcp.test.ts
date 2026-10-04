import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadSettings as loadSettingsFull } from "../src/core/settings.ts";
const loadSettings = (cwd: string, home: string) => ({ ...loadSettingsFull(cwd, home), builtins: false });
import { loadRegistry } from "../src/registry/load.ts";
import { Registry } from "../src/registry/registry.ts";
import { noWarn, tempDir } from "./helpers.ts";

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
