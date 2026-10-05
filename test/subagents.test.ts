import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/core/loop.ts";
import { loadSettings } from "../src/core/settings.ts";
import { createWorktree, mergeBack, snapshot } from "../src/core/worktree.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { call, calls, fakeServer, noWarn, silentUI, tempDir, text } from "./helpers.ts";

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" }).trim();

function repo(): string {
  const dir = tempDir();
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "b.txt"), "b\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

async function setup(cwd: string, srvUrl: string, extra: object = {}) {
  const home = tempDir();
  const settings = { ...loadSettings(cwd, home), baseUrl: srvUrl, permissionMode: "acceptEdits" as const, ...extra };
  const registry = await loadRegistry(cwd, settings, noWarn, home);
  return { agent: new Agent({ cwd, settings, registry, home }), home };
}

/** the first user message of a request: tells the main agent and each subagent apart */
const task = (body: any) => String(body.messages.find((m: any) => m.role === "user")?.content ?? "");
const steps = (body: any) => body.messages.filter((m: any) => m.role === "assistant").length;

test("Agent calls in one reply run in parallel; results stay in call order", async () => {
  const srv = await fakeServer(
    (body) => {
      const t = task(body);
      if (t.startsWith("go")) {
        return steps(body) === 0
          ? calls(["Agent", { subagent_type: "explore", prompt: "TASK-1" }], ["Agent", { subagent_type: "explore", prompt: "TASK-2" }], ["Agent", { subagent_type: "explore", prompt: "TASK-3" }])
          : text("all done");
      }
      return text(`report for ${/TASK-\d/.exec(t)![0]}`);
    },
    100_000,
    600,
  );
  try {
    const { agent } = await setup(tempDir(), srv.url);
    const t0 = Date.now();
    await agent.send("go", silentUI([]), new AbortController().signal);
    const took = Date.now() - t0;
    // sequential would be 5 requests × 600ms = 3s; parallel is 3 rounds (main, the three subagents at once, main) ≈ 1.8s
    assert.ok(took < 2700, `took ${took}ms`);
    const tools = agent.messages.filter((m) => m.role === "tool");
    assert.deepEqual(
      tools.map((m) => /report for (TASK-\d)/.exec(String(m.content))?.[1]),
      ["TASK-1", "TASK-2", "TASK-3"],
    );
    assert.deepEqual(agent.board.root.children.map((c) => c.state), ["done", "done", "done"]);
  } finally {
    srv.close();
  }
});

test("parallel writing subagents work in git worktrees and their changes are merged back", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "a.txt"), "one\ntwo (uncommitted)\nthree\n"); // the snapshot must include this
  writeFileSync(join(cwd, "notes.txt"), "untracked\n");
  const srv = await fakeServer((body) => {
    const t = task(body);
    const n = steps(body);
    if (t.startsWith("go")) {
      return n === 0
        ? calls(["Agent", { subagent_type: "general-purpose", prompt: "TASK-A" }], ["Agent", { subagent_type: "general-purpose", prompt: "TASK-B" }])
        : text("merged");
    }
    if (t.includes("TASK-A")) {
      return [call("Read", { file_path: "a.txt" }), call("Edit", { file_path: "a.txt", old_string: "three", new_string: "THREE" }), text("A done")][n];
    }
    return [call("Write", { file_path: "d.txt", content: "new file\n" }), call("Read", { file_path: "notes.txt" }), text("B done")][n];
  });
  try {
    const { agent, home } = await setup(cwd, srv.url);
    const index = git(cwd, "write-tree");
    await agent.send("go", silentUI([]), new AbortController().signal);
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "one\ntwo (uncommitted)\nTHREE\n");
    assert.equal(readFileSync(join(cwd, "d.txt"), "utf8"), "new file\n");
    assert.equal(readFileSync(join(cwd, "notes.txt"), "utf8"), "untracked\n");
    assert.equal(git(cwd, "write-tree"), index, "the user's index is untouched");
    assert.equal(git(cwd, "worktree", "list").split("\n").length, 1, "worktrees are removed after a clean merge");
    assert.ok(!existsSync(join(home, ".agent", "worktrees")) || git(cwd, "worktree", "list", "--porcelain").split("worktree ").length === 2);
    const changed = agent.changes.list().map((f) => f.path.slice(cwd.length + 1)).sort();
    assert.deepEqual(changed, ["a.txt", "d.txt"], "/files and /undo see merged changes");
    const report = agent.messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
    assert.match(report, /own git worktree\. Merged into the project: a\.txt/);
    assert.match(report, /Merged into the project: d\.txt/);
    assert.deepEqual(agent.board.root.children.map((c) => !!c.worktree), [true, true]);
  } finally {
    srv.close();
  }
});

test("mergeBack: a three-way merge, conflict markers when both sides changed the same line", () => {
  const cwd = repo();
  const home = tempDir();
  const wt = createWorktree(cwd, "x", home);
  writeFileSync(join(wt.path, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(wt.path, "b.txt"), "b changed by subagent\n");
  writeFileSync(join(cwd, "a.txt"), "one\ntwo\nthree\nfour\n"); // the project changed another line: merges cleanly
  writeFileSync(join(cwd, "b.txt"), "b changed by project\n"); // the same line: conflict
  const m = mergeBack(wt);
  assert.deepEqual(m.merged, ["a.txt"]);
  assert.deepEqual(m.conflicts, ["b.txt"]);
  assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "one\nTWO\nthree\nfour\n");
  assert.match(readFileSync(join(cwd, "b.txt"), "utf8"), /<<<<<<< project\nb changed by project\n=======\nb changed by subagent\n>>>>>>> subagent/);
});

test("snapshot of a repository without commits", () => {
  const dir = tempDir();
  git(dir, "init", "-q");
  writeFileSync(join(dir, "x.txt"), "x\n");
  const sha = snapshot(dir);
  assert.equal(git(dir, "show", `${sha}:x.txt`), "x");
});

test("without git, writing subagents take turns; a long report is cut and saved", async () => {
  let active = 0;
  let maxActive = 0;
  const srv = await fakeServer(
    (body) => {
      const t = task(body);
      if (t.startsWith("go")) {
        return steps(body) === 0
          ? calls(["Agent", { subagent_type: "general-purpose", prompt: "TASK-1" }], ["Agent", { subagent_type: "general-purpose", prompt: "TASK-2" }])
          : text("done");
      }
      return text("x".repeat(20_000));
    },
    100_000,
    0,
  );
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const body = JSON.parse(String((args[1] as RequestInit)?.body ?? "{}"));
    const sub = body.messages && !task(body).startsWith("go");
    if (sub) maxActive = Math.max(maxActive, ++active);
    try {
      return await origFetch(...args);
    } finally {
      if (sub) active--;
    }
  }) as typeof fetch;
  try {
    const { agent } = await setup(tempDir(), srv.url);
    await agent.send("go", silentUI([]), new AbortController().signal);
    assert.equal(maxActive, 1, "no worktrees without git: one writer at a time");
    const tool = String(agent.messages.find((m) => m.role === "tool")!.content);
    assert.ok(tool.length < 9_500, `report length ${tool.length}`);
    assert.match(tool, /the full report is in .*agent-output/);
  } finally {
    globalThis.fetch = origFetch;
    srv.close();
  }
});
