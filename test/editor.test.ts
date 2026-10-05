import assert from "node:assert/strict";
import { test } from "node:test";
import { type Key, LineEditor, layout, strWidth } from "../src/ui/editor.ts";

function editor(history: string[] = []) {
  const written: string[] = [];
  const ed = new LineEditor({ output: { write: (s: string) => written.push(s), columns: 40 }, history });
  const sent: string[] = [];
  ed.on("line", (l: string) => sent.push(l));
  ed.setPrompt("› ");
  ed.prompt();
  const type = (text: string) => {
    for (const ch of text) ed.feed(ch, { name: ch, sequence: ch });
  };
  const key = (name: string, extra: Key = {}) => ed.feed(undefined, { name, ...extra });
  return { ed, sent, type, key, written };
}

test('"\\" + Enter inserts a new line anywhere; Enter sends the whole message', () => {
  const { ed, sent, type, key } = editor();
  type("hello world");
  for (let i = 0; i < 5; i++) key("left");
  type("\\");
  key("return");
  assert.equal(ed.line, "hello \nworld");
  assert.equal(ed.cursor, 7);
  assert.deepEqual(sent, []);
  key("return");
  assert.deepEqual(sent, ["hello \nworld"]);
  assert.equal(ed.line, "");
});

test("Alt+Enter, Ctrl+J and Shift+Enter (kitty/xterm sequences) insert new lines", () => {
  const { ed, type, key } = editor();
  type("a");
  key("return", { meta: true });
  type("b");
  key("j", { ctrl: true });
  type("c");
  ed.feed("\x1b[13;2u", { sequence: "\x1b[13;2u" });
  type("d");
  assert.equal(ed.line, "a\nb\nc\nd");
});

test("↑/↓ move between lines keeping the column; at the edges they walk the history", () => {
  const { ed, type, key } = editor(["newest\nentry", "older"]);
  type("first line");
  key("return", { meta: true });
  type("ab");
  key("up");
  assert.equal(ed.cursor, 2, "same column on the line above");
  key("up");
  assert.equal(ed.line, "newest\nentry", "from the first line, up recalls history");
  assert.equal(ed.cursor, ed.line.length);
  key("up");
  assert.equal(ed.line, "newest\nentry", "inside a multi-line entry, up moves to its first line first");
  key("up");
  assert.equal(ed.line, "older");
  key("down");
  assert.equal(ed.line, "newest\nentry");
  key("down");
  key("down");
  assert.equal(ed.line, "first line\nab", "back to the draft");
});

test("editing keys work per line: home/end, ctrl+u, ctrl+k joins lines, ctrl+w, backspace across lines", () => {
  const { ed, type, key } = editor();
  type("one two");
  key("return", { meta: true });
  type("three");
  key("home");
  assert.equal(ed.cursor, 8);
  key("backspace");
  assert.equal(ed.line, "one twothree", "backspace at a line start joins the lines");
  key("w", { ctrl: true });
  assert.equal(ed.line, "one three");
  key("e", { ctrl: true });
  key("u", { ctrl: true });
  assert.equal(ed.line, "");
});

test("pasted text keeps its newlines and is not sent", () => {
  const { ed, sent, key } = editor();
  key("paste-start");
  for (const ch of "x = 1\ny = 2") ed.feed(ch === "\n" ? "\r" : ch, { name: ch === "\n" ? "return" : ch, sequence: ch === "\n" ? "\r" : ch });
  key("paste-end");
  assert.equal(ed.line, "x = 1\ny = 2");
  assert.deepEqual(sent, []);
});

test("ctrl+c emits SIGINT; ctrl+d on an empty line closes", () => {
  const { ed, key } = editor();
  let sigint = 0;
  let closed = 0;
  ed.on("SIGINT", () => sigint++);
  ed.on("close", () => closed++);
  key("c", { ctrl: true });
  key("d", { ctrl: true });
  assert.equal(sigint, 1);
  assert.equal(closed, 1);
});

test("layout: wrapping, continuation lines, wide characters", () => {
  assert.deepEqual(layout("abcdef", 2, 5, 6), { cursorRow: 1, cursorCol: 3, endRow: 1, endCol: 3 });
  assert.deepEqual(layout("ab\ncd", 2, 40, 5), { cursorRow: 1, cursorCol: 4, endRow: 1, endCol: 4 });
  assert.deepEqual(layout("abc", 2, 5, 3), { cursorRow: 1, cursorCol: 0, endRow: 0, endCol: 5 }, "a full row puts the cursor on the next one");
  assert.equal(strWidth("日本"), 4);
  assert.equal(strWidth("привет"), 6);
});
