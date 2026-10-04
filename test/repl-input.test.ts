import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmAnswer, isPathLike, parseViewSpec } from "../src/ui/repl.ts";

test("a prompt starting with a path is not a command", () => {
  assert.equal(isPathLike("/home/x/a.py fails"), true);
  assert.equal(isPathLike("/etc/hosts"), true);
  assert.equal(isPathLike("/diff src/a.ts"), false);
  assert.equal(isPathLike("/help"), false);
});

test("an empty answer means yes only when the action is not risky", () => {
  assert.equal(confirmAnswer("", false), "yes");
  assert.equal(confirmAnswer("", true), "no");
  assert.equal(confirmAnswer("y", true), "yes");
  assert.equal(confirmAnswer("always", false), "always");
  assert.equal(confirmAnswer("no", false), "no");
  assert.equal(confirmAnswer(null, false), "no");
});

test("/view path specs", () => {
  assert.deepEqual(parseViewSpec("src/a.ts"), { path: "src/a.ts", start: undefined, end: undefined });
  assert.deepEqual(parseViewSpec("src/a.ts:10"), { path: "src/a.ts", start: 10, end: 10 });
  assert.deepEqual(parseViewSpec("src/a.ts:10-20"), { path: "src/a.ts", start: 10, end: 20 });
  assert.deepEqual(parseViewSpec("a.ts:5-"), { path: "a.ts", start: 5, end: undefined });
});
