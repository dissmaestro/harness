import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MarkdownStream } from "../src/ui/markdown.ts";
import { truncateAnsi } from "../src/ui/menu.ts";
import { configureLinks, fileLink, linkPaths, stripAnsi } from "../src/ui/render.ts";
import { firstChangedLine } from "../src/ui/repl.ts";
import { tempDir } from "./helpers.ts";

const OSC = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

test("editor URLs: vscode at a line, file:// with the host, custom templates, off", () => {
  configureLinks({ editor: "vscode" }, { PATH: "" }, true);
  assert.equal(fileLink("a", "/x/my file.ts", 3), OSC("vscode://file/x/my%20file.ts:3:1", "a"));
  configureLinks({ editor: "file" }, { PATH: "" }, true);
  assert.equal(fileLink("a", "/x/a.ts", 3), OSC(`file://${hostname()}/x/a.ts`, "a"));
  configureLinks({ editor: "myed://open?f={path}&l={line}" }, { PATH: "" }, true);
  assert.equal(fileLink("a", "/x/a.ts", 7), OSC("myed://open?f=/x/a.ts&l=7", "a"));
  configureLinks({ editor: "vscode", hyperlinks: false }, { PATH: "" }, true);
  assert.equal(fileLink("a", "/x/a.ts"), "a");
  configureLinks({ editor: "vscode" }, { PATH: "", AGENT_HYPERLINKS: "0" }, true);
  assert.equal(fileLink("a", "/x/a.ts"), "a");
  configureLinks({ editor: "vscode" }, { PATH: "" }, false);
  assert.equal(fileLink("a", "/x/a.ts"), "a", "no links when the output is not a terminal");
});

test("auto picks an installed editor, else file://", () => {
  const bin = tempDir();
  configureLinks({}, { PATH: bin }, true);
  assert.match(fileLink("a", "/x"), /file:\/\//);
  writeFileSync(join(bin, "zed"), "#!/bin/sh\n");
  chmodSync(join(bin, "zed"), 0o755);
  configureLinks({}, { PATH: bin }, true);
  assert.match(fileLink("a", "/x"), /zed:\/\/file\/x/);
});

test("paths of existing files in text become links; others, versions and URLs stay text", () => {
  const cwd = tempDir();
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "app.ts"), "x\n");
  writeFileSync(join(cwd, "README.md"), "x\n");
  configureLinks({ editor: "vscode" }, { PATH: "" }, true);
  const out = linkPaths("see src/app.ts:12:5, README.md and nope.ts; v1.2.3; https://example.com/README.md", cwd);
  assert.ok(out.includes(OSC(`vscode://file${cwd}/src/app.ts:12:5`, "src/app.ts:12:5")), out);
  assert.ok(out.includes(OSC(`vscode://file${cwd}/README.md:1:1`, "README.md")), out);
  assert.equal(stripAnsi(out), "see src/app.ts:12:5, README.md and nope.ts; v1.2.3; https://example.com/README.md");
  assert.equal((out.match(/\x1b\]8;;[^\x1b]/g) ?? []).length, 2);
});

test("markdown: links in prose and lists, not in code blocks", () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "a.py"), "x\n");
  configureLinks({ editor: "vscode" }, { PATH: "" }, true);
  const lines: string[] = [];
  const md = new MarkdownStream((s) => lines.push(s), cwd);
  md.push("- fixed `a.py:3`\n```\nopen a.py\n```\n");
  assert.match(lines[0], /\x1b\]8;;vscode:\/\/file.*a\.py:3:1/);
  assert.ok(!lines[2].includes("\x1b]8;"), "code blocks are left alone");
});

test("width helpers ignore links; truncation closes a cut link", () => {
  configureLinks({ editor: "vscode" }, { PATH: "" }, true);
  const l = fileLink("abcdef", "/x");
  assert.equal(stripAnsi(l), "abcdef");
  const cut = truncateAnsi(l, 3);
  assert.equal(stripAnsi(cut), "abc");
  assert.ok(cut.endsWith("\x1b]8;;\x1b\\"));
  assert.equal(firstChangedLine("a\nb\nc\n", "a\nB\nc\n"), 2);
  assert.equal(firstChangedLine("", "new\n"), 1);
});
