import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decide, insideProject, isProtectedPath, isReadOnlyCommand } from "../src/core/modes.ts";
import { Edit, Write } from "../src/tools/core/files.ts";
import { tempDir } from "./helpers.ts";

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

test("a project opened through a symlink: the real path is inside the project too", () => {
  const real = tempDir();
  const link = join(tempDir(), "proj");
  symlinkSync(real, link);
  assert.equal(insideProject(link, join(real, "src", "new.ts")), true);
  assert.equal(insideProject(real, join(link, "a.ts")), true);
  assert.equal(insideProject(link, join(tempDir(), "x.ts")), false);
  assert.equal(insideProject(link, "../outside.ts"), false);
});

test("more read-only commands: viewers, sed -n, awk, cd, xargs/for around read-only commands, version checks", () => {
  for (const cmd of [
    "cd src && ls -la",
    "sed -n '1,80p' src/app.ts",
    "sed -n '/export/p' a.ts | head",
    "awk '{print $1}' access.log | sort | uniq -c",
    "awk -F: '$3 > 1000 {print $1}' /etc/passwd",
    "find . -name '*.ts' | xargs wc -l",
    "find src -type f -print0 | xargs -0 -n 50 grep -l TODO",
    "for f in src/*.ts; do wc -l $f; done",
    "while read l; do echo $l; done < list.txt",
    "if [ -f package.json ]; then cat package.json; fi",
    "nl -ba main.go | sed -n '10,20p'",
    "node --version && npm ls --depth=0",
    "go version",
    "pip list",
    "docker ps -a",
    "systemctl status llama-server",
    "journalctl -u llama-server -n 50",
    "timeout 5 cat big.log",
    "env LC_ALL=C sort a.txt",
    "xxd -l 64 file.bin",
    "pacman -Qi nodejs",
  ]) {
    assert.ok(isReadOnlyCommand(cmd), cmd);
  }
});

test("still not read-only: writing sed/awk, xargs/timeout/env around writers, risky builtins and subcommands", () => {
  for (const cmd of [
    "sed -i 's/a/b/' x.ts",
    "sed -ni 's/a/b/p' x.ts",
    "sed -n 's/a/b/w out.txt' x.ts",
    "sed '1e rm x' a",
    "awk '{print > \"out\"}' a",
    "awk 'BEGIN{system(\"rm x\")}'",
    "awk -f prog.awk a",
    "find . | xargs rm",
    "xargs sh -c 'rm x'",
    "timeout 5 rm x",
    "env PAGER=evil git log",
    "export GIT_EXTERNAL_DIFF=x; git diff",
    "node -e 'require(\"fs\").rmSync(\"x\")'",
    "npm install",
    "npm config set registry x",
    "pip install x",
    "go list ./...",
    "cargo check",
    "docker rm -f x",
    "kubectl delete pod x",
    "systemctl restart llama-server",
    "journalctl --vacuum-time=1d",
    "pacman -Syu",
    "pacman -R nodejs",
    "make -n",
    "for f in *.ts; do rm $f; done",
  ]) {
    assert.ok(!isReadOnlyCommand(cmd), cmd);
  }
});

test("readOnlyCommands from settings: user prefixes count as read-only", () => {
  assert.ok(!isReadOnlyCommand("docker compose ps"));
  assert.ok(isReadOnlyCommand("docker compose ps", ["docker compose ps"]));
  assert.ok(isReadOnlyCommand("cd x && make lint-check", ["make lint-check"]));
  assert.ok(!isReadOnlyCommand("make lint-check-and-fix", ["make lint-check"]), "a prefix matches whole words only");
  const ro = { name: "Bash", kind: "exec" } as never;
  assert.equal(decide("plan", ro, { command: "docker compose ps" }, "/", ["docker compose ps"]).action, "allow");
  const denied = decide("plan", ro, { command: "npm install" }, "/");
  assert.equal(denied.action, "deny");
  assert.match((denied as { reason: string }).reason, /^Not run: `npm install` may change something.*Read-only commands work/);
});
