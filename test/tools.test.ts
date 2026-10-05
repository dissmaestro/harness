import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { coerceArgs, validateArgs } from "../src/core/validate.ts";
import { extractTextToolCalls, parseJsonLenient } from "../src/providers/toolcall-parse.ts";
import { Registry } from "../src/registry/registry.ts";
import { Edit, Read, Write } from "../src/tools/core/files.ts";
import { applyEdit } from "../src/tools/core/edit-match.ts";
import { Bash, Glob, Grep } from "../src/tools/core/shell.ts";
import type { ToolContext } from "../src/types.ts";
import { killAllProcesses, runProcess } from "../src/util.ts";
import { put, tempDir } from "./helpers.ts";

const ctx = (cwd: string): ToolContext => ({
  cwd,
  registry: new Registry(),
  signal: new AbortController().signal,
  readFiles: new Map(),
});

test("Edit requires Read, then replaces exactly", async () => {
  const cwd = tempDir();
  put(cwd, "a.py", "def f():\n    return 1\n");
  const c = ctx(cwd);
  await assert.rejects(Edit.run({ file_path: "a.py", old_string: "1", new_string: "2" }, c), /must Read/);
  await Read.run({ file_path: "a.py" }, c);
  await Edit.run({ file_path: "a.py", old_string: "return 1", new_string: "return 2" }, c);
  assert.equal(readFileSync(join(cwd, "a.py"), "utf8"), "def f():\n    return 2\n");
});

test("Edit refuses a stale read", async () => {
  const cwd = tempDir();
  const file = put(cwd, "a.txt", "one");
  const c = ctx(cwd);
  await Read.run({ file_path: "a.txt" }, c);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(file, "changed elsewhere");
  await assert.rejects(Edit.run({ file_path: "a.txt", old_string: "changed", new_string: "x" }, c), /changed since/);
});

test("fuzzy edit: wrong indentation is matched and re-indented", () => {
  const file = "class A:\n    def f(self):\n        x = 1\n        return x\n";
  const r = applyEdit(file, "def f(self):\n    x = 1\n    return x", "def f(self):\n    x = 2\n    return x", false);
  assert.ok(r.fuzzy);
  assert.equal(r.content, "class A:\n    def f(self):\n        x = 2\n        return x\n");
});

test("edit errors: ambiguous match and closest-line hint", () => {
  assert.throws(() => applyEdit("a\na\n", "a", "b", false), /matches 2 places/);
  assert.equal(applyEdit("a\na\n", "a", "b", true).content, "b\nb\n");
  assert.throws(() => applyEdit("const value = compute(1);\n", "const valeu = compute(1);", "x", false), /Closest match starts at line 1/);
});

test("Write creates files and refuses to overwrite unread ones", async () => {
  const cwd = tempDir();
  const c = ctx(cwd);
  await Write.run({ file_path: "new/dir/f.txt", content: "hi" }, c);
  assert.equal(readFileSync(join(cwd, "new/dir/f.txt"), "utf8"), "hi");
  put(cwd, "old.txt", "x");
  await assert.rejects(Write.run({ file_path: "old.txt", content: "y" }, c), /must Read/);
});

