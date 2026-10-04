import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, isProtectedPath, isReadOnlyCommand } from "../src/core/modes.ts";
import { Edit, Write } from "../src/tools/core/files.ts";

test("read-only commands stay read-only", () => {
  for (const cmd of [
    "ls -la",
    "git status",
    "git log --oneline | head",
    "rg foo src",
    "cat a | wc -l",
    "rg 'a|b; c' src",
    'grep -n "x > y" f.txt',
    "ls 2>&1 | head",
    "cat a.txt 2>/dev/null",
    "ls &>/dev/null",
    "git diff HEAD~1 --stat",
    "git branch",
    "git branch -a",
    "git branch --list 'feat*'",
    "git tag",
    "git tag -l 'v*'",
    "git remote -v",
    "git --no-pager log -3",
    "find . -name '*.ts' -type f",
    "sort -u a.txt",
    "tree -L 2",
    "env",
    "LC_ALL=C sort a",
    "wc -l < a.txt",
    "echo a\\;b",
  ]) {
    assert.ok(isReadOnlyCommand(cmd), cmd);
  }
});

test("read-only check bypasses are rejected", () => {
  for (const cmd of [
    "ls & rm -rf x",
    "ls\nrm x",
    "ls; rm x",
    "ls || rm x",
    "env rm -rf x",
    "xargs rm",
    "nohup rm x",
    "timeout 5 rm x",
    "cat <(touch x)",
    "diff a >(tee x)",
    "rg --pre ./x foo",
    "rg --pre=./x foo",
    "sort -o f a",
    "sort -uo f a",
    "sort --output=f a",
    "find . -fprint f",
    "find . -fprintf f %p",
    "find . -fls f",
    "find . -delete",
    "find . -exec rm {} ;",
    "fd -x rm",
    "tree -o out.txt",
    "git branch -D main",
    "git branch -d old",
    "git branch -m new",
    "git branch newbranch",
    "git tag -d v1",
    "git tag v2",
    "git diff --output=x",
    "git log --output x",
    "git remote add o url",
    "git -c core.pager=sh log",
    "echo x > f",
    "echo x >> f",
    "echo x >f",
    "ls 1>out",
    "echo `rm x`",
    "echo $(rm x)",
    'echo "$(rm x)"',
    "cat <<EOF\nx\nEOF",
    "GIT_EXTERNAL_DIFF=./x git diff",
    "uniq a b",
    "(rm x)",
  ]) {
    assert.ok(!isReadOnlyCommand(cmd), cmd);
  }
});

test("protected paths ask even in acceptEdits and auto", () => {
  const cwd = "/proj";
  assert.ok(isProtectedPath(cwd, ".git/hooks/pre-commit"));
  assert.ok(isProtectedPath(cwd, "/proj/.agent/settings.json"));
  assert.ok(isProtectedPath(cwd, ".envrc"));
  assert.ok(isProtectedPath(cwd, "sub/.husky/pre-push"));
  assert.ok(!isProtectedPath(cwd, "AGENTS.md"));
  assert.ok(!isProtectedPath(cwd, "src/.gitignore"));
  assert.ok(!isProtectedPath(cwd, "src/a.ts"));
  for (const mode of ["acceptEdits", "auto"] as const) {
    for (const file_path of [".git/config", ".claude/settings.json", ".vscode/tasks.json", ".envrc"]) {
      const d = decide(mode, Write, { file_path }, cwd);
      assert.equal(d.action, "ask", `${mode} ${file_path}`);
      assert.match((d as { reason: string }).reason, /agent\/git configuration/);
    }
    assert.equal(decide(mode, Edit, { file_path: "CLAUDE.md" }, cwd).action, "allow");
  }
  assert.equal(decide("yolo", Edit, { file_path: ".git/config" }, cwd).action, "allow");
});
