import { runHooks, type HookResult } from "../hooks/hooks.ts";
import { chat, fetchContextWindow, isContextOverflow, type ChatResult, type Timings, type Usage } from "../providers/openai.ts";
import { extractTextToolCalls, parseJsonLenient, stripThinking } from "../providers/toolcall-parse.ts";
import type { AgentDef, Registry } from "../registry/registry.ts";
import { EXIT_PLAN_MODE } from "../tools/session-tools.ts";
import { USE_TOOL } from "../tools/UseTool.ts";
import type { Message, Session, Tool, ToolCall, ToolContext } from "../types.ts";
import { COMPACT_REQUEST, PLAN_MODE_OFF, PLAN_MODE_ON, buildSystemPrompt, reminder } from "./context.ts";
import { MODES, decide, type Mode } from "./modes.ts";
import type { Settings } from "./settings.ts";
import { coerceArgs, validateArgs } from "./validate.ts";

export type Approval = "yes" | "always" | "no";

export interface PlanDecision {
  approved: boolean;
  /** mode to continue in after approval */
  mode?: Mode;
  feedback?: string;
}

export interface AgentUI {
  onText(text: string): void;
  onReasoning?(text: string): void;
  /** true while waiting for the model (before its first output) */
  onWaiting?(waiting: boolean): void;
  onToolStart(name: string, args: Record<string, unknown>): void;
  onToolEnd(name: string, result: string, isError: boolean): void;
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
}

