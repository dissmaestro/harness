import { statSync } from "node:fs";
import { join, relative } from "node:path";
import { runHooks, type HookResult } from "../hooks/hooks.ts";
import { ChatError, chat, fetchContextWindow, isContextOverflow, type ChatResult, type Timings, type Usage } from "../providers/openai.ts";
import { extractTextToolCalls, looksTruncated, parseJsonLenient, stripThinking } from "../providers/toolcall-parse.ts";
import type { AgentDef, Registry } from "../registry/registry.ts";
import { EXIT_PLAN_MODE } from "../tools/session-tools.ts";
import { USE_TOOL } from "../tools/UseTool.ts";
import type { Message, Session, Tool, ToolCall, ToolContext } from "../types.ts";
import { oneLine, resolvePath, saveFullOutput, truncateMiddle } from "../util.ts";
import { Activity, ActivityBoard, type Todo } from "./activity.ts";
import { ChangeTracker } from "./changes.ts";
import { type Checkpoint, Checkpoints } from "./checkpoints.ts";
import { type MergeResult, type Worktree, createWorktree, gitRoot, mergeBack, removeWorktree } from "./worktree.ts";
import { COMPACT_REQUEST, PLAN_MODE_OFF, PLAN_MODE_ON, buildSystemPrompt, reminder } from "./context.ts";
import { MODES, decide, isReadOnlyCommand, type Mode } from "./modes.ts";
import { failureReport, runChecks } from "./verify.ts";
import { SessionJournal, readSession, sanitizeHistory } from "./sessions.ts";
import type { Settings } from "./settings.ts";
import { coerceArgs, validateArgs } from "./validate.ts";

export type Approval = "yes" | "always" | "no";

export interface PlanDecision {
  approved: boolean;
  /** mode to continue in after approval */
  mode?: Mode;
  feedback?: string;
}

/** What one Edit/Write actually did to a file (for showing a real diff). */
export interface FileWrite {
  path: string;
  before: string | null;
  after: string | null;
}

export interface AgentUI {
  onText(text: string): void;
  onReasoning?(text: string): void;
  /** true while waiting for the model (before its first output) */
  onWaiting?(waiting: boolean): void;
  onToolStart(name: string, args: Record<string, unknown>): void;
  onToolEnd(name: string, result: string, isError: boolean, change?: FileWrite): void;
  onInfo(message: string): void;
  confirm(tool: Tool, args: Record<string, unknown>, reason?: string): Promise<Approval>;
  /** interactive plan approval; without it plans are returned to the caller as text */
  approvePlan?(plan: string): Promise<PlanDecision>;
  /** UI for a subagent's activity (e.g. indented); `id` is its number on the activity board */
  child?(label: string, id?: number): AgentUI;
}

export interface AgentOptions {
  cwd: string;
  settings: Settings;
  registry: Registry;
  home?: string;
  maxSteps?: number;
  mode?: Mode;
  /** set for subagents */
  subagent?: AgentDef;
  /** write the conversation to ~/.agent/sessions so it survives a crash (the CLI turns this on) */
  persist?: boolean;
  /** shared with subagents so /diff and /undo see every change */
  changes?: ChangeTracker;
  /** a subagent's entry on its parent's activity board */
  activity?: Activity;
  board?: ActivityBoard;
}

const MAX_STOP_HOOK_RETRIES = 3;
/** a subagent's report longer than this is cut (the full text is saved to a file) to protect the main context */
const REPORT_MAX = 8_000;

export interface SubagentRunOptions {
  /** run a writing subagent in its own git worktree and merge its changes back afterwards */
  isolate?: boolean;
}
const DEFAULT_CONTEXT = 32_768;
/** a text answer cut off by the token limit is continued automatically this many times */
const MAX_CONTINUATIONS = 2;
/** the same call with the same arguments: warn at this count, end the turn at the second */
const REPEAT_WARN = 3;
const REPEAT_STOP = 5;
/** tools every subagent may use regardless of its tools list */
const SUBAGENT_IMPLICIT = new Set(["ToolSearch", "UseTool", "Skill", "TodoWrite"]);
/** tools no subagent may use */
const SUBAGENT_FORBIDDEN = new Set(["Agent", EXIT_PLAN_MODE]);

const TRUNCATED_CALL =
  "Error: your output hit the token limit while writing this tool call, so its arguments are incomplete and it was NOT executed. " +
  "Send it again in smaller pieces: for a big file, Write a short skeleton first and then add the rest with several Edit calls.";
const USER_NOTES = (notes: string[]) =>
  `The user wrote this while you were working. Take it into account now (it may change what you should do next):\n${notes.map((n) => `- ${n}`).join("\n")}`;
const ASIDE_PROMPT =
  "You answer the user's questions about a coding agent that is working right now in their terminal. " +
  "You get a snapshot of every agent (main agent and subagents: step, running tool, checklist) and the main agent's latest messages. " +
  "Answer briefly and concretely from that information: what is being done, at which stage, what is left. " +
  "Do not invent progress that is not in the snapshot; say so when you cannot tell. Answer in the language of the question.";
const EMPTY_REPLY = "Your last reply was empty. Continue the task, or if it is finished, give your final answer to the user.";
const FINAL_STEP = (why: string) =>
  `${why} Do not call any more tools. Write your final answer now: what you did, what you found, and what is left to do.`;

