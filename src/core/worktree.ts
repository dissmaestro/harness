import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ChangeTracker } from "./changes.ts";

/**
 * Isolated copies of the project for subagents that write files in parallel. A worktree starts from a
 * snapshot of the working tree as it is now (uncommitted and untracked files included, .gitignore
 * respected); afterwards its changes are merged back file by file. The user's index and branches are
 * never touched.
 */

const IDENTITY = {
  GIT_AUTHOR_NAME: "agent",
  GIT_AUTHOR_EMAIL: "agent@localhost",
  GIT_COMMITTER_NAME: "agent",
  GIT_COMMITTER_EMAIL: "agent@localhost",
};

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", input, maxBuffer: 256 << 20, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

export function gitRoot(cwd: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
}

/** A commit with the whole working tree of `dir` as it is now, built in a temporary index. */
export function snapshot(dir: string): string {
  const index = join(tmpdir(), `agent-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: index, ...IDENTITY };
  try {
    let parent: string | undefined;
    try {
      parent = git(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
      git(dir, ["read-tree", parent], env); // start from HEAD so `add` only hashes what changed
    } catch {
      parent = undefined; // a repository without commits yet
    }
    git(dir, ["add", "-A", "."], env);
    const tree = git(dir, ["write-tree"], env);
    return git(dir, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "agent: snapshot for a subagent worktree"], env);
  } finally {
    try {
      unlinkSync(index);
    } catch {}
  }
}

export interface Worktree {
  path: string;
  /** the snapshot it started from */
  base: string;
  root: string;
}

/** ~/.agent/worktrees/<project>-<hash>/<id>: outside the project, so it never shows up in its git status. */
export function createWorktree(root: string, id: string, home = homedir()): Worktree {
  const base = snapshot(root);
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 8);
  const path = join(home, ".agent", "worktrees", `${basename(root)}-${hash}`, id);
  if (existsSync(path)) removeWorktree({ path, base, root });
  mkdirSync(dirname(path), { recursive: true });
  git(root, ["worktree", "add", "--detach", "-q", path, base]);
  return { path, base, root };
}

export function removeWorktree(wt: Worktree) {
  try {
    git(wt.root, ["worktree", "remove", "--force", wt.path]);
  } catch {
    rmSync(wt.path, { recursive: true, force: true });
    try {
      git(wt.root, ["worktree", "prune"]);
    } catch {}
  }
}

function blob(root: string, commit: string, path: string): Buffer | null {
  const r = spawnSync("git", ["cat-file", "blob", `${commit}:${path}`], { cwd: root, maxBuffer: 256 << 20 });
  return r.status === 0 ? r.stdout : null;
}

function readOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

const same = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b));
const binary = (b: Buffer | null) => !!b && b.subarray(0, 8000).includes(0);

export interface MergeResult {
  /** paths (relative to the project root) whose changes were applied cleanly */
  merged: string[];
  /** paths where the project and the subagent changed the same lines: conflict markers were written */
  conflicts: string[];
  /** paths that could not be merged at all (binary or deleted on one side): left as they are in the project */
  skipped: string[];
}

/**
 * Brings the worktree's changes (since its snapshot) into the project. Files the project did not touch
 * meanwhile are copied; files both changed get a three-way merge (git merge-file).
 */
export function mergeBack(wt: Worktree, changes?: ChangeTracker): MergeResult {
  const result = snapshot(wt.path);
  const res: MergeResult = { merged: [], conflicts: [], skipped: [] };
  const list = git(wt.root, ["diff", "--name-status", "--no-renames", "-z", wt.base, result]);
  const parts = list.split("\0").filter(Boolean);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const rel = parts[i + 1];
    const abs = join(wt.root, rel);
    const base = blob(wt.root, wt.base, rel);
    const theirs = status === "D" ? null : blob(wt.root, result, rel);
    const ours = readOrNull(abs);
    const write = (content: Buffer | null) => {
      changes?.beforeWrite(abs, "Agent");
      if (content === null) rmSync(abs, { force: true });
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
      changes?.afterWrite(abs);
    };
    if (same(ours, theirs)) continue; // already the same
    if (same(ours, base)) {
      write(theirs); // the project didn't touch it: take the subagent's version
      res.merged.push(rel);
      continue;
    }
    if (ours === null || theirs === null || binary(ours) || binary(theirs) || binary(base)) {
      res.skipped.push(rel);
      continue;
    }
    const dir = join(tmpdir(), `agent-merge-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const [o, b, t] = ["ours", "base", "theirs"].map((n) => join(dir, n));
      writeFileSync(o, ours);
      writeFileSync(b, base ?? "");
      writeFileSync(t, theirs);
      const m = spawnSync("git", ["merge-file", "-p", "-L", "project", "-L", "before", "-L", "subagent", o, b, t], { maxBuffer: 256 << 20 });
      if (m.status === null || m.status < 0) {
        res.skipped.push(rel);
        continue;
      }
      write(m.stdout);
      (m.status === 0 ? res.merged : res.conflicts).push(rel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return res;
}
