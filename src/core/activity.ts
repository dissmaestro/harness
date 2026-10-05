import { argSummary } from "../ui/render.ts";
import { oneLine } from "../util.ts";

export type ActivityState = "running" | "done" | "failed";
export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** What one agent (the main one or a subagent) is doing right now: shown by /status, the footer and side questions. */
export class Activity {
  /** 0 for the main agent, then #1, #2… in start order */
  readonly id: number;
  /** "main" or the subagent type */
  readonly type: string;
  readonly description: string;
  readonly parent: Activity | undefined;
  readonly children: Activity[] = [];
  state: ActivityState = "running";
  startedAt = Date.now();
  endedAt: number | undefined;
  step = 0;
  maxSteps: number;
  tool: { name: string; summary: string; since: number } | undefined;
  todos: Todo[] = [];
  /** the last line of text the model wrote */
  lastText = "";
  contextUsed = 0;
  contextWindow = 0;
  /** set when the subagent works in its own git worktree */
  worktree: string | undefined;
  /** messages typed by the user for this agent while it works (">#2 text") */
  notes: string[] = [];
  private board: ActivityBoard;

  constructor(board: ActivityBoard, id: number, type: string, description: string, maxSteps: number, parent?: Activity) {
    this.board = board;
    this.id = id;
    this.type = type;
    this.description = description;
    this.maxSteps = maxSteps;
    this.parent = parent;
  }

  get label(): string {
    return this.id ? `#${this.id} ${this.type}` : "main";
  }

  update(patch: Partial<Pick<Activity, "step" | "maxSteps" | "tool" | "todos" | "lastText" | "contextUsed" | "contextWindow" | "worktree">>) {
    Object.assign(this, patch);
    this.board.changed();
  }

  /** a new turn of the main agent: clock and counters start over, finished subagents are forgotten */
  restart() {
    this.state = "running";
    this.startedAt = Date.now();
    this.endedAt = undefined;
    this.step = 0;
    this.tool = undefined;
    this.lastText = "";
    this.children.length = 0;
    this.board.changed();
  }

  finish(state: ActivityState) {
    this.state = state;
    this.endedAt = Date.now();
    this.tool = undefined;
    this.board.changed();
  }

  setText(text: string) {
    const last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
    if (last && last !== this.lastText) {
      this.lastText = last;
      this.board.changed();
    }
  }

  /** "2/5" from the TodoWrite list, or "" */
  todoProgress(): string {
    if (!this.todos.length) return "";
    return `${this.todos.filter((t) => t.status === "completed").length}/${this.todos.length}`;
  }

  currentTodo(): string | undefined {
    return this.todos.find((t) => t.status === "in_progress")?.content;
  }

  elapsed(now = Date.now()): number {
    return (this.endedAt ?? now) - this.startedAt;
  }

  running(): Activity[] {
    return this.children.filter((c) => c.state === "running");
  }
}

/** The tree of activities of one session; the main agent is the root. */
export class ActivityBoard {
  readonly root: Activity;
  private nextId = 1;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly cwd: string;

  constructor(cwd: string, maxSteps: number) {
    this.cwd = cwd;
    this.root = new Activity(this, 0, "main", "", maxSteps);
    this.root.state = "done";
  }

  add(parent: Activity, type: string, description: string, maxSteps: number): Activity {
    const a = new Activity(this, this.nextId++, type, description, maxSteps, parent);
    parent.children.push(a);
    this.changed();
    return a;
  }

  find(id: number): Activity | undefined {
    const walk = (a: Activity): Activity | undefined => (a.id === id ? a : a.children.map(walk).find(Boolean));
    return walk(this.root);
  }

  all(): Activity[] {
    const out: Activity[] = [];
    const walk = (a: Activity) => {
      out.push(a);
      a.children.forEach(walk);
    };
    walk(this.root);
    return out;
  }

  /** onChange listeners are called at most every 100ms */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const fn of this.listeners) fn();
    }, 100);
    this.timer.unref?.();
  }

  /** Plain-text description of every agent, for answering "what is going on?" */
  snapshot(now = Date.now()): string {
    const lines: string[] = [];
    const walk = (a: Activity, depth: number) => {
      const pad = "  ".repeat(depth);
      const head = `${pad}- ${a.label}${a.description ? ` "${a.description}"` : ""}: ${a.state}, step ${a.step}/${a.maxSteps}, ${formatDuration(a.elapsed(now))}` +
        (a.worktree ? `, in worktree ${a.worktree}` : "") +
        (a.contextWindow ? `, context ${a.contextUsed}/${a.contextWindow} tokens` : "");
      lines.push(head);
      if (a.tool) lines.push(`${pad}  now running: ${a.tool.name}(${a.tool.summary}) for ${formatDuration(now - a.tool.since)}`);
      if (a.todos.length) {
        lines.push(`${pad}  checklist (${a.todoProgress()} done):`);
        for (const t of a.todos) lines.push(`${pad}    [${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${oneLine(t.content, 120)}`);
      }
      if (a.lastText) lines.push(`${pad}  last said: ${oneLine(a.lastText, 200)}`);
      a.children.forEach((c) => walk(c, depth + 1));
    };
    walk(this.root, 0);
    return lines.join("\n");
  }

  toolSummary(name: string, args: Record<string, unknown>): string {
    return argSummary(name, args, this.cwd);
  }
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