export class Agent {
  cwd: string;
  settings: Settings;
  registry: Registry;
  home?: string;
  messages: Message[] = [];
  maxSteps: number;
  mode: Mode;
  subagent?: AgentDef;
  lastUsage: Usage | undefined;
  lastTimings: Timings | undefined;
  /** files changed by this agent and its subagents (for /files, /diff, /undo) */
  changes: ChangeTracker;
  journal: SessionJournal | undefined;
  /** called whenever the mode changes (UI redraws its prompt) */
  onModeChange?: (mode: Mode) => void;
  sessionAllowed = new Set<string>();
  /** a subagent follows its parent's mode, so shift+tab during its run applies to it too */
  parent: Agent | undefined;
  /** a command that may change files ran during this turn (for automatic verification) */
  private execRan = false;
  /** shadow-git snapshots before changing tool calls (the main agent's; subagents in the same folder share it) */
  private checkpointStore: Checkpoints | undefined;
  private checkpointWarned = false;
  /** the current turn of the main agent: its message and the history length before it */
  private turn = { prompt: "", history: 0 };
  /** what every agent of this session is doing (shared with subagents) */
  board: ActivityBoard;
  activity: Activity;
  private persist: boolean;
  private systemPrompt: string;
  private lastCatalog = "";
  private pendingReminders: string[] = [];
  private readFiles = new Map<string, number>();
  private usageAtMessages = 0;
  private contextWindowCache: number | undefined;

  constructor(opts: AgentOptions) {
    this.cwd = opts.cwd;
    this.settings = opts.settings;
    this.registry = opts.registry;
    this.home = opts.home;
    this.subagent = opts.subagent;
    this.maxSteps = opts.maxSteps ?? (opts.subagent ? 30 : 60);
    this.mode = opts.mode ?? opts.settings.permissionMode;
    this.persist = !!opts.persist && !opts.subagent;
    this.changes = opts.changes ?? new ChangeTracker();
    this.board = opts.board ?? new ActivityBoard(opts.cwd, this.maxSteps);
    this.activity = opts.activity ?? this.board.root;
    this.systemPrompt = buildSystemPrompt(opts.cwd, opts.settings, opts.home, opts.subagent);
    this.reset();
  }

  reset() {
    this.messages = [{ role: "system", content: this.systemPrompt }];
    this.lastCatalog = "";
    this.readFiles.clear();
    this.lastUsage = undefined;
    this.usageAtMessages = 0;
    this.pendingReminders = this.mode === "plan" && !this.subagent ? [PLAN_MODE_ON] : [];
    // a new conversation gets a new journal file (written lazily, on the first message)
    this.journal = this.persist ? new SessionJournal(this.cwd, this.settings.model, this.home) : undefined;
  }

  /** Every message goes through here so the journal always matches the history. */
  private push(m: Message) {
    this.messages.push(m);
    this.journal?.append(m);
  }

  private replaceHistory(messages: Message[]) {
    this.messages = messages;
    this.journal?.reset(messages);
  }

  /**
   * Continues a saved session: the history is repaired (dangling tool calls get results), the system prompt is
   * rebuilt for today, and new messages are appended to the same journal.
   */
  loadSession(file: string, id: string) {
    const saved = sanitizeHistory(readSession(file).filter((m) => m.role !== "system"));
    this.journal = this.persist ? new SessionJournal(this.cwd, this.settings.model, this.home, id) : undefined;
    this.messages = [{ role: "system", content: this.systemPrompt }, ...saved];
    this.lastCatalog = "";
    this.readFiles.clear();
    this.lastUsage = undefined;
    this.usageAtMessages = 0;
    this.pendingReminders.push("This conversation was restored from a saved session. Files may have changed since: re-read them before editing.");
  }

  /**
   * Continues in a new session that starts as a copy of this one (the original stays as it is and can be
   * resumed with /resume or agent --resume).
   */
  fork(label?: string): { from: string | undefined; to: string } {
    const from = this.journal?.id;
    this.journal = new SessionJournal(this.cwd, this.settings.model, this.home, undefined, { parent: from, label });
    this.journal.reset(this.messages);
    return { from, to: this.journal.id };
  }

  /** Queues a note for the model; it is sent with the next user message or tool result. */
  notify(text: string) {
    this.pendingReminders.push(text);
  }

  /** The user changed files behind the model's back (e.g. /undo): forget their read state and tell the model. */
  notifyFilesChanged(paths: string[], message: string) {
    for (const p of paths) this.readFiles.delete(p);
    this.notify(message);
  }

  /** Always the same list, in the same order: changing it would invalidate the server's prompt cache. */
  get modelTools(): Tool[] {
    return [...this.registry.core.values()];
  }

  setMode(mode: Mode, opts: { silent?: boolean } = {}) {
    if (mode === this.mode) return;
    const was = this.mode;
    this.mode = mode;
    if (!opts.silent && !this.subagent) {
      if (mode === "plan") this.pendingReminders.push(PLAN_MODE_ON);
      else if (was === "plan") this.pendingReminders.push(PLAN_MODE_OFF(MODES[mode].label));
    }
    this.onModeChange?.(mode);
  }

  // ---------- checkpoints ----------

  /** The checkpoint store of this folder (none for a subagent working in its own worktree). */
  get checkpoints(): Checkpoints | undefined {
    const root = this.parent ?? this;
    if (root !== this) return root.cwd === this.cwd ? root.checkpoints : undefined;
    if (this.settings.checkpoints === false) return undefined;
    this.checkpointStore ??= new Checkpoints(this.cwd, this.home);
    return this.checkpointStore;
  }

  private async checkpoint(before: string, ui: AgentUI) {
    const store = this.checkpoints;
    if (!store) return;
    const root = this.parent ?? this;
    await store.snapshot({ turn: root.turn.prompt, history: root.turn.history, before });
    if (store.disabled && !root.checkpointWarned) {
      root.checkpointWarned = true;
      ui.onInfo(store.disabled);
    }
  }

