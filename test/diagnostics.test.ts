import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Diagnostics } from "../src/core/diagnostics.ts";
import { Agent } from "../src/core/loop.ts";
import { loadSettings } from "../src/core/settings.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { call, fakeServer, noWarn, silentUI, tempDir, text } from "./helpers.ts";

test("diagnostics in the edit result: a broken JSON file, then the fix", async () => {
  const srv = await fakeServer([
    call("Write", { file_path: "cfg.json", content: '{"a": 1,,}\n' }),
    call("Write", { file_path: "cfg.json", content: '{"a": 1}\n' }),
    text("ok"),
  ]);
  try {
    const cwd = tempDir();
    const home = tempDir();
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url, permissionMode: "acceptEdits" as const };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    await agent.send("config", silentUI([]), new AbortController().signal);
    const results = agent.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    assert.match(results[0], /The edit was applied, but cfg\.json now has 1 error according to JSON\.parse:\n  cfg\.json:1:\d+ error: /);
    assert.match(results[1], /Diagnostics \(JSON\.parse\): cfg\.json has no errors now\./);
  } finally {
    srv.close();
  }
});

test("quick syntax checks: Python, JavaScript, shell", async () => {
  const cwd = tempDir();
  const d = new Diagnostics(cwd, { lsp: false });
  const py = join(cwd, "a.py");
  writeFileSync(py, "def f(:\n  pass\n");
  assert.match(await d.afterEdit(py, "", cwd), /a\.py:1:1 error: .*\n/);
  const js = join(cwd, "a.js");
  writeFileSync(js, "const x = ;\n");
  assert.match(await d.afterEdit(js, "", cwd), /a\.js:1:1 error: .*Unexpected token/);
  const sh = join(cwd, "a.sh");
  writeFileSync(sh, "if true; then\n");
  assert.match(await d.afterEdit(sh, "", cwd), /a\.sh:\d+:1 error/);
  writeFileSync(sh, "echo ok\n");
  assert.match(await d.afterEdit(sh, "", cwd), /no errors now/);
  assert.equal(await d.afterEdit(join(cwd, "x.txt"), "", cwd), "", "unknown types are not checked");
});

const FAKE_LSP = `#!/usr/bin/env node
let buf = Buffer.alloc(0);
const send = (m) => { const b = JSON.stringify({ jsonrpc: "2.0", ...m }); process.stdout.write("Content-Length: " + Buffer.byteLength(b) + "\\r\\n\\r\\n" + b); };
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const sep = buf.indexOf("\\r\\n\\r\\n"); if (sep < 0) return;
    const len = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, sep).toString())[1]);
    if (buf.length < sep + 4 + len) return;
    const m = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString()); buf = buf.subarray(sep + 4 + len);
    if (m.method === "initialize") send({ id: m.id, result: { capabilities: { textDocumentSync: 1 } } });
    const doc = m.params && m.params.textDocument;
    const text = m.method === "textDocument/didOpen" ? doc.text : m.method === "textDocument/didChange" ? m.params.contentChanges[0].text : null;
    if (text !== null) {
      const diagnostics = [];
      text.split("\\n").forEach((l, i) => { const c = l.indexOf("BAD"); if (c >= 0) diagnostics.push({ range: { start: { line: i, character: c }, end: { line: i, character: c + 3 } }, severity: 1, source: "fake", code: "F1", message: "BAD is not allowed" }); });
      send({ id: 99, method: "workspace/configuration", params: { items: [{}] } });
      setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: { uri: doc.uri, diagnostics } }), 50);
    }
  }
});
`;

test("LSP client: opens, changes, collects published diagnostics; new errors are marked", async () => {
  const cwd = tempDir();
  const server = join(cwd, "fake-lsp");
  writeFileSync(server, FAKE_LSP);
  chmodSync(server, 0o755);
  const d = new Diagnostics(cwd, { servers: { ".foo": { command: server } }, timeoutMs: 5000 });
  try {
    const f = join(cwd, "x.foo");
    const first = await d.afterEdit(f, "ok\nBAD here\n", cwd);
    assert.match(first, /x\.foo now has 1 error according to fake-lsp:\n  x\.foo:2:1 error \[fake F1\]: BAD is not allowed/);
    const second = await d.afterEdit(f, "BAD\nBAD here\n", cwd);
    assert.match(second, /2 errors \(1 new since your previous edit of this file\)/);
    assert.equal((second.match(/\(new\)/g) ?? []).length, 1, "identical errors: only the extra one is new");
    assert.match(await d.afterEdit(f, "fine\n", cwd), /no errors now/);
  } finally {
    d.stop();
  }
});

let gopls = false;
try {
  execFileSync("gopls", ["version"], { stdio: "ignore" });
  gopls = true;
} catch {}

test("a real language server (gopls) reports a type error", { skip: !gopls && "gopls not installed" }, async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "go.mod"), "module example.com/x\n\ngo 1.21\n");
  const file = join(cwd, "main.go");
  const src = "package main\n\nfunc main() {\n\tprintln(undefinedName)\n}\n";
  writeFileSync(file, src);
  const d = new Diagnostics(cwd, { timeoutMs: 30_000 });
  try {
    const out = await d.afterEdit(file, src, cwd);
    assert.match(out, /main\.go:4:\d+ error.*undefined: undefinedName/);
  } finally {
    d.stop();
  }
});
