import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/core/loop.ts";
import { loadSettings } from "../src/core/settings.ts";
import { detectChecks } from "../src/core/verify.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { call, fakeServer, noWarn, silentUI, tempDir, text } from "./helpers.ts";

async function agentWith(srvUrl: string, verify: object) {
  const cwd = tempDir();
  const home = tempDir();
  const settings = { ...loadSettings(cwd, home), baseUrl: srvUrl, permissionMode: "acceptEdits" as const, verify };
  const registry = await loadRegistry(cwd, settings, noWarn, home);
  return { cwd, agent: new Agent({ cwd, settings, registry, home }) };
}

test("verify: a failing test after the turn goes back to the model, which fixes it", async () => {
  const srv = await fakeServer([
    call("Write", { file_path: "out.txt", content: "broken\n" }),
    text("done"),
    call("Write", { file_path: "out.txt", content: "fixed\n" }),
    text("fixed it"),
  ]);
  try {
    const { cwd, agent } = await agentWith(srv.url, { lint: "true", test: "grep -q fixed out.txt || (echo 'expected fixed' && exit 1)" });
    const log: string[] = [];
    const answer = await agent.send("write it", silentUI(log), new AbortController().signal);
    assert.equal(readFileSync(join(cwd, "out.txt"), "utf8"), "fixed\n");
    assert.equal(srv.requests.length, 4);
    const report = srv.requests[2].messages.at(-1).content;
    assert.match(report, /Automatic verification after your changes failed: `grep -q fixed/);
    assert.match(report, /expected fixed/);
    assert.ok(log.some((l) => /verify: lint ✓, test ✓/.test(l)), log.join("\n"));
    assert.equal(answer, "fixed it");
  } finally {
    srv.close();
  }
});

test("verify: gives up after maxFixes; nothing runs when the turn changed nothing", async () => {
  const srv = await fakeServer([call("Write", { file_path: "a.txt", content: "x\n" }), text("1"), text("2"), text("3"), text("no changes")]);
  try {
    const { cwd, agent } = await agentWith(srv.url, { test: "exit 1", maxFixes: 2 });
    const log: string[] = [];
    const answer = await agent.send("go", silentUI(log), new AbortController().signal);
    assert.equal(srv.requests.length, 4, "the first answer plus 2 fix attempts");
    assert.match(answer, /test still fails/);
    assert.ok(log.some((l) => /still fails after 2 fix attempts/.test(l)));
    writeFileSync(join(cwd, "marker"), "");
    const before = srv.requests.length;
    await agent.send("just talk", silentUI([]), new AbortController().signal);
    assert.equal(srv.requests.length, before + 1, "no verification without changes");
  } finally {
    srv.close();
  }
});

test("detectChecks suggests commands from project files", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", typecheck: "tsc" } }));
  assert.deepEqual(detectChecks(dir), { test: "npm test", lint: "npm run typecheck" });
  const go = tempDir();
  writeFileSync(join(go, "go.mod"), "module x\n");
  assert.deepEqual(detectChecks(go), { test: "go test ./...", lint: "go vet ./..." });
});
