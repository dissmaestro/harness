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
