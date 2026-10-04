import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChangeTracker } from "../src/core/changes.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "changes-"));
  const t = new ChangeTracker();
  const p = (name: string) => join(dir, name);
  const write = (name: string, content: string, tool = "Write") => {
    t.beforeWrite(p(name), tool);
    writeFileSync(p(name), content);
    return t.afterWrite(p(name));
  };
  const read = (name: string) => readFileSync(p(name), "utf8");
  return { dir, t, p, write, read, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("per-write before/after, and changes listed against the session start", () => {
  const { dir, t, p, write, done } = setup();
  try {
    writeFileSync(p("a.txt"), "one\ntwo\n");
    t.beginTurn("first");
    assert.deepEqual(write("a.txt", "one\nTWO\nthree\n", "Edit"), { before: "one\ntwo\n", after: "one\nTWO\nthree\n" });
    assert.deepEqual(write("b.txt", "new\n"), { before: null, after: "new\n" });
    write("a.txt", "one\nTWO\nthree\nfour\n", "Edit");
    assert.deepEqual(
      t.list().map((f) => [f.path.slice(dir.length + 1), f.status, f.added, f.removed, f.tools, f.writes]),
      [
        ["a.txt", "M", 3, 1, ["Edit"], 2],
        ["b.txt", "A", 1, 0, ["Write"], 1],
      ],
    );
    // a file written back to its original content is not a change
    write("a.txt", "one\ntwo\n", "Edit");
    assert.deepEqual(t.list().map((f) => f.status), ["A"]);
  } finally {
    done();
  }
});

test("undo restores the last turn that changed something and deletes files it created", () => {
  const { t, p, write, read, done } = setup();
  try {
    writeFileSync(p("a.txt"), "v0");
    t.beginTurn("turn 1");
    write("a.txt", "v1");
    t.beginTurn("turn 2");
    write("a.txt", "v2");
    write("a.txt", "v3");
    write("new.txt", "x");
    t.beginTurn("turn 3 (no writes)");
    assert.equal(t.peekUndo()?.turn, "turn 2");
    const r = t.undo()!;
    assert.equal(r.turn, "turn 2");
    assert.deepEqual(r.paths.sort(), [p("a.txt"), p("new.txt")]);
    assert.equal(read("a.txt"), "v1");
    assert.equal(existsSync(p("new.txt")), false);
    assert.equal(t.undo()!.turn, "turn 1");
    assert.equal(read("a.txt"), "v0");
    assert.equal(t.undo(), undefined);
  } finally {
    done();
  }
});

test("revert restores one file or all to the session start (new files are deleted)", () => {
  const { t, p, write, read, done } = setup();
  try {
    writeFileSync(p("a.txt"), "a0");
    writeFileSync(p("b.txt"), "b0");
    t.beginTurn("t");
    write("a.txt", "a1");
    write("b.txt", "b1");
    write("c.txt", "c1");
    assert.deepEqual(t.revert(p("a.txt")), [p("a.txt")]);
    assert.equal(read("a.txt"), "a0");
    assert.equal(read("b.txt"), "b1");
    assert.deepEqual(t.revert().sort(), [p("b.txt"), p("c.txt")]);
    assert.equal(read("b.txt"), "b0");
    assert.equal(existsSync(p("c.txt")), false);
    assert.deepEqual(t.list(), []);
    assert.equal(t.undo(), undefined);
  } finally {
    done();
  }
});

test("binary files are recorded but not restorable", () => {
  const { t, p, write, done } = setup();
  try {
    writeFileSync(p("bin"), "a\0b");
    t.beginTurn("t");
    assert.equal(write("bin", "c\0d"), undefined);
    assert.deepEqual(t.list().map((f) => f.status), ["M"]);
    const r = t.undo()!;
    assert.deepEqual(r.notRestored, [p("bin")]);
    assert.deepEqual(r.paths, []);
  } finally {
    done();
  }
});
