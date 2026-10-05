import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { diffStat } from "../ui/diff.ts";

/** Files bigger than this are tracked but not snapshotted (so they cannot be undone). */
const MAX_SNAPSHOT = 2 * 1024 * 1024;

/** A file's content, null if it does not exist, or UNTRACKABLE for binary/huge files. */
const UNTRACKABLE = Symbol("untrackable");
type Snap = string | null | typeof UNTRACKABLE;

export interface FileChange {
  path: string;
  /** content at session start; null = did not exist */
  base: string | null;
  tools: Set<string>;
  writes: number;
  /** binary or > 2 MB: recorded but not snapshotted, so it cannot be restored */
  untracked?: boolean;
}

export interface ChangedFile {
  path: string;
  status: "A" | "M" | "D";
  added: number;
  removed: number;
  tools: string[];
  writes: number;
}

interface Checkpoint {
  turn: string;
  /** content of each file touched this turn, before its first write in the turn */
  files: Map<string, Snap>;
}

function snap(path: string): Snap {
  try {
    if (statSync(path).size > MAX_SNAPSHOT) return UNTRACKABLE;
    const text = readFileSync(path, "utf8");
    return text.includes("\0") ? UNTRACKABLE : text;
  } catch {
    return null;
  }
}

/** The text of a file now: null if missing, undefined if binary or too big to diff. */
export function readText(path: string): string | null | undefined {
  const s = snap(path);
  return s === UNTRACKABLE ? undefined : s;
}

function restore(path: string, content: string | null) {
  if (content === null) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Every file the agent (and its subagents) wrote this session: its content at session start, plus a
 * checkpoint per user turn so the last turn can be undone. Paths are absolute.
 */
export class ChangeTracker {
  readonly files = new Map<string, FileChange>();
  private checkpoints: Checkpoint[] = [];
  /** content right before the write in progress, for afterWrite */
  private pending = new Map<string, Snap>();

  beginTurn(prompt: string) {
    const last = this.checkpoints.at(-1);
    if (last && !last.files.size) this.checkpoints.pop(); // a turn that wrote nothing is not worth keeping
    this.checkpoints.push({ turn: prompt, files: new Map() });
  }

  beforeWrite(absPath: string, tool: string) {
    const now = snap(absPath);
    let fc = this.files.get(absPath);
    if (!fc) {
      fc = { path: absPath, base: now === UNTRACKABLE ? null : now, tools: new Set(), writes: 0, untracked: now === UNTRACKABLE || undefined };
      this.files.set(absPath, fc);
    }
    fc.tools.add(tool);
    fc.writes++;
    if (!this.checkpoints.length) this.beginTurn("");
    const cp = this.checkpoints.at(-1)!;
    if (!cp.files.has(absPath)) cp.files.set(absPath, now);
    this.pending.set(absPath, now);
  }

  afterWrite(absPath: string): { before: string | null; after: string | null } | undefined {
    if (!this.pending.has(absPath)) return undefined;
    const before = this.pending.get(absPath)!;
    this.pending.delete(absPath);
    const after = snap(absPath);
    if (before === UNTRACKABLE || after === UNTRACKABLE) {
      this.files.get(absPath)!.untracked = true;
      return undefined;
    }
    return { before, after };
  }

  /** Changed files compared with the session start (files written back to their original content are left out). */
  list(): ChangedFile[] {
    const out: ChangedFile[] = [];
    for (const fc of this.files.values()) {
      const now = snap(fc.path);
      const tools = [...fc.tools];
      if (fc.untracked || now === UNTRACKABLE) {
        out.push({ path: fc.path, status: now === null ? "D" : fc.base === null && !fc.untracked ? "A" : "M", added: 0, removed: 0, tools, writes: fc.writes });
        continue;
      }
      if (now === fc.base) continue;
      const { added, removed } = diffStat(fc.base ?? "", now ?? "");
      out.push({ path: fc.path, status: fc.base === null ? "A" : now === null ? "D" : "M", added, removed, tools, writes: fc.writes });
    }
    return out;
  }

  /** Session-start content of a tracked file (undefined if untracked or not restorable). */
  base(absPath: string): string | null | undefined {
    const fc = this.files.get(absPath);
    return !fc || fc.untracked ? undefined : fc.base;
  }

  /** How many files the current turn has written so far. */
  writesThisTurn(): number {
    return this.checkpoints.at(-1)?.files.size ?? 0;
  }

  /** Files of the last turn that changed something (what undo() would restore), without touching anything. */
  peekUndo(): { turn: string; paths: string[] } | undefined {
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      const paths = this.changedIn(this.checkpoints[i]);
      if (paths.length) return { turn: this.checkpoints[i].turn, paths };
    }
    return undefined;
  }

  private changedIn(cp: Checkpoint): string[] {
    return [...cp.files].filter(([p, s]) => s === UNTRACKABLE || snap(p) !== s).map(([p]) => p);
  }

  /**
   * Restores the files of the last turn that actually changed something to how they were before it
   * (files it created are deleted) and drops that checkpoint. notRestored lists binary/huge files.
   */
  undo(): { turn: string; paths: string[]; notRestored: string[] } | undefined {
    while (this.checkpoints.length) {
      const cp = this.checkpoints.pop()!;
      const changed = this.changedIn(cp);
      if (!changed.length) continue;
      const paths: string[] = [];
      const notRestored: string[] = [];
      for (const p of changed) {
        const s = cp.files.get(p)!;
        if (s === UNTRACKABLE) notRestored.push(p);
        else {
          restore(p, s);
          paths.push(p);
        }
      }
      return { turn: cp.turn, paths, notRestored };
    }
    return undefined;
  }

  /** Restores one file (or all) to the session start; returns the paths actually restored. */
  revert(absPath?: string): string[] {
    const targets = absPath ? [this.files.get(absPath)].filter((f) => f !== undefined) : [...this.files.values()];
    const done: string[] = [];
    for (const fc of targets) {
      if (fc.untracked) continue;
      if (snap(fc.path) !== fc.base) {
        restore(fc.path, fc.base);
        done.push(fc.path);
      }
      this.files.delete(fc.path);
      for (const cp of this.checkpoints) cp.files.delete(fc.path);
    }
    return done;
  }
}
