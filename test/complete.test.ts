import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { complete, expandMentions, matchScore } from "../src/ui/complete.ts";
import { menuRows, truncateAnsi } from "../src/ui/menu.ts";
import { tempDir } from "./helpers.ts";

const COMMANDS = [
  { name: "help", description: "help" },
  { name: "diff", args: "[path]", description: "diff" },
  { name: "view", args: "<path>[:a-b]", description: "view" },
  { name: "code-review", args: "[args]", description: "skill" },
];

function project() {
  const dir = tempDir();
  mkdirSync(join(dir, "src", "ui"), { recursive: true });
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "ui", "menu.ts"), "x\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  writeFileSync(join(dir, "README.md"), "# hi\n");
  return dir;
}

test("/ lists commands: prefix matches first, then substring; gone once there is a space", () => {
  const r = complete("/", 1, COMMANDS, "/")!;
  assert.equal(r.kind, "command");
  assert.equal(r.items.length, 4);
  assert.deepEqual(complete("/e", 2, COMMANDS, "/")!.items.map((i) => i.insert), ["/help", "/view", "/code-review"]);
  assert.deepEqual(complete("/re", 3, COMMANDS, "/")!.items.map((i) => i.insert), ["/code-review"]);
  assert.equal(complete("/zzz", 4, COMMANDS, "/"), undefined);
  assert.equal(complete("/help me", 8, COMMANDS, "/"), undefined);
  assert.equal(complete("fix /help", 9, COMMANDS, "/"), undefined);
});

test("@ lists folders first, hides dotfiles and node_modules, descends into folders", () => {
  const dir = project();
  const top = complete("look at @", 9, COMMANDS, dir)!;
  assert.equal(top.kind, "path");
  assert.equal(top.start, 8);
  assert.deepEqual(top.items.map((i) => i.label), ["src/", "README.md"]);
  assert.deepEqual(complete("@.", 2, COMMANDS, dir)!.items.map((i) => i.label), [".env"]);
  const sub = complete("@src/", 5, COMMANDS, dir)!;
  assert.deepEqual(sub.items.map((i) => i.insert), ["@src/ui/", "@src/app.ts"]);
  assert.equal(sub.items[0].dir, true);
  assert.equal(complete("mail me@", 8, COMMANDS, dir), undefined);
});

test("@ without a folder searches the whole project; best matches first", () => {
  const dir = project();
  const files = () => ["src/app.ts", "src/ui/menu.ts", "docs/menus/intro.md"];
  assert.deepEqual(complete("@menu", 5, COMMANDS, dir, files)!.items.map((i) => i.label), ["src/ui/menu.ts", "docs/menus/intro.md"]);
  assert.equal(matchScore("src/ui/menu.ts", "menu"), 0);
  assert.equal(matchScore("src/ui/a-menu.ts", "menu"), 1);
  assert.equal(matchScore("menus/intro.md", "menu"), 2);
  assert.equal(matchScore("src/ui/mxexnxu.ts", "menu"), 3);
  assert.equal(matchScore("src/app.ts", "menu"), -1);
});

test("/view and /diff complete their path argument without an @", () => {
  const dir = project();
  const r = complete("/view sr", 8, COMMANDS, dir)!;
  assert.equal(r.start, 6);
  assert.equal(r.items[0].insert, "src/");
});

test("@mentions attach existing files and folders, leave other @words alone", () => {
  const dir = project();
  const { text, attached } = expandMentions("explain @src/app.ts, and @src please; ping @nobody", dir);
  assert.deepEqual(attached.map((a) => a.path), ["src/app.ts", "src"]);
  assert.match(text, /<file path="src\/app.ts">\nexport const a = 1;\n\n<\/file>/);
  assert.match(text, /<folder path="src">\napp.ts\nui\/\n<\/folder>/);
  assert.equal(expandMentions("no mentions here", dir).text, "no mentions here");
});

test("menu rows: selection marker, scroll window, ANSI-safe truncation", () => {
  const comp = { kind: "command" as const, start: 0, end: 1, items: Array.from({ length: 12 }, (_, i) => ({ label: `/c${i}`, insert: `/c${i}` })) };
  const rows = menuRows(comp, 10, 80).map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.equal(rows.length, 9); // 8 items + the key hint
  assert.match(rows.find((r) => r.includes("❯"))!, /\/c10/);
  assert.match(rows.at(-1)!, /11\/12/);
  assert.equal(truncateAnsi("\x1b[31mhello\x1b[39m", 3), "\x1b[31mhel\x1b[0m");
});