  /**
   * Goes back to a checkpoint: "files" puts the files back, "chat" drops the conversation from that
   * checkpoint's turn on, "both" does both. Returns the turn's message (to edit and send again).
   */
  async restore(n: number, what: "files" | "chat" | "both"): Promise<{ cp: Checkpoint; restored: string[]; removed: string[] }> {
    const store = this.checkpoints;
    const cp = store?.list.find((c) => c.n === n);
    if (!store || !cp) throw new Error(`No checkpoint #${n}. /restore lists them.`);
    let restored: string[] = [];
    let removed: string[] = [];
    if (what !== "chat") ({ restored, removed } = await store.restoreFiles(cp, this.turn.prompt, this.messages.length));
    if (what !== "files") {
      this.replaceHistory(sanitizeHistory(this.messages.slice(0, Math.max(1, cp.history))));
      this.readFiles.clear();
      this.lastUsage = undefined;
      this.usageAtMessages = 0;
    }
    const paths = [...restored, ...removed];
    if (paths.length) {
      const message =
        `The user restored the project files to how they were before "${cp.before}" (checkpoint #${cp.n}). ` +
        `Changed back: ${paths.slice(0, 30).join(", ")}${paths.length > 30 ? ", …" : ""}. Re-read files before editing them.`;
      this.notifyFilesChanged(paths.map((p) => join(this.cwd, p)), message);
    }
    return { cp, restored, removed };
  }

  // ---------- verification ----------

  /**
   * After a turn that changed files: runs the configured lint and test commands; on failure the output
   * goes back to the model to fix, up to verify.maxFixes times.
   */
  private async verifyLoop(answer: string, ui: AgentUI, signal: AbortSignal): Promise<string> {
    const cfg = this.settings.verify;
    if (!cfg || cfg.auto === false || (!cfg.test && !cfg.lint)) return answer;
    if (!this.changes.writesThisTurn() && !this.execRan) return answer;
    const max = cfg.maxFixes ?? 3;
    for (let fix = 0; !signal.aborted; fix++) {
      const t0 = Date.now();
      const results = await runChecks(cfg, this.cwd, signal, (name, command) => {
        this.activity.update({ tool: { name: "verify", summary: command, since: Date.now() } });
        ui.onInfo(`verify (${name}): ${command}`);
      });
      this.activity.update({ tool: undefined });
      if (signal.aborted) break;
      const failed = results.find((r) => !r.ok);
      if (!failed) {
        ui.onInfo(`verify: ${results.map((r) => `${r.name} ✓`).join(", ")} (${Math.round((Date.now() - t0) / 1000)}s)`);
        break;
      }
      if (fix >= max) {
        ui.onInfo(`verify: ${failed.name} still fails after ${max} fix attempts; stopping here`);
        answer += `\n\n(${failed.name} still fails: \`${failed.command}\`)`;
        break;
      }
      ui.onInfo(`verify: ${failed.name} failed (${failed.timedOut ? "timeout" : `exit ${failed.code}`}); the model will fix it (attempt ${fix + 1}/${max})`);
      this.push({ role: "user", content: reminder(failureReport(failed)) });
      answer = await this.runLoop(ui, signal);
    }
    return answer;
  }

  // ---------- talking to running agents ----------

  /** A note for a running agent (the main one, or subagent #id): it gets it with its next step. */
  steer(text: string, id = 0): boolean {
    const a = this.board.find(id);
    if (!a || a.state !== "running") return false;
    a.notes.push(text);
    return true;
  }

  /**
   * Answers a question about the work in progress from the activity board and the latest messages,
   * in a separate request: no tools, nothing is added to the history.
   */
  async askAside(question: string, signal: AbortSignal): Promise<string> {
    const tail = this.messages
      .slice(1)
      .slice(-8)
      .map((m) => {
        const calls = m.role === "assistant" && m.tool_calls?.length ? ` (called ${m.tool_calls.map((t) => t.function.name).join(", ")})` : "";
        return `[${m.role}${calls}] ${truncateMiddle(String(m.content ?? ""), 1500)}`;
      })
      .join("\n\n");
    const res = await chat(this.settings, {
      messages: [
        { role: "system", content: ASIDE_PROMPT },
        {
          role: "user",
          content: `Agents right now:\n${this.board.snapshot()}\n\nLatest messages of the main agent (oldest first):\n${tail || "(none yet)"}\n\nQuestion: ${question}`,
        },
      ],
      tools: [],
      signal,
      maxTokens: 1024,
    });
    return stripThinking(res.content).trim();
  }

  // ---------- context accounting ----------

  async contextWindow(): Promise<number> {
    if (this.settings.contextWindow) return this.settings.contextWindow;
    this.contextWindowCache ??= (await fetchContextWindow(this.settings.baseUrl, this.settings.apiKey)) ?? DEFAULT_CONTEXT;
    return this.contextWindowCache;
  }

  /** Tokens in the conversation: the last exact count from the server plus an estimate for newer messages. */
  contextUsed(): number {
    const base = this.lastUsage ? this.lastUsage.prompt_tokens + this.lastUsage.completion_tokens : 0;
    const from = this.lastUsage ? this.usageAtMessages : 0;
    const chars = this.messages.slice(from).reduce((n, m) => n + (m.content?.length ?? 0) + JSON.stringify((m as any).tool_calls ?? "").length, 0);
    return base + Math.ceil(chars / 3.5);
  }

  // ---------- main entry ----------

