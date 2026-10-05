import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { runProcess } from "../util.ts";

/**
 * Snapshots of the project in a separate ("shadow") git repository, taken before every tool call that
 * may change files, Bash included. The project's own git (if any) is never touched; .gitignore'd files
 * (node_modules, build output) are not saved. Works in folders that aren't git repositories too.
 */

export interface Checkpoint {
  /** 1, 2, 3… in this session */
  n: number;
  commit: string;
  tree: string;
  at: Date;
  /** the user's message of the turn it belongs to */
  turn: string;
  /** history length before that turn's user message (for restoring the conversation) */
  history: number;
  /** what was about to run: "Edit(src/a.ts)", "Bash(npm install)" */
  before: string;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "agent checkpoint",
  GIT_AUTHOR_EMAIL: "agent@localhost",
  GIT_COMMITTER_NAME: "agent checkpoint",
  GIT_COMMITTER_EMAIL: "agent@localhost",
};

/** the first snapshot of a huge folder (hashing every file) must not stall the agent forever */
const FIRST_SNAPSHOT_LIMIT_MS = 20_000;

export class Checkpoints {
  readonly list: Checkpoint[] = [];
  /** why checkpoints are off (too big, git missing…) */
  disabled: string | undefined;
  readonly gitDir: string;
  private cwd: string;
  private ready: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(cwd: string, home = homedir()) {
    this.cwd = cwd;
    const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 10);
    this.gitDir = join(home, ".agent", "checkpoints", `${basename(cwd) || "root"}-${hash}`);
  }

  private async git(args: string[], timeoutMs = 120_000): Promise<string> {
    const r = await runProcess("git", [`--git-dir=${this.gitDir}`, `--work-tree=${this.cwd}`, ...args], {
      cwd: this.cwd,
      env: { ...process.env, ...IDENTITY, GIT_INDEX_FILE: join(this.gitDir, "index") },
      timeoutMs,
    });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || `git ${args[0]} failed`);
    return r.stdout.trim();
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      if (!existsSync(join(this.gitDir, "HEAD"))) {
        mkdirSync(this.gitDir, { recursive: true });
        const r = await runProcess("git", ["init", "-q", "--bare", this.gitDir], { cwd: this.cwd });
        if (r.code !== 0) throw new Error(r.stderr.trim() || "git init failed");
        mkdirSync(join(this.gitDir, "info"), { recursive: true });
        // nested repositories and dependency folders are not ours to snapshot (.gitignore is honoured as well)
        writeFileSync(join(this.gitDir, "info", "exclude"), ".git\nnode_modules/\n.venv/\n__pycache__/\n");
        await this.git(["config", "core.autocrlf", "false"]);
      }
      void runProcess("git", [`--git-dir=${this.gitDir}`, "gc", "--auto", "-q"], { cwd: this.cwd });
    })();
    return this.ready;
  }

  /** git add -A + write-tree in the shadow index: the tree id of the folder as it is now */
  private async currentTree(): Promise<string> {
    await this.git(["add", "-A", "--ignore-errors", "."]).catch(async (e) => {
      // unreadable files make `add` fail; --ignore-errors already added the rest
      if (!/unable to|permission denied|ignore-errors/i.test(String(e))) throw e;
    });
    return this.git(["write-tree"]);
  }

  /**
   * A checkpoint before a changing tool call. Calls are serialized (parallel subagents share one index).
   * A new entry is made only when the folder changed since the last one or a new turn started.
   */
  snapshot(meta: Omit<Checkpoint, "n" | "commit" | "tree" | "at">): Promise<Checkpoint | undefined> {
    const job = this.queue.then(() => this.snapshotNow(meta));
    this.queue = job.catch(() => {});
    return job;
  }

  private async snapshotNow(meta: Omit<Checkpoint, "n" | "commit" | "tree" | "at">): Promise<Checkpoint | undefined> {
    if (this.disabled) return undefined;
    const first = !this.list.length;
    const t0 = Date.now();
    try {
      await this.init();
      const tree = await this.currentTree();
      const last = this.list.at(-1);
      if (last && last.tree === tree && last.turn === meta.turn && last.history === meta.history) return last;
      const parent = last?.commit ?? (await this.git(["rev-parse", "-q", "--verify", "refs/heads/checkpoints"]).catch(() => ""));
      const commit = await this.git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `before ${meta.before}\n\nturn: ${meta.turn.slice(0, 200)}`]);
      await this.git(["update-ref", "refs/heads/checkpoints", commit]);
      const cp: Checkpoint = { ...meta, n: this.list.length + 1, commit, tree, at: new Date() };
      this.list.push(cp);
      return cp;
    } catch (e) {
      this.disabled = `checkpoints are off: ${(e as Error).message}`;
      return undefined;
    } finally {
      if (first && Date.now() - t0 > FIRST_SNAPSHOT_LIMIT_MS) {
        this.disabled = `checkpoints are off: the first snapshot took ${Math.round((Date.now() - t0) / 1000)}s (too many files; add them to .gitignore or set "checkpoints": false)`;
      }
    }
  }

  /** Files that differ between a checkpoint and the folder now: [status, path] (A = created since, D = deleted since). */
  async changedSince(cp: Checkpoint): Promise<[string, string][]> {
    const job = this.queue.then(async () => {
      const now = await this.currentTree();
      const out = await this.git(["diff", "--name-status", "--no-renames", "-z", cp.tree, now]);
      const parts = out.split("\0").filter(Boolean);
      const res: [string, string][] = [];
      for (let i = 0; i + 1 < parts.length; i += 2) res.push([parts[i][0], parts[i + 1]]);
      return res;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  /**
   * Puts the files back as they were at the checkpoint: changed and deleted files are restored, files
   * created since are removed. A checkpoint of the current state is made first, so a restore can be undone.
   */
  async restoreFiles(cp: Checkpoint, turn: string, history: number): Promise<{ restored: string[]; removed: string[]; undo?: Checkpoint }> {
    const undo = await this.snapshot({ turn, history, before: `restore to #${cp.n}` });
    const changed = await this.changedSince(cp);
    const job = this.queue.then(async () => {
      const restored = changed.filter(([s]) => s !== "A").map(([, p]) => p);
      const removed = changed.filter(([s]) => s === "A").map(([, p]) => p);
      if (restored.length) {
        // `checkout <commit> -- paths` writes the files with their modes; paths go via stdin (no argv limits)
        const r = await runProcess(
          "git",
          [`--git-dir=${this.gitDir}`, `--work-tree=${this.cwd}`, "checkout", cp.commit, "--pathspec-from-file=-", "--pathspec-file-nul"],
          { cwd: this.cwd, env: { ...process.env, ...IDENTITY, GIT_INDEX_FILE: join(this.gitDir, "index") }, input: restored.join("\0") + "\0" },
        );
        if (r.code !== 0) throw new Error(r.stderr.trim() || "git checkout failed");
      }
      for (const p of removed) rmSync(join(this.cwd, p), { force: true });
      return { restored, removed, undo };
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