test("Read numbers lines and paginates", async () => {
  const cwd = tempDir();
  put(cwd, "f.txt", "a\nb\nc\nd");
  const out = await Read.run({ file_path: "f.txt", offset: 2, limit: 2 }, ctx(cwd));
  assert.match(out, /^ +2\tb\n +3\tc\n\[showing lines 2-3 of 4/);
});

test("Bash, Grep, Glob", async () => {
  const cwd = tempDir();
  put(cwd, "src/a.ts", "const needle = 1;\n");
  put(cwd, "src/b.ts", "nothing\n");
  const c = ctx(cwd);
  assert.match(await Bash.run({ command: "echo out; echo err >&2; exit 3" }, c), /^out\n\[stderr\]\nerr\n\[exit code 3\]$/);
  assert.equal(await Grep.run({ pattern: "needle" }, c), "src/a.ts");
  assert.match(await Grep.run({ pattern: "needle", output_mode: "content" }, c), /src\/a\.ts:1:const needle/);
  assert.equal(await Grep.run({ pattern: "absent" }, c), "No matches found.");
  assert.deepEqual((await Glob.run({ pattern: "*.ts" }, c)).split("\n").sort(), ["src/a.ts", "src/b.ts"]);
});

test("Read caps output by characters and says where to continue", async () => {
  const cwd = tempDir();
  put(cwd, "big.txt", Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ` + "x".repeat(40)).join("\n"));
  put(cwd, "wide.txt", "y".repeat(5000));
  const c = ctx(cwd);
  const out = await Read.run({ file_path: "big.txt" }, c);
  assert.ok(out.length < 42_000, `${out.length}`);
  const m = out.match(/\[truncated at line (\d+) of 3000 — use offset=(\d+) to continue\]$/);
  assert.ok(m, out.slice(-200));
  assert.equal(Number(m[2]), Number(m[1]) + 1);
  const wide = await Read.run({ file_path: "wide.txt" }, c);
  assert.ok(wide.length < 1100 && wide.endsWith("…"));
});

test("Grep and Glob: hidden files yes, .git no; content capped", async () => {
  const cwd = tempDir();
  put(cwd, ".github/ci.yml", "needle\n");
  put(cwd, ".git/config", "needle\n");
  put(cwd, "long.txt", Array.from({ length: 400 }, () => "needle " + "z".repeat(1000)).join("\n"));
  const c = ctx(cwd);
  assert.deepEqual((await Grep.run({ pattern: "needle" }, c)).split("\n").sort(), [".github/ci.yml", "long.txt"]);
  assert.equal(await Glob.run({ pattern: "*.yml" }, c), ".github/ci.yml");
  assert.equal(await Glob.run({ pattern: "config" }, c), "No files found.");
  const content = await Grep.run({ pattern: "needle", output_mode: "content", path: "long.txt", head_limit: 1000 }, c);
  assert.ok(content.length < 21_000, `${content.length}`);
  assert.ok(content.split("\n").every((l) => l.length < 400));
  assert.match(content, /more lines; narrow the search/);
});

test("Bash: long output is truncated and saved in full", async () => {
  const c = ctx(tempDir());
  const out = await Bash.run({ command: "seq 1 20000" }, c);
  assert.ok(out.length < 17_000, `${out.length}`);
  const saved = out.match(/full output \(\d+ chars\) saved to (\S+);/)?.[1];
  assert.ok(saved, out.slice(-300));
  assert.equal(readFileSync(saved, "utf8").split("\n").length, 20000);
});

test("runProcess: aborted signal, background children, killAllProcesses", async () => {
  const cwd = tempDir();
  const ac = new AbortController();
  ac.abort();
  const t0 = Date.now();
  assert.equal((await runProcess("sleep", ["5"], { cwd, signal: ac.signal })).code, null);
  // a daemonized grandchild keeps stdout open; we must not wait for it
  const r = await runProcess("bash", ["-c", "echo started; sleep 30 & disown; exit 0"], { cwd });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "started");
  assert.ok(Date.now() - t0 < 5000, "did not hang on the background sleep");
  killAllProcesses(); // the background sleep's group must die
});

test("lenient JSON", () => {
  assert.deepEqual(parseJsonLenient('```json\n{"a": 1,}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLenient('{"a": {"b": "x'), { a: { b: "x" } });
});

test("text tool calls: Hermes JSON and Qwen3-Coder XML", () => {
  const known = new Set(["Read", "Bash"]);
  const hermes = extractTextToolCalls('Let me look.\n<tool_call>\n{"name": "Read", "arguments": {"file_path": "a.ts"}}\n</tool_call>', known);
  assert.deepEqual(hermes.calls, [{ name: "Read", arguments: { file_path: "a.ts" } }]);
  assert.equal(hermes.rest, "Let me look.");

  const xml = extractTextToolCalls("<tool_call>\n<function=Bash>\n<parameter=command>\nls -la\n</parameter>\n</function>\n</tool_call>", known);
  assert.deepEqual(xml.calls, [{ name: "Bash", arguments: { command: "ls -la" } }]);

  const fence = extractTextToolCalls('```json\n{"name": "Read", "arguments": {"file_path": "x"}}\n```', known);
  assert.equal(fence.calls.length, 1);
  const unknown = extractTextToolCalls('```json\n{"name": "nope", "arguments": {}}\n```', known);
  assert.equal(unknown.calls.length, 0, "fenced JSON only counts for known tool names");
});

test("argument coercion and validation", () => {
  const schema = {
    type: "object",
    properties: { n: { type: "integer" }, b: { type: "boolean" }, mode: { type: "string", enum: ["a", "b"] } },
    required: ["n"],
  };
  assert.deepEqual(coerceArgs(schema, { n: "5", b: "true" }), { n: 5, b: true });
  assert.equal(validateArgs(schema, { n: 5 }), null);
  assert.match(validateArgs(schema, {})!, /missing required parameter "n"/);
  assert.match(validateArgs(schema, { n: 1, mode: "c" })!, /one of/);
});

test("text tool calls: Gemma 4, Gemma 3 tool_code, Mistral, Llama, DeepSeek, bare JSON", () => {
  const known = new Set(["Read", "Bash", "Edit"]);
  const g4 = extractTextToolCalls('Reading.<|tool_call>call:Read{file_path:<|"|>src/a, b.ts<|"|>,offset:10,limit:5}<tool_call|>', known);
  assert.deepEqual(g4.calls, [{ name: "Read", arguments: { file_path: "src/a, b.ts", offset: 10, limit: 5 } }]);
  assert.equal(g4.rest, "Reading.");
  const g4nested = extractTextToolCalls('<|tool_call>call:Edit{file_path:<|"|>x<|"|>,old_string:<|"|>a{b}<|"|>,new_string:<|"|>c "q"<|"|>,replace_all:false}<turn|>', known);
  assert.deepEqual(g4nested.calls[0].arguments, { file_path: "x", old_string: "a{b}", new_string: 'c "q"', replace_all: false });
  const g4bare = extractTextToolCalls('call:Bash{command:<|"|>ls<|"|>}', known);
  assert.deepEqual(g4bare.calls, [{ name: "Bash", arguments: { command: "ls" } }]);
  assert.equal(extractTextToolCalls("call:nope{a:1}", known).calls.length, 0, "bare call: only for known tools");

  const g3 = extractTextToolCalls('```tool_code\nprint(default_api.Bash(command="npm test", timeout=60))\n```', known);
  assert.deepEqual(g3.calls, [{ name: "Bash", arguments: { command: "npm test", timeout: 60 } }]);

  const mistral = extractTextToolCalls('[TOOL_CALLS][{"name": "Read", "arguments": {"file_path": "a"}}, {"name": "Bash", "arguments": {"command": "ls"}}]', known);
  assert.deepEqual(mistral.calls.map((c) => c.name), ["Read", "Bash"]);
  const mistral2 = extractTextToolCalls('[TOOL_CALLS]Read[ARGS]{"file_path": "a"}', known);
  assert.deepEqual(mistral2.calls, [{ name: "Read", arguments: { file_path: "a" } }]);

  const llama = extractTextToolCalls('<|python_tag|>{"name": "Bash", "parameters": {"command": "pwd"}}<|eom_id|>', known);
  assert.deepEqual(llama.calls, [{ name: "Bash", arguments: { command: "pwd" } }]);

  const ds = extractTextToolCalls('<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>Read\n```json\n{"file_path": "a"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>', known);
  assert.deepEqual(ds.calls, [{ name: "Read", arguments: { file_path: "a" } }]);
  assert.equal(ds.rest, "");

  const bare = extractTextToolCalls('{"name": "Read", "arguments": {"file_path": "a"}}', known);
  assert.equal(bare.calls.length, 1);
  assert.equal(extractTextToolCalls('{"name": "Bob", "age": 3}', known).calls.length, 0, "plain JSON data is not a call");
});
