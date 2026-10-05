import { statSync } from "node:fs";
import { runHooks, type HookResult } from "../hooks/hooks.ts";
import { ChatError, chat, fetchContextWindow, isContextOverflow, type ChatResult, type Timings, type Usage } from "../providers/openai.ts";
import { extractTextToolCalls, looksTruncated, parseJsonLenient, stripThinking } from "../providers/toolcall-parse.ts";
import type { AgentDef, Registry } from "../registry/registry.ts";
import { EXIT_PLAN_MODE } from "../tools/session-tools.ts";
import { USE_TOOL } from "../tools/UseTool.ts";
import type { Message, Session, Tool, ToolCall, ToolContext } from "../types.ts";
import { oneLine, resolvePath } from "../util.ts";
import { ChangeTracker } from "./changes.ts";
import { COMPACT_REQUEST, PLAN_MODE_OFF, PLAN_MODE_ON, buildSystemPrompt, reminder } from "./context.ts";
import { MODES, decide, type Mode } from "./modes.ts";
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
  /** UI for a subagent's activity (e.g. indented); defaults to this UI */
  child?(label: string): AgentUI;
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
}

const MAX_STOP_HOOK_RETRIES = 3;
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
    if (!this.subagent) this.changes.beginTurn(userText);
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
    return this.runLoop(ui, signal);
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
      try {
        return await chat(this.settings, {
          messages: this.messages,
          tools: this.modelTools,
          signal,
          onText: (t) => {
            ui.onWaiting?.(false);
            ui.onText(t);
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

      const res = await this.request(ui, signal);
      if (res.usage) {
        this.lastUsage = res.usage;
        this.usageAtMessages = this.messages.length;
      }
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
        const stop = await this.hook(ui, "Stop", { last_message: text }, undefined, signal);
        if (stop.blocked && stopRetries++ < MAX_STOP_HOOK_RETRIES) {
          this.push({ role: "user", content: reminder(`Stop hook feedback:\n${stop.feedback}`) });
          continue;
        }
        return answer;
      }
      answer = "";

      let stopReason: string | undefined;
      for (const [i, call] of calls.entries()) {
        let result: string;
        if (signal.aborted) result = "Tool call cancelled: the user interrupted.";
        else if (stopReason) result = "Not executed: the turn was stopped.";
        else if (cutOff && (i === calls.length - 1 || looksTruncated(call.function.arguments))) {
          // finish_reason "length": the last call was being written when the limit hit; lenient JSON repair
          // would otherwise run it with half its content (e.g. a Write of a truncated file).
          result = TRUNCATED_CALL;
          ui.onToolStart(call.function.name, {});
          ui.onToolEnd(call.function.name, result, true);
        } else {
          result = await this.execCall(call, ui, signal);
          const key = `${call.function.name}\0${canonicalArgs(call.function.arguments)}`;
          const n = (repeats.get(key) ?? 0) + 1;
          repeats.set(key, n);
          if (n >= REPEAT_STOP) {
            stopReason = `The model repeated the same ${call.function.name} call ${n} times; stopping this turn.`;
          } else if (n >= REPEAT_WARN) {
            result += `\n\n${reminder(`You have made this exact ${call.function.name} call ${n} times in this task. Repeating it will not give a different result: change your approach, or stop and tell the user what is blocking you.`)}`;
          }
        }
        // Mode changes made while the model works are reported with the next tool result (append-only).
        if (this.pendingReminders.length) result += "\n\n" + this.pendingReminders.splice(0).map(reminder).join("\n");
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

  private async execCall(call: ToolCall, ui: AgentUI, signal: AbortSignal): Promise<string> {
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
    const permission = await this.permit(tool, args, ui);
    if (permission !== true) {
      ui.onToolEnd(name, permission, true);
      return permission;
    }
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
      session: this.subagent ? undefined : this.session(ui, signal),
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

  private session(ui: AgentUI, signal: AbortSignal): Session {
    return {
      mode: () => this.mode,
      runSubagent: (type, prompt, description) => this.runSubagent(type, prompt, description, ui, signal),
      approvePlan: (plan) => this.approvePlan(plan, ui),
    };
  }

  private async runSubagent(type: string, prompt: string, description: string, ui: AgentUI, signal: AbortSignal): Promise<string> {
    const def = this.registry.agents.get(type);
    if (!def) throw new Error(`Unknown subagent type "${type}". Available: ${[...this.registry.agents.keys()].join(", ")}.`);
    const child = new Agent({
      cwd: this.cwd,
      settings: this.settings,
      registry: this.registry,
      home: this.home,
      subagent: def,
      mode: this.mode,
      changes: this.changes,
    });
    child.sessionAllowed = this.sessionAllowed;
    child.parent = this.parent ?? this;
    const childUi = ui.child?.(`${def.name}${description ? `: ${description}` : ""}`) ?? ui;
    let answer: string;
    try {
      answer = await child.send(prompt, childUi, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      // The subagent died (server gone for longer than the retry window, a bug…): hand back what it had
      // done so far instead of losing it, so the parent can continue or re-delegate the rest.
      childUi.onInfo(`subagent failed: ${(e as Error).message}`);
      return `The ${def.name} subagent failed before finishing: ${(e as Error).message}\n\n${child.progressReport()}\n\nYou can call the Agent tool again with a narrower prompt to finish the rest, or continue yourself.`;
    }
    const used = child.contextUsed();
    return `${answer.trim() || child.progressReport()}\n\n[subagent ${def.name} used ~${used} tokens of its own context]`;
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