  async send(userText: string, ui: AgentUI, signal: AbortSignal): Promise<string> {
    const hook = await this.hook(ui, "UserPromptSubmit", { prompt: userText }, undefined, signal);
    if (hook.blocked) {
      ui.onInfo(`Prompt blocked by hook: ${hook.feedback}`);
      return "";
    }
    if (!this.subagent) {
      this.changes.beginTurn(userText);
      this.turn = { prompt: userText, history: this.messages.length };
    }
    const extras: string[] = [];
    if (hook.context) extras.push(hook.context);
    // The catalog is appended (never put in the system prompt) and only re-sent when it changes.
    const catalog = this.catalogForThisAgent();
    if (catalog && catalog !== this.lastCatalog) {
      extras.push(catalog);
      this.lastCatalog = catalog;
    }
    extras.push(...this.pendingReminders.splice(0));
    const content = [userText, ...extras.map(reminder)].join("\n\n");
    // After a failed or interrupted turn the history may end with a user message or a dangling tool call:
    // repair it so strict chat templates (alternating roles) keep working.
    const last = this.messages[this.messages.length - 1];
    if (last.role === "user" || (last.role === "assistant" && last.tool_calls?.length)) {
      this.replaceHistory(sanitizeHistory([...this.messages, { role: "user", content }]));
    } else this.push({ role: "user", content });
    if (this.subagent) return this.runLoop(ui, signal);
    this.activity.restart();
    this.execRan = false;
    let state: "done" | "failed" = "failed";
    try {
      let answer = await this.runLoop(ui, signal);
      answer = await this.verifyLoop(answer, ui, signal);
      state = "done";
      return answer;
    } finally {
      this.activity.finish(state);
    }
  }

  private catalogForThisAgent(): string {
    if (!this.subagent) return this.registry.catalog();
    // Subagents get the schemas of their allowed deferred tools up front instead of a catalog.
    const allowed = this.subagent.tools === "*" ? [...this.registry.deferred.keys()] : this.subagent.tools.filter((t) => this.registry.deferred.has(t));
    if (!allowed.length) return "";
    for (const name of allowed) this.registry.loaded.add(name);
    return `Extra tools you can call with UseTool:\n${functionsBlock(this.registry, allowed)}`;
  }

  /** One model request with self-healing: retries (in chat), and one compaction when the context overflows. */
  private async request(ui: AgentUI, signal: AbortSignal): Promise<ChatResult> {
    for (let compacted = false; ; ) {
      ui.onWaiting?.(true);
      let streamed = "";
      try {
        return await chat(this.settings, {
          messages: this.messages,
          tools: this.modelTools,
          signal,
          onText: (t) => {
            ui.onWaiting?.(false);
            ui.onText(t);
            streamed += t;
            this.activity.setText(stripThinking(streamed));
          },
          onReasoning: ui.onReasoning ? (t) => ui.onReasoning!(t) : undefined,
          onRetry: (m) => {
            ui.onWaiting?.(false);
            ui.onInfo(m);
          },
        });
      } catch (e) {
        ui.onWaiting?.(false);
        if (!signal.aborted && isContextOverflow(e) && !compacted) {
          compacted = true;
          ui.onInfo("Context is full: compacting the conversation and retrying…");
          await this.compact(ui, signal, { midTurn: true });
          continue;
        }
        // Keep what the model already said, so after an interrupt it knows where it stopped.
        const partial = stripThinking((e as ChatError)?.partial ?? "");
        if (partial) this.push({ role: "assistant", content: `${partial}\n\n[interrupted${signal.aborted ? " by the user" : ""}]` });
        throw e;
      } finally {
        ui.onWaiting?.(false);
      }
    }
  }

