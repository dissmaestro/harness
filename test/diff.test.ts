import assert from "node:assert/strict";
import { test } from "node:test";
import { diffHunks, diffStat, renderDiff } from "../src/ui/diff.ts";
import { stripAnsi } from "../src/ui/render.ts";

const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

test("a one-line change gives one hunk with 3 lines of context", () => {
  const a = lines(20);
  const b = a.replace("line 10\n", "LINE TEN\n");
  const [h, ...rest] = diffHunks(a, b);
  assert.equal(rest.length, 0);
  assert.deepEqual([h.oldStart, h.oldLines, h.newStart, h.newLines], [7, 7, 7, 7]);
  assert.deepEqual(
    h.lines.map((l) => l.t + l.text),
    [" line 7", " line 8", " line 9", "-line 10", "+LINE TEN", " line 11", " line 12", " line 13"],
  );
});

test("insertions and deletions; far apart changes make separate hunks", () => {
  const a = lines(40);
  const b = a.replace("line 5\n", "line 5\nnew A\nnew B\n").replace("line 30\n", "");
  const hunks = diffHunks(a, b);
  assert.equal(hunks.length, 2);
  assert.deepEqual([hunks[0].oldStart, hunks[0].oldLines, hunks[0].newStart, hunks[0].newLines], [3, 6, 3, 8]);
  assert.deepEqual(hunks[0].lines.filter((l) => l.t === "+").map((l) => [l.text, l.newNo]), [["new A", 6], ["new B", 7]]);
  assert.deepEqual(hunks[1].lines.filter((l) => l.t === "-").map((l) => [l.text, l.oldNo]), [["line 30", 30]]);
  assert.deepEqual([hunks[1].oldStart, hunks[1].oldLines, hunks[1].newStart, hunks[1].newLines], [27, 7, 29, 6]);
  assert.deepEqual(diffStat(a, b), { added: 2, removed: 1 });
});

test("pure insertion with no context points at the line before", () => {
  const [h] = diffHunks("a\nb\n", "a\nx\nb\n", 0);
  assert.deepEqual([h.oldStart, h.oldLines, h.newStart, h.newLines], [1, 0, 2, 1]);
});

test("close changes merge into one hunk; identical texts have none", () => {
  const a = lines(20);
  const b = a.replace("line 5\n", "x\n").replace("line 9\n", "y\n");
  assert.equal(diffHunks(a, b).length, 1);
  assert.deepEqual(diffHunks(a, a), []);
});

test("Myers finds a minimal edit script", () => {
  const s = diffStat("a\nb\nc\na\nb\nb\na\n", "c\nb\na\nb\na\nc\n");
  assert.equal(s.added + s.removed, 5); // the classic example from the paper: D = 5
});

test("renderDiff: hunk header, signs and line numbers", () => {
  const out = renderDiff("x.ts", "const a = 1;\nconst b = 2;\n", "const a = 1;\nconst b = 3;\n").map(stripAnsi);
  assert.equal(out[0], "@@ -1,2 +1,2 @@");
  assert.ok(out.includes("1 1   const a = 1;"), out.join("\n"));
  assert.ok(out.includes("2   - const b = 2;"), out.join("\n"));
  assert.ok(out.includes("  2 + const b = 3;"), out.join("\n"));
});

test("renderDiff: a new file is all added and capped; a deleted one all removed", () => {
  const out = renderDiff("new.py", null, lines(50), { maxLines: 10 }).map(stripAnsi);
  assert.equal(out.length, 11);
  assert.equal(out[0], " 1 + line 1");
  assert.equal(out[10], "… 40 more lines");
  assert.deepEqual(renderDiff("old.txt", "a\nb\n", null).map(stripAnsi), ["1 - a", "2 - b"]);
});

test("renderDiff: changed lines keep their background through syntax colors", () => {
  const out = renderDiff("x.ts", "let a = 1;\n", "let a = 2;\n", { width: 40 });
  const added = out.find((l) => stripAnsi(l).includes("+ let a = 2;"))!;
  assert.match(added, /\x1b\[48;5;22m/);
  assert.match(added, /\x1b\[35mlet\x1b\[39m/);
  assert.equal(stripAnsi(added).length, 40);
});