const MAX_STOP_HOOK_RETRIES = 3;
const DEFAULT_CONTEXT = 32_768;
/** tools every subagent may use regardless of its tools list */
const SUBAGENT_IMPLICIT = new Set(["ToolSearch", "UseTool", "Skill", "TodoWrite"]);
/** tools no subagent may use */
const SUBAGENT_FORBIDDEN = new Set(["Agent", EXIT_PLAN_MODE]);

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
  /** called whenever the mode changes (UI redraws its prompt) */
  onModeChange?: (mode: Mode) => void;
  sessionAllowed = new Set<string>();
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
    const hook = await this.hook(ui, "UserPromptSubmit", { prompt: userText });
    if (hook.blocked) {
      ui.onInfo(`Prompt blocked by hook: ${hook.feedback}`);
      return "";
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
    this.messages.push({ role: "user", content: [userText, ...extras.map(reminder)].join("\n\n") });
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

  private async runLoop(ui: AgentUI, signal: AbortSignal): Promise<string> {
    let stopRetries = 0;
    let overflowRetried = false;
    for (let step = 0; step < this.maxSteps; step++) {
      if (await this.shouldCompact()) await this.compact(ui, signal, { midTurn: true });

      let res: ChatResult;
      ui.onWaiting?.(true);
      try {
        res = await chat(this.settings, {
          messages: this.messages,
          tools: this.modelTools,
          signal,
          onText: (t) => {
            ui.onWaiting?.(false);
            ui.onText(t);
          },
          onReasoning: ui.onReasoning ? (t) => ui.onReasoning!(t) : undefined,
        });
      } catch (e) {
        ui.onWaiting?.(false);
        if (!signal.aborted && isContextOverflow(e) && !overflowRetried) {
          overflowRetried = true;
          ui.onInfo("Context is full: compacting the conversation and retrying…");
          await this.compact(ui, signal, { midTurn: true });
          step--;
          continue;
        }
        throw e;
      }
      ui.onWaiting?.(false);
      if (res.usage) {
        this.lastUsage = res.usage;
        this.usageAtMessages = this.messages.length;
      }
      this.lastTimings = res.timings ?? this.lastTimings;

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
      this.messages.push({ role: "assistant", content: text || (calls.length ? null : ""), ...(calls.length && { tool_calls: calls }) });

      if (!calls.length) {
        const stop = await this.hook(ui, "Stop", { last_message: text });
        if (stop.blocked && stopRetries++ < MAX_STOP_HOOK_RETRIES) {
          this.messages.push({ role: "user", content: reminder(`Stop hook feedback:\n${stop.feedback}`) });
          continue;
        }
        return text;
      }

      for (const call of calls) {
        let result = signal.aborted ? "Tool call cancelled: the user interrupted." : await this.execCall(call, ui, signal);
        // Mode changes made while the model works are reported with the next tool result (append-only).
        if (this.pendingReminders.length) result += "\n\n" + this.pendingReminders.splice(0).map(reminder).join("\n");
        this.messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      if (signal.aborted) return "";
    }
    ui.onInfo(`Stopped after ${this.maxSteps} steps.`);
    return "";
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
    const pre = await this.hook(ui, "PreToolUse", { tool_name: name, tool_input: args }, name);
    if (pre.blocked) {
      const msg = `Blocked by PreToolUse hook: ${pre.feedback}`;
      ui.onToolEnd(name, msg, true);
      return msg;
    }

    const ctx: ToolContext = {
      cwd: this.cwd,
      signal,
      registry: this.registry,
      readFiles: this.readFiles,
      session: this.subagent ? undefined : this.session(ui, signal),
    };
    let out: string;
    let isError = false;
    try {
      out = await tool.run(args, ctx);
    } catch (e) {
      out = `Error: ${(e as Error).message}`;
      isError = true;
    }
    const post = await this.hook(ui, "PostToolUse", { tool_name: name, tool_input: args, tool_response: out }, name);
    if (post.blocked) out += `\n\n${reminder(`PostToolUse hook feedback:\n${post.feedback}`)}`;
    ui.onToolEnd(name, out, isError);
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
    const decision = decide(readOnly ? "plan" : this.mode, tool, args, this.cwd);
    if (decision.action === "allow") return true;
    if (decision.action === "deny") {
      return readOnly ? `${tool.name} is not allowed: this subagent is read-only.` : decision.reason;
    }
    const risky = decision.reason !== undefined;
    if (!risky && this.sessionAllowed.has(tool.name)) return true;
    const answer = await ui.confirm(tool, args, decision.reason);
    if (answer === "always" && !risky) this.sessionAllowed.add(tool.name);
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
    });
    child.sessionAllowed = this.sessionAllowed;
    const childUi = ui.child?.(`${def.name}${description ? `: ${description}` : ""}`) ?? ui;
    const answer = await child.send(prompt, childUi, signal);
    const used = child.contextUsed();
    return `${answer.trim() || "(the subagent finished without a final report)"}\n\n[subagent ${def.name} used ~${used} tokens of its own context]`;
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
   */
  async compact(ui: AgentUI, signal: AbortSignal, opts: { focus?: string; midTurn?: boolean } = {}): Promise<boolean> {
    if (this.messages.length < 3) return false;
    const before = this.contextUsed();
    ui.onInfo(`Compacting conversation (~${before} tokens)…`);
    const ask = (msgs: Message[]) =>
      chat(this.settings, { messages: [...msgs, { role: "user", content: reminder(COMPACT_REQUEST(opts.focus)) }], tools: this.modelTools, signal, maxTokens: 4096 });
    let res: ChatResult;
    ui.onWaiting?.(true);
    try {
      try {
        res = await ask(this.messages);
      } catch (e) {
        if (!isContextOverflow(e)) throw e;
        res = await ask(shrinkToolResults(this.messages)); // the history itself no longer fits
      }
    } finally {
      ui.onWaiting?.(false);
    }
    const summary = stripThinking(res.content).trim() || fallbackSummary(this.messages);

    const parts = [`This session was compacted to save context. Summary of the conversation so far:\n\n${summary}`];
    const catalog = this.catalogForThisAgent();
    if (catalog) parts.push(reminder(catalog));
    const loaded = [...this.registry.loaded].filter((n) => this.registry.deferred.has(n));
    if (loaded.length) parts.push(reminder(`Deferred tools already loaded (call them with UseTool):\n${functionsBlock(this.registry, loaded)}`));
    if (this.mode === "plan" && !this.subagent) parts.push(reminder(PLAN_MODE_ON));
    if (opts.midTurn) parts.push("Continue the current task from where you left off. Re-read files before editing them.");

    this.messages = [{ role: "system", content: this.systemPrompt }, { role: "user", content: parts.join("\n\n") }];
    if (!opts.midTurn) this.messages.push({ role: "assistant", content: "Understood. I have the summary and will continue from there." });
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
  ): Promise<HookResult> {
    const r = await runHooks(this.settings.hooks, event, payload, this.cwd, toolName);
    for (const w of r.warnings) ui.onInfo(w);
    return r;
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
  return messages.map((m) =>
    m.role === "tool" && m.content.length > 400 ? { ...m, content: m.content.slice(0, 400) + "\n[…truncated for compaction]" } : m,
  );
}

function fallbackSummary(messages: Message[]): string {
  const asks = messages.filter((m) => m.role === "user").map((m) => `- ${String(m.content).split("<system-reminder>")[0].trim().slice(0, 300)}`);
  return `(The model did not produce a summary.) User requests so far:\n${asks.join("\n")}`;
}