  private async runLoop(ui: AgentUI, signal: AbortSignal): Promise<string> {
    let stopRetries = 0;
    let continuations = 0;
    let emptyRetried = false;
    let finalStep: string | undefined;
    let answer = "";
    const repeats = new Map<string, number>();

    for (let step = 0; ; step++) {
      if (step >= this.maxSteps - 1 && !finalStep) {
        // Out of steps: one last request without tools so the caller still gets a report.
        finalStep = `You have used all ${this.maxSteps} steps for this task.`;
        this.push({ role: "user", content: reminder(FINAL_STEP(finalStep)) });
      }
      if (await this.shouldCompact()) await this.compact(ui, signal, { midTurn: true });

      this.activity.update({ step: step + 1, maxSteps: this.maxSteps });
      const res = await this.request(ui, signal);
      if (res.usage) {
        this.lastUsage = res.usage;
        this.usageAtMessages = this.messages.length;
      }
      this.activity.update({ contextUsed: this.contextUsed(), contextWindow: await this.contextWindow() });
      this.lastTimings = res.timings ?? this.lastTimings;
      const cutOff = res.finishReason === "length";

      let text = stripThinking(res.content);
      let calls = res.toolCalls;
      if (!calls.length) {
        const extracted = extractTextToolCalls(text, this.registry.allToolNames());
        if (extracted.calls.length) {
          text = extracted.rest;
          calls = extracted.calls.map(
            (c, i): ToolCall => ({
              id: `call_${Date.now()}_${i}`,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            }),
          );
        }
      }
      if (finalStep) calls = []; // tools are no longer allowed: whatever it wrote is the answer
      this.push({ role: "assistant", content: text || (calls.length ? null : ""), ...(calls.length && { tool_calls: calls }) });

      if (!calls.length) {
        answer += (answer && text ? "\n" : "") + text;
        if (finalStep) {
          ui.onInfo(finalStep.replace("You have", "The agent has"));
          return answer;
        }
        if (cutOff && continuations++ < MAX_CONTINUATIONS) {
          this.push({ role: "user", content: reminder("Your answer was cut off by the token limit. Continue exactly where you stopped, without repeating anything.") });
          continue;
        }
        if (!text && !emptyRetried) {
          emptyRetried = true;
          this.push({ role: "user", content: reminder(EMPTY_REPLY) });
          continue;
        }
        if (this.activity.notes.length) {
          // the user wrote something while the model was answering: don't end the turn without it
          this.push({ role: "user", content: reminder(USER_NOTES(this.activity.notes.splice(0))) });
          continue;
        }
        const stop = await this.hook(ui, "Stop", { last_message: text }, undefined, signal);
        if (stop.blocked && stopRetries++ < MAX_STOP_HOOK_RETRIES) {
          this.push({ role: "user", content: reminder(`Stop hook feedback:\n${stop.feedback}`) });
          continue;
        }
        return answer;
      }
      answer = "";

      let stopReason: string | undefined;
      const runOne = async (call: ToolCall, i: number, opts: SubagentRunOptions = {}): Promise<string> => {
        if (signal.aborted) return "Tool call cancelled: the user interrupted.";
        if (stopReason) return "Not executed: the turn was stopped.";
        if (cutOff && (i === calls.length - 1 || looksTruncated(call.function.arguments))) {
          // finish_reason "length": the last call was being written when the limit hit; lenient JSON repair
          // would otherwise run it with half its content (e.g. a Write of a truncated file).
          ui.onToolStart(call.function.name, {});
          ui.onToolEnd(call.function.name, TRUNCATED_CALL, true);
          return TRUNCATED_CALL;
        }
        let result = await this.execCall(call, ui, signal, opts);
        const key = `${call.function.name}\0${canonicalArgs(call.function.arguments)}`;
        const n = (repeats.get(key) ?? 0) + 1;
        repeats.set(key, n);
        if (n >= REPEAT_STOP) {
          stopReason = `The model repeated the same ${call.function.name} call ${n} times; stopping this turn.`;
        } else if (n >= REPEAT_WARN) {
          result += `\n\n${reminder(`You have made this exact ${call.function.name} call ${n} times in this task. Repeating it will not give a different result: change your approach, or stop and tell the user what is blocking you.`)}`;
        }
        return result;
      };

      // Consecutive Agent calls run in parallel; everything else runs in order, one at a time.
      const results: string[] = new Array(calls.length);
      for (let i = 0; i < calls.length; ) {
        let j = i;
        while (j < calls.length && calls[j].function.name === "Agent") j++;
        if (j - i > 1 && !this.subagent) {
          await this.runAgentBatch(calls.slice(i, j), (call, k, opts) => runOne(call, i + k, opts), results, i);
          i = j;
        } else {
          results[i] = await runOne(calls[i], i, j > i ? this.isolationFor([calls[i]])(calls[i]) : {});
          i++;
        }
      }
      for (const [i, call] of calls.entries()) {
        let result = results[i];
        // Mode changes and notes typed by the user while the model works go with the next tool result (append-only).
        if (this.pendingReminders.length) result += "\n\n" + this.pendingReminders.splice(0).map(reminder).join("\n");
        if (this.activity.notes.length) result += "\n\n" + reminder(USER_NOTES(this.activity.notes.splice(0)));
        this.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      if (signal.aborted) return "";
      if (stopReason) {
        ui.onInfo(stopReason);
        finalStep = stopReason;
        this.push({ role: "user", content: reminder(FINAL_STEP(stopReason)) });
      }
    }
  }

  // ---------- tools ----------

  private async execCall(call: ToolCall, ui: AgentUI, signal: AbortSignal, opts: SubagentRunOptions = {}): Promise<string> {
    // Servers sometimes glue two XML tool calls into one garbled name ("WebFetch>\n</function>…"): keep the first word.
    let name = /^[\w.-]+$/.test(call.function.name) ? call.function.name : (call.function.name.match(/^[\w.-]+/)?.[0] ?? call.function.name);
    const fail = (msg: string, args: Record<string, unknown> = {}) => {
      ui.onToolStart(name, args);
      ui.onToolEnd(name, msg, true);
      return msg;
    };

    let raw: unknown;
    try {
      raw = call.function.arguments.trim() ? parseJsonLenient(call.function.arguments) : {};
    } catch (e) {
      return fail(`Error: arguments are not valid JSON (${(e as Error).message}). Send a JSON object.`);
    }
    if (name === USE_TOOL) {
      const wrapper = (raw ?? {}) as Record<string, unknown>;
      if (typeof wrapper.name !== "string" || !wrapper.name) {
        return fail('Error: UseTool needs "name" (the tool to call) and "arguments" (an object).');
      }
      name = wrapper.name;
      raw = wrapper.arguments ?? {};
      if (typeof raw === "string") {
        try {
          raw = raw.trim() ? parseJsonLenient(raw) : {};
        } catch (e) {
          return fail(`Error: arguments for ${name} are not valid JSON (${(e as Error).message}).`);
        }
      }
    }
    const resolved = this.registry.resolve(name);
    if (!resolved.tool) return fail(`Error: ${resolved.error}`);
    const tool = resolved.tool;
    const restriction = this.subagentRestriction(name);
    if (restriction) return fail(`Error: ${restriction}`);
    const args = coerceArgs(tool.parameters, (raw ?? {}) as Record<string, unknown>);
    const invalid = validateArgs(tool.parameters, args);
    if (invalid) return fail(`InputValidationError: ${invalid}\nExpected schema: ${JSON.stringify(tool.parameters)}`, args);

    ui.onToolStart(name, args);
    if (name === "TodoWrite" && Array.isArray(args.todos)) this.activity.update({ todos: args.todos as Todo[] });
    this.activity.update({ tool: { name, summary: this.board.toolSummary(name, args), since: Date.now() } });
    try {
      return await this.execPermitted(name, tool, args, ui, signal, opts);
    } finally {
      this.activity.update({ tool: undefined });
    }
  }

  private async execPermitted(name: string, tool: Tool, args: Record<string, unknown>, ui: AgentUI, signal: AbortSignal, opts: SubagentRunOptions): Promise<string> {
    const permission = await this.permit(tool, args, ui);
    if (permission !== true) {
      ui.onToolEnd(name, permission, true);
      return permission;
    }
    const changing = tool.kind === "edit" || (tool.kind === "exec" && !(name === "Bash" && isReadOnlyCommand(String(args.command ?? ""))));
    if (changing && tool.kind === "exec") (this.parent ?? this).execRan = true;
    if (changing) await this.checkpoint(`${name}(${this.board.toolSummary(name, args)})`, ui);
    const pre = await this.hook(ui, "PreToolUse", { tool_name: name, tool_input: args }, name, signal);
    if (pre.blocked) {
      const msg = `Blocked by PreToolUse hook: ${pre.feedback}`;
      ui.onToolEnd(name, msg, true);
      return msg;
    }
    if (signal.aborted) {
      ui.onToolEnd(name, "cancelled", true);
      return "Tool call cancelled: the user interrupted.";
    }

    const ctx: ToolContext = {
      cwd: this.cwd,
      signal,
      registry: this.registry,
      readFiles: this.readFiles,
      session: this.subagent ? undefined : this.session(ui, signal, opts),
    };
    const file = tool.kind === "edit" && typeof args.file_path === "string" ? resolvePath(this.cwd, args.file_path) : undefined;
    if (file) this.changes.beforeWrite(file, name);
    let out: string;
    let isError = false;
    try {
      out = await raceAbort(tool.run(args, ctx), signal);
    } catch (e) {
      out = signal.aborted ? "Tool call cancelled: the user interrupted." : `Error: ${(e as Error).message}`;
      isError = true;
    }
    const change = file ? this.changes.afterWrite(file) : undefined;
    const post = await this.hook(ui, "PostToolUse", { tool_name: name, tool_input: args, tool_response: out }, name, signal);
    if (post.blocked) out += `\n\n${reminder(`PostToolUse hook feedback:\n${post.feedback}`)}`;
    // A formatter hook rewrites the file right after our write: accept that as the model's latest view
    // (otherwise the next Edit fails with "changed since you last read it"), but tell it to re-read.
    if (file && !isError && this.readFiles.has(file)) {
      try {
        const mtime = statSync(file).mtimeMs;
        if (mtime !== this.readFiles.get(file)) {
          this.readFiles.delete(file);
          out += `\n\n${reminder("A hook modified this file after your change (e.g. a formatter). Read it again before the next edit.")}`;
        }
      } catch {}
    }
    ui.onToolEnd(name, out, isError, change && !isError ? { path: file!, ...change } : undefined);
    return out;
  }

  private subagentRestriction(name: string): string | undefined {
    const def = this.subagent;
    if (!def) return undefined;
    if (SUBAGENT_FORBIDDEN.has(name)) return `${name} is not available to subagents.`;
    if (def.tools === "*" || SUBAGENT_IMPLICIT.has(name) || def.tools.includes(name)) return undefined;
    return `${name} is not available to the ${def.name} subagent. Allowed tools: ${def.tools.join(", ")}.`;
  }

  /** true, or the message returned to the model when the call is refused */
  private async permit(tool: Tool, args: Record<string, unknown>, ui: AgentUI): Promise<true | string> {
    const readOnly = this.subagent?.readOnly;
    const root = this.parent ?? this;
    const decision = decide(readOnly ? "plan" : root.mode, tool, args, this.cwd);
    if (decision.action === "allow") return true;
    if (decision.action === "deny") {
      return readOnly ? `${tool.name} is not allowed: this subagent is read-only.` : decision.reason;
    }
    const risky = decision.reason !== undefined;
    if (!risky && this.sessionAllowed.has(tool.name)) return true;
    const answer = await ui.confirm(tool, args, decision.reason);
    if (answer === "always" && !risky) {
      // "always" for one edit means edits in general (Edit, Write, …): switch to accept-edits instead of
      // asking again for every other edit tool
      if (tool.kind === "edit" && root.mode === "ask") root.setMode("acceptEdits");
      else this.sessionAllowed.add(tool.name);
    }
    return answer === "no" ? "The user denied this tool call. Ask them how to proceed or try a different approach." : true;
  }

  private session(ui: AgentUI, signal: AbortSignal, opts: SubagentRunOptions = {}): Session {
    return {
      mode: () => this.mode,
      runSubagent: (type, prompt, description) => this.runSubagent(type, prompt, description, ui, signal, opts),
      approvePlan: (plan) => this.approvePlan(plan, ui),
    };
  }

  private writesFiles(call: ToolCall): boolean {
    let type: unknown;
    try {
      type = (parseJsonLenient(call.function.arguments) as Record<string, unknown> | undefined)?.subagent_type;
    } catch {}
    const def = typeof type === "string" ? this.registry.agents.get(type) : undefined;
    return !!def && !def.readOnly;
  }

  /** Which of these Agent calls get their own git worktree. */
  private isolationFor(batch: ToolCall[]): (call: ToolCall) => SubagentRunOptions {
    const mode = this.settings.subagents?.worktree ?? "auto";
    const writers = batch.filter((c) => this.writesFiles(c)).length;
    const wanted = mode === "always" ? writers > 0 : mode === "auto" && writers > 1;
    const isolate = wanted && !!gitRoot(this.cwd);
    return (call) => ({ isolate: isolate && this.writesFiles(call) });
  }

  /**
   * Runs Agent calls at the same time (up to subagents.parallel). Writing subagents get worktrees when
   * there is more than one of them; without git they take turns so they never edit the same tree at once.
   */
  private async runAgentBatch(
    batch: ToolCall[],
    run: (call: ToolCall, k: number, opts: SubagentRunOptions) => Promise<string>,
    results: string[],
    offset: number,
  ): Promise<void> {
    const opts = this.isolationFor(batch);
    const writers = batch.filter((c) => this.writesFiles(c));
    const takeTurns = writers.length > 1 && !opts(writers[0]).isolate;
    let writerChain: Promise<unknown> = Promise.resolve();
    const limit = Math.max(1, this.settings.subagents?.parallel ?? 3);
    let next = 0;
    const worker = async () => {
      while (next < batch.length) {
        const k = next++;
        const call = batch[k];
        const go = () => run(call, k, opts(call));
        if (takeTurns && this.writesFiles(call)) {
          const p = writerChain.then(go);
          writerChain = p.catch(() => {});
          results[offset + k] = await p;
        } else results[offset + k] = await go();
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, batch.length) }, worker));
  }

  private async runSubagent(type: string, prompt: string, description: string, ui: AgentUI, signal: AbortSignal, opts: SubagentRunOptions = {}): Promise<string> {
    const def = this.registry.agents.get(type);
    if (!def) throw new Error(`Unknown subagent type "${type}". Available: ${[...this.registry.agents.keys()].join(", ")}.`);
    const activity = this.board.add(this.activity, def.name, description, 30);
    const childUi = ui.child?.(`${def.name}${description ? `: ${description}` : ""}`, activity.id) ?? ui;

    let wt: Worktree | undefined;
    let cwd = this.cwd;
    if (opts.isolate && !def.readOnly) {
      const root = gitRoot(this.cwd);
      try {
        if (!root) throw new Error("not a git repository");
        wt = createWorktree(root, `${activity.id}-${Date.now().toString(36)}`, this.home);
        cwd = join(wt.path, relative(root, this.cwd));
        activity.update({ worktree: wt.path });
        childUi.onInfo(`working in its own git worktree: ${wt.path}`);
      } catch (e) {
        childUi.onInfo(`could not create a git worktree (${(e as Error).message}); working in the project folder`);
      }
    }

    const child = new Agent({
      cwd,
      settings: this.settings,
      registry: this.registry,
      home: this.home,
      subagent: def,
      mode: this.mode,
      changes: wt ? new ChangeTracker() : this.changes,
      board: this.board,
      activity,
    });
    child.sessionAllowed = this.sessionAllowed;
    child.parent = this.parent ?? this;
    let answer: string;
    let failed: string | undefined;
    try {
      answer = await child.send(prompt, childUi, signal);
      activity.finish("done");
    } catch (e) {
      activity.finish("failed");
      if (signal.aborted) {
        if (wt) childUi.onInfo(`interrupted; its worktree is kept: ${wt.path}`);
        throw e;
      }
      // The subagent died (server gone for longer than the retry window, a bug…): hand back what it had
      // done so far instead of losing it, so the parent can continue or re-delegate the rest.
      childUi.onInfo(`subagent failed: ${(e as Error).message}`);
      failed = (e as Error).message;
      answer = "";
    }

    let report = failed
      ? `The ${def.name} subagent failed before finishing: ${failed}\n\n${child.progressReport()}\n\nYou can call the Agent tool again with a narrower prompt to finish the rest, or continue yourself.`
      : answer.trim() || child.progressReport();
    if (report.length > REPORT_MAX) {
      const file = saveFullOutput(report, "md");
      report = truncateMiddle(report, REPORT_MAX) + (file ? `\n\n[the full report is in ${file}; Read it only if you need the missing part]` : "");
    }
    if (wt) report += `\n\n${this.mergeWorktree(wt, childUi)}`;
    return failed ? report : `${report}\n\n[subagent ${def.name} used ~${child.contextUsed()} tokens of its own context]`;
  }

  /** Merges a subagent's worktree back into the project and describes the outcome for the model. */
  private mergeWorktree(wt: Worktree, ui: AgentUI): string {
    let m: MergeResult;
    try {
      m = mergeBack(wt, this.changes);
    } catch (e) {
      ui.onInfo(`could not merge its worktree: ${(e as Error).message}; kept at ${wt.path}`);
      return `[The subagent worked in a git worktree, but merging it failed (${(e as Error).message}). Its files are still at ${wt.path}.]`;
    }
    // merged files changed behind the main agent's back: it must re-read them before editing
    for (const p of [...m.merged, ...m.conflicts]) this.readFiles.delete(join(wt.root, p));
    const parts = [`[The subagent worked in its own git worktree. Merged into the project: ${m.merged.join(", ") || "no changes"}.`];
    if (m.conflicts.length) parts.push(`CONFLICTS (both sides changed the same lines; conflict markers <<<<<<< project / >>>>>>> subagent were written, resolve them): ${m.conflicts.join(", ")}.`);
    if (m.skipped.length) parts.push(`Not merged (binary or deleted on one side; the project's version was kept): ${m.skipped.join(", ")}. The subagent's version is in ${wt.path}.`);
    if (m.conflicts.length || m.skipped.length) {
      ui.onInfo(`merged with problems: ${[...m.conflicts, ...m.skipped].join(", ")}; worktree kept at ${wt.path}`);
      parts.push(`The worktree is kept at ${wt.path}.]`);
    } else {
      removeWorktree(wt);
      if (m.merged.length) ui.onInfo(`merged ${m.merged.length} file${m.merged.length === 1 ? "" : "s"} from its worktree: ${m.merged.join(", ")}`);
      parts[parts.length - 1] += "]";
    }
    return parts.join(" ");
  }

  /** What this agent said and did so far (used when a subagent can't give a proper final report). */
  progressReport(): string {
    const said: string[] = [];
    const did: string[] = [];
    for (const m of this.messages) {
      if (m.role !== "assistant") continue;
      if (m.content?.trim()) said.push(m.content.trim());
      for (const c of m.tool_calls ?? []) did.push(`- ${c.function.name}(${oneLine(c.function.arguments, 120)})`);
    }
    const parts = ["(No final report. Partial progress follows.)"];
    if (said.length) parts.push(`Notes it wrote:\n${said.slice(-3).join("\n\n").slice(-3000)}`);
    if (did.length) parts.push(`Tool calls it made (${did.length}):\n${did.slice(-15).join("\n")}`);
    return parts.join("\n\n");
  }

  private async approvePlan(plan: string, ui: AgentUI): Promise<string> {
    if (!ui.approvePlan) {
      return "Non-interactive session: nobody can approve the plan. Stop now and give the plan as your final answer.";
    }
    const d = await ui.approvePlan(plan);
    if (!d.approved) {
      return `The user did not approve the plan. Stay in plan mode and revise it.${d.feedback ? `\nUser feedback: ${d.feedback}` : ""}`;
    }
    const mode = d.mode ?? "acceptEdits";
    this.setMode(mode, { silent: true });
    return `The user approved the plan. Mode is now "${MODES[mode].label}": implement the plan now. Track the steps with TodoWrite.`;
  }

  // ---------- compaction ----------

  private async shouldCompact(): Promise<boolean> {
    const share = this.settings.autoCompact;
    if (!share || this.messages.length < 4) return false;
    return this.contextUsed() > share * (await this.contextWindow());
  }

  /**
   * Replaces the history with a model-written summary. The summary request is the current conversation
   * plus one message, so the server reuses its cache and only the summary itself costs time.
   * If even that does not fit, falls back to a summary built without the model.
   */
  async compact(ui: AgentUI, signal: AbortSignal, opts: { focus?: string; midTurn?: boolean } = {}): Promise<boolean> {
    if (this.messages.length < 3) return false;
    const before = this.contextUsed();
    ui.onInfo(`Compacting conversation (~${before} tokens)…`);
    const ask = (msgs: Message[], extra = "") =>
      chat(this.settings, {
        messages: [...msgs, { role: "user", content: reminder(COMPACT_REQUEST(opts.focus) + extra) }],
        tools: this.modelTools,
        signal,
        maxTokens: 4096,
        onRetry: (m) => ui.onInfo(m),
      });
    let summary = "";
    ui.onWaiting?.(true);
    try {
      let res: ChatResult | undefined;
      try {
        res = await ask(this.messages);
      } catch (e) {
        if (!isContextOverflow(e)) throw e;
        try {
          res = await ask(shrinkToolResults(this.messages)); // the history itself no longer fits
        } catch (e2) {
          if (!isContextOverflow(e2)) throw e2;
          ui.onInfo("The conversation is too long even to summarize: keeping only the latest messages.");
        }
      }
      // A weak model sometimes answers the summary request with a tool call instead of text: ask once more.
      if (res && !stripThinking(res.content).trim() && res.toolCalls.length) {
        res = await ask(shrinkToolResults(this.messages), "\n\nDo NOT call any tools. Reply with the summary text only.").catch(() => res);
      }
      summary = res ? stripThinking(res.content).trim() : "";
      if (res?.finishReason === "length") summary += "\n[summary was cut off]";
    } finally {
      ui.onWaiting?.(false);
    }
    if (!summary) summary = fallbackSummary(this.messages);

    const parts = [`This session was compacted to save context. Summary of the conversation so far:\n\n${summary}`];
    const catalog = this.catalogForThisAgent();
    if (catalog) parts.push(reminder(catalog));
    const loaded = [...this.registry.loaded].filter((n) => this.registry.deferred.has(n));
    if (loaded.length) parts.push(reminder(`Deferred tools already loaded (call them with UseTool):\n${functionsBlock(this.registry, loaded)}`));
    if (this.mode === "plan" && !this.subagent) parts.push(reminder(PLAN_MODE_ON));
    if (opts.midTurn) parts.push("Continue the current task from where you left off. Re-read files before editing them.");

    const next: Message[] = [{ role: "system", content: this.systemPrompt }, { role: "user", content: parts.join("\n\n") }];
    if (!opts.midTurn) next.push({ role: "assistant", content: "Understood. I have the summary and will continue from there." });
    this.replaceHistory(next);
    this.lastCatalog = catalog;
    this.readFiles.clear();
    this.lastUsage = undefined;
    this.usageAtMessages = 0;
    ui.onInfo(`Compacted: ~${before} → ~${this.contextUsed()} tokens.`);
    return true;
  }

  private async hook(
    ui: AgentUI,
    event: Parameters<typeof runHooks>[1],
    payload: Record<string, unknown>,
    toolName?: string,
    signal?: AbortSignal,
  ): Promise<HookResult> {
    const r = await runHooks(this.settings.hooks, event, payload, this.cwd, toolName, signal);
    for (const w of r.warnings) ui.onInfo(w);
    return r;
  }
}

/** Resolves with the promise, or rejects as soon as the signal aborts (for tools that ignore the signal). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function canonicalArgs(raw: string): string {
  try {
    const sort = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
    return JSON.stringify(sort(parseJsonLenient(raw)));
  } catch {
    return raw.trim();
  }
}

function functionsBlock(registry: Registry, names: string[]): string {
  const lines = names
    .map((n) => registry.deferred.get(n))
    .filter((t): t is Tool => !!t)
    .map((t) => `<function>${JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })}</function>`);
  return `<functions>\n${lines.join("\n")}\n</functions>`;
}

function shrinkToolResults(messages: Message[]): Message[] {
  const keepFrom = Math.max(0, messages.length - 6);
  return messages.map((m, i) =>
    m.role === "tool" && m.content.length > 400 && i < keepFrom ? { ...m, content: m.content.slice(0, 400) + "\n[…truncated for compaction]" } : m,
  );
}

function fallbackSummary(messages: Message[]): string {
  const asks = messages.filter((m) => m.role === "user").map((m) => `- ${String(m.content).split("<system-reminder>")[0].trim().slice(0, 300)}`).filter((l) => l.length > 2);
  const lastSaid = [...messages].reverse().find((m) => m.role === "assistant" && m.content?.trim());
  const did = messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []) : [])).slice(-20).map((c) => `- ${c.function.name}(${oneLine(c.function.arguments, 100)})`);
  return [
    `(Summary built without the model.) User requests so far:\n${asks.slice(-10).join("\n")}`,
    did.length ? `Most recent tool calls:\n${did.join("\n")}` : "",
    lastSaid ? `Last thing you said:\n${String(lastSaid.content).slice(-1500)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
