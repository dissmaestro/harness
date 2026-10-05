import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { readText, type ChangeTracker } from "../core/changes.ts";
import type { Agent, AgentUI, Approval, PlanDecision } from "../core/loop.ts";
import { MODES, MODE_CYCLE, nextMode, parseMode, type Mode } from "../core/modes.ts";
import { expandCommand } from "../registry/loaders/skills.ts";
import { skillPrompt } from "../tools/Skill.ts";
import type { Tool } from "../types.ts";
import { oneLine } from "../util.ts";
import { diffStat, renderDiff } from "./diff.ts";
import { langFromPath, lineHighlighter } from "./highlight.ts";
import { type CommandInfo, SHORTCUTS, complete, expandMentions, projectFiles } from "./complete.ts";
import { MarkdownStream } from "./markdown.ts";
import { InputMenu } from "./menu.ts";
import { Footer, MutableOutput, columnAfter } from "./footer.ts";
import { activitySummary, renderStatus } from "./status.ts";
import { formatDuration } from "../core/activity.ts";
import { page } from "./pager.ts";
import { MODE_STYLE, argSummary, box, c, contextLabel, diffLines, formatTokens, resultSummary, shortPath, stripAnsi } from "./render.ts";

/** Built-in commands: the /help text and the / menu. */
export const BUILTIN_COMMANDS: (CommandInfo & { group: "Commands" | "Changes" })[] = [
  { group: "Commands", name: "help", description: "commands and keyboard shortcuts" },
  { group: "Commands", name: "keys", description: "keyboard shortcuts (or type ?)" },
  { group: "Commands", name: "mode", args: "[name]", description: "show or switch mode" },
  { group: "Commands", name: "plan", args: "[task]", description: "plan mode: research read-only, then a plan" },
  { group: "Commands", name: "auto", args: "[task]", description: "auto mode: everything except dangerous actions" },
  { group: "Commands", name: "compact", args: "[focus]", description: "summarize the conversation to free context" },
  { group: "Commands", name: "status", description: "what every agent is doing: step, tool, checklist (works while agents run)" },
  { group: "Commands", name: "context", description: "context usage" },
  { group: "Commands", name: "clear", description: "start a new conversation" },
  { group: "Commands", name: "skills", description: "available skills" },
  { group: "Commands", name: "agents", description: "available subagents" },
  { group: "Commands", name: "tools", description: "core and deferred tools" },
  { group: "Commands", name: "commands", description: "custom slash commands" },
  { group: "Commands", name: "thinking", description: "show or hide the model's reasoning" },
  { group: "Commands", name: "exit", description: "quit (or ctrl+d)" },
  { group: "Changes", name: "files", description: "files changed this session" },
  { group: "Changes", name: "diff", args: "[path]", description: "diff against the session start" },
  { group: "Changes", name: "view", args: "<path>[:a-b]", description: "show a file (or lines a-b) with line numbers" },
  { group: "Changes", name: "undo", description: "restore the files the last turn changed" },
  { group: "Changes", name: "revert", args: "[path]", description: "restore files to how they were at session start" },
  { group: "Changes", name: "last", description: "full output of the last tool" },
];

const key = (k: string) => k.split(" ").map((x) => c.cyan(x)).join(c.dim(" "));

export function shortcutsText(): string {
  const w = Math.max(...SHORTCUTS.map(([k]) => k.length));
  return SHORTCUTS.map(([k, what]) => `  ${key(k)}${" ".repeat(w - k.length)}   ${what}`).join("\n");
}

function helpText(): string {
  const section = (title: string, note = "") => c.bold(title) + (note ? " " + c.dim(note) : "");
  const cmdRows = (group: string) => {
    const list = BUILTIN_COMMANDS.filter((x) => x.group === group);
    const w = Math.max(...list.map((x) => x.name.length + (x.args ? x.args.length + 1 : 0))) + 1;
    return list.map((x) => `  ${c.cyan("/" + x.name)}${x.args ? " " + c.dim(x.args) : ""}${" ".repeat(w - x.name.length - (x.args ? x.args.length + 1 : 0))}  ${x.description}`).join("\n");
  };
  const modes = MODE_CYCLE.concat("yolo")
    .map((m) => `  ${MODE_STYLE[m](MODES[m].label.padEnd(13))} ${MODES[m].description}${m === "yolo" ? c.dim(" (only /mode yolo or --yolo)") : ""}`)
    .join("\n");
  return [
    section("Modes", "(shift+tab cycles ask → accept edits → plan → auto)"),
    modes,
    "",
    section("Commands", "(type / for a menu)"),
    cmdRows("Commands"),
    `  ${c.cyan("/<skill>")} ${c.dim("[args]")}       run a skill · ${c.cyan("/<command>")} ${c.dim("[args]")} run a custom command`,
    "",
    section("Changes"),
    cmdRows("Changes"),
    "",
    section("Keys"),
    shortcutsText(),
  ].join("\n");
}

/** Tools whose results are shown as a diff of the file they wrote. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length <= width || /^\s*(```|\|)/.test(raw)) {
      out.push(raw);
      continue;
    }
    const indent = raw.match(/^\s*([-*+]\s+|\d+\.\s+)?/)![0].replace(/\S/g, " ");
    let line = "";
    for (const word of raw.split(/(\s+)/)) {
      if ((line + word).length > width && line.trim()) {
        out.push(line.trimEnd());
        line = indent + word.trimStart();
      } else line += word;
    }
    if (line.trim()) out.push(line.trimEnd());
  }
  return out;
}

/** "/home/x/a.py fails" is a prompt that starts with a path, not a command. */
export function isPathLike(input: string): boolean {
  return /^\/[^\s/]*\//.test(input);
}

/** Confirm answer: empty means yes, unless the action is risky (then empty means no). */
export function confirmAnswer(answer: string | null, risky: boolean): Approval {
  const a = (answer ?? "n").trim().toLowerCase();
  if (a.startsWith("a")) return "always";
  if (a === "") return risky ? "no" : "yes";
  return a.startsWith("y") || a.startsWith("д") ? "yes" : "no";
}

/** "src/a.ts:10-20" → path and an optional 1-based inclusive line range ("a.ts:10-" = to the end). */
export function parseViewSpec(spec: string): { path: string; start?: number; end?: number } {
  const m = spec.trim().match(/^(.*?)(?::(\d+)(?:(-)(\d*))?)?$/)!;
  const start = m[2] ? Number(m[2]) : undefined;
  const end = m[4] ? Number(m[4]) : m[3] ? undefined : start;
  return { path: m[1], start, end };
}

function loadHistory(file: string): string[] {
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > 1000) writeFileSync(file, lines.slice(-1000).join("\n") + "\n");
    return lines.slice(-1000);
  } catch {
    return [];
  }
}

type WriteChange = { path: string; before: string | null; after: string | null };

/** initialPrompt (e.g. `agent "fix the tests"`) is handled as if typed at the first prompt. */
export async function runRepl(agent: Agent, warnings: string[], initialPrompt?: string) {
  const out = process.stdout;
  const tty = !!out.isTTY && !!process.stdin.isTTY;
  const width = () => Math.max(40, Math.min(out.columns || 100, 120));
  const historyFile = join(agent.home ?? homedir(), ".agent", "history");
  const history = loadHistory(historyFile);
  // In a terminal, keys go through the completion menu first and then on to readline via `input`.
  const input = tty ? Object.assign(new PassThrough(), { isTTY: true, setRawMode: (on: boolean) => process.stdin.setRawMode(on) }) : process.stdin;
  // While agents work, readline's own echo is muted and the footer draws the typed line instead.
  let muted = () => false;
  const rl = createInterface({
    input,
    output: tty ? (new MutableOutput(out, () => muted()) as unknown as NodeJS.WritableStream) : out,
    historySize: 1000,
    history: [...history].reverse(),
    terminal: !!out.isTTY,
  });
  const rlHistory = () => (rl as unknown as { history?: string[] }).history ?? [];
  let ctxWindow: number | undefined;
  let menu: InputMenu | undefined;
  let atLineStart = true;
  let running: AbortController | undefined;
  let runStarted = 0;
  let showThinking = false;
  let thinkingShown = false;
  /** column of the cursor in the output, so the footer can be drawn under a half-written line */
  let outCol = 0;

  /** "› typed text" with a block cursor, scrolled so the cursor stays visible */
  const inputRow = () => {
    const r = rl as unknown as { line: string; cursor: number };
    if (!r.line) return c.green("› ") + c.inverse(" ") + c.dim(" ask what's going on · >note to the agent · >#2 note to subagent #2 · /status");
    const room = Math.max(10, (out.columns || 80) - 4);
    const start = Math.max(0, r.cursor - room + 1);
    const text = r.line.slice(start, start + room);
    const cur = r.cursor - start;
    return c.green("› ") + text.slice(0, cur) + c.inverse(text[cur] ?? " ") + text.slice(cur + 1);
  };
  const footer = new Footer(
    out,
    (frame) => {
      if (!running || waiter) return [];
      const ctx = ctxWindow ? ` · ${contextLabel(agent.contextUsed(), ctxWindow)}` : "";
      const what = activitySummary(agent.board) || "thinking";
      return [`${c.magenta(frame)} ${c.dim(`${what} · ${formatDuration(Date.now() - runStarted)}${ctx} · ctrl+c to interrupt`)}`, inputRow()];
    },
    () => outCol,
  );

  muted = () => !!running && !waiter;
  /** side questions being answered while the agent works */
  const asides = new Set<AbortController>();

  const raw = (s: string) => {
    if (!s) return;
    menu?.clear();
    footer.clear();
    out.write(s);
    outCol = columnAfter(s, outCol);
    atLineStart = s.endsWith("\n");
    footer.draw();
  };
  const md = new MarkdownStream(raw);
  const endText = () => {
    md.flush();
    if (!atLineStart) raw("\n");
  };
  const line = (s = "") => {
    endText();
    raw(s + "\n");
  };

  // ----- input -----
  // Lines typed while the agent works are queued as the next prompts. A bracketed paste (or, without
  // terminal support, lines arriving within 10ms of each other) becomes one input.
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | undefined;
  let waiterFresh = false;
  let closed = false;
  let pasting = false;
  let pasteBuf: string[] = [];
  let burst: string[] = [];
  let burstTimer: ReturnType<typeof setTimeout> | undefined;
  const deliver = (l: string) => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(l);
    } else if (running && tty) whileRunning(l);
    else queue.push(l);
  };
  const flushBurst = () => {
    clearTimeout(burstTimer);
    burstTimer = undefined;
    if (burst.length) deliver(burst.splice(0).join("\n"));
  };
  rl.on("line", (l) => {
    if (pasting) {
      pasteBuf.push(l);
      return;
    }
    if (pasteBuf.length) {
      // the Enter after a paste submits it together with whatever was typed after it
      deliver([...pasteBuf.splice(0), l].join("\n").replace(/\n+$/, ""));
      return;
    }
    if (!process.stdin.isTTY) {
      deliver(l);
      return;
    }
    burst.push(l);
    clearTimeout(burstTimer);
    burstTimer = setTimeout(flushBurst, 10);
  });
  rl.on("close", () => {
    flushBurst();
    if (pasteBuf.length) deliver(pasteBuf.splice(0).join("\n"));
    closed = true;
    if (tty) out.write("\x1b[?2004l");
    waiter?.(null);
  });
  /** fresh: ignore type-ahead (for answers to questions, which must not be taken from earlier lines) */
  const nextLine = (prompt: string, fresh = false): Promise<string | null> => {
    footer.clear();
    rl.setPrompt(prompt);
    atLineStart = true;
    waiterFresh = fresh;
    if (!fresh && queue.length) {
      // type-ahead: show it after the prompt as if typed now
      const l = queue.shift()!;
      out.write(prompt + l.replace(/\n/g, "\n  ") + "\n");
      return Promise.resolve(l);
    }
    rl.prompt();
    if (closed) return Promise.resolve(null);
    const p = new Promise<string | null>((r) => (waiter = r));
    menu?.update(true);
    return p;
  };
  /** an answer to a question: fresh input only, and kept out of the up-arrow history */
  const answer = async (prompt: string): Promise<string | null> => {
    // a half-typed message from while the agent worked is put aside, not taken as the answer
    const r = rl as unknown as { line: string; cursor: number };
    const draft = r.line;
    r.line = "";
    r.cursor = 0;
    const a = await nextLine(prompt, true);
    const h = rlHistory();
    if (a !== null && h[0] === a) h.shift();
    if (draft) {
      r.line = draft;
      r.cursor = draft.length;
    }
    return a;
  };
  const remember = (input: string) => {
    if (input.includes("\n") || input === history.at(-1)) return;
    history.push(input);
    try {
      mkdirSync(dirname(historyFile), { recursive: true });
      appendFileSync(historyFile, input + "\n");
    } catch {
      // history is a convenience
    }
  };

  const promptFor = (m: Mode) => (m === "ask" ? "" : MODE_STYLE[m](`⏵⏵ ${MODES[m].label} `)) + c.green("› ");

  // ----- shift+tab cycles modes -----
  agent.onModeChange = (m) => {
    if (running) {
      line(MODE_STYLE[m](`  ⏵⏵ mode: ${MODES[m].label}`) + c.dim(` — ${MODES[m].description}`));
      return;
    }
    if (!waiter || waiterFresh) return; // not at the main prompt: nothing to redraw
    setImmediate(() => {
      const r = rl as unknown as { line: string; cursor: number };
      if (r.line.includes("\t")) {
        r.line = r.line.replace(/\t/g, "");
        r.cursor = r.line.length;
      }
      rl.setPrompt(promptFor(m));
      rl.prompt(true);
      menu?.update();
    });
  };
  // ----- completion menu: / commands, @ paths, ? shortcuts -----
  const files = projectFiles(agent.cwd);
  const menuCommands = (): CommandInfo[] => [
    ...BUILTIN_COMMANDS,
    ...[...reg.skills.values()].map((x) => ({ name: x.name, args: "[args]", description: "skill · " + oneLine(x.description, 70) })),
    ...[...reg.commands.values()].filter((x) => !reg.skills.has(x.name)).map((x) => ({ name: x.name, args: "[args]", description: oneLine(x.description, 70) })),
  ];
  const keyRows = () => {
    const w = Math.max(...SHORTCUTS.map(([k]) => k.length));
    return SHORTCUTS.map(([k, what]) => `   ${key(k)}${" ".repeat(w - k.length)}   ${c.dim(what)}`);
  };
  menu = new InputMenu({
    rl,
    out,
    active: () => !!waiter && !waiterFresh && !running && !pasting,
    complete: (l, cur) => complete(l, cur, menuCommands(), agent.cwd, files),
    panel: (l) => (l === "?" ? keyRows() : l === "" ? [c.dim("   / commands · @ files · ? shortcuts · shift+tab mode")] : undefined),
  });
  if (tty) {
    // a short escape timeout so a lone esc closes the menu right away
    emitKeypressEvents(process.stdin, { escapeCodeTimeout: 50 } as never);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", (s, k) => {
      if (k?.name === "paste-start") pasting = true;
      else if (k?.name === "paste-end") pasting = false;
      else if (k?.name === "tab" && k.shift && !pasting) agent.setMode(nextMode(agent.mode));
      const forward = (seq: string) => input.write(seq);
      if (!pasting && menu!.key(k, forward)) return;
      forward(k?.sequence ?? s);
      setImmediate(() => {
        menu!.update();
        footer.draw();
      });
    });
    rl.on("close", () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    });
  } else if (process.stdin.isTTY) {
    process.stdin.on("keypress", (_s, k) => {
      if (k?.name === "paste-start") pasting = true;
      else if (k?.name === "paste-end") pasting = false;
      else if (k?.name === "tab" && k.shift && !pasting) agent.setMode(nextMode(agent.mode));
    });
  }
  if (tty) {
    out.write("\x1b[?2004h"); // bracketed paste
    process.on("exit", () => out.write("\x1b[?2004l"));
  }

  let lastSigint = 0;
  rl.on("SIGINT", () => {
    if (running) {
      running.abort();
      for (const a of asides) a.abort();
      line(c.yellow("  ⏹ interrupted"));
      if (waiter) deliver(""); // a pending question is answered "no" below (empty + aborted)
      return;
    }
    const r = rl as unknown as { line: string };
    if (r.line) {
      rl.write(null, { ctrl: true, name: "e" });
      rl.write(null, { ctrl: true, name: "u" });
      return;
    }
    if (waiter && waiterFresh) {
      out.write("\n");
      deliver("n");
      return;
    }
    pasteBuf = [];
    if (Date.now() - lastSigint < 2000) {
      out.write("\n");
      rl.close();
      return;
    }
    lastSigint = Date.now();
    out.write("\n" + c.dim("  (press ctrl+c again to exit)") + "\n");
    rl.prompt();
  });

  // ----- rendering of tool activity -----
  let lastResult: { name: string; result: string } | undefined;

  const renderToolEnd = (pad: string, name: string, result: string, isError: boolean, args: Record<string, unknown>, change?: WriteChange) => {
    lastResult = { name, result };
    const lead = pad + c.gray("  ⎿ ");
    const more = pad + "    ";
    if (isError) {
      line(lead + c.red(resultSummary(result, 3).replace(/\n/g, "\n" + more)));
      return;
    }
    if (change && EDIT_TOOLS.has(name)) {
      const p = shortPath(change.path, agent.cwd);
      const verb = change.before === null ? "Created" : change.after === null ? "Deleted" : name === "Write" ? "Wrote" : "Edited";
      const { added, removed } = diffStat(change.before ?? "", change.after ?? "");
      line(lead + c.dim(`${verb} ${p} `) + c.green(`+${added}`) + " " + c.red(`-${removed}`));
      const w = width() - stripAnsi(more).length;
      for (const l of renderDiff(change.path, change.before, change.after, { maxLines: pad ? 12 : 40, width: w })) line(more + l);
      return;
    }
    switch (name) {
      case "Edit":
        line(lead + c.dim(`Edited ${shortPath(String(args.file_path), agent.cwd)}`));
        for (const l of diffLines(String(args.old_string ?? ""), String(args.new_string ?? ""), 10)) line(more + l);
        return;
      case "Read": {
        const n = result.split("\n").filter((l) => /^\s*\d+\t/.test(l)).length;
        line(lead + c.dim(`${n} lines`));
        return;
      }
      case "TodoWrite":
        for (const l of result.split("\n")) {
          const styled = l.startsWith("☒") ? c.dim(c.green(l)) : l.startsWith("▶") ? c.bold(c.yellow(l)) : l;
          line(more + styled);
        }
        return;
      case "Bash":
        line(lead + c.dim(resultSummary(result, 3).replace(/\n/g, "\n" + more)));
        return;
      case "ExitPlanMode":
        line(lead + c.dim(oneLine(result, 100)));
        return;
      default:
        line(lead + c.dim(resultSummary(result, 1)));
    }
  };

  const confirm = async (pad: string, tool: Tool, args: Record<string, unknown>, reason?: string): Promise<Approval> => {
    endText();
    const w = width() - 8;
    const body: string[] = [];
    if (tool.name === "Bash") body.push(...String(args.command).split("\n").slice(0, 8).map((l) => c.bold(l.slice(0, w))));
    else if (tool.name === "Edit") {
      body.push(c.bold(shortPath(String(args.file_path), agent.cwd)));
      body.push(...diffLines(String(args.old_string), String(args.new_string), 8));
    } else if (tool.name === "Write") {
      body.push(c.bold(shortPath(String(args.file_path), agent.cwd)) + c.dim(` (${String(args.content ?? "").split("\n").length} lines)`));
    } else body.push(oneLine(JSON.stringify(args), w));
    const title = tool.name + (reason ? ` · ${reason}` : "");
    line(box(body, title, reason ? c.red : c.yellow).replace(/^/gm, pad));
    const always = reason ? "" : tool.kind === "edit" && agent.mode === "ask" ? "[a]ll edits this session · " : "[a]lways for this tool · ";
    const hint = reason ? `[y]es · [N]o ${c.dim(`(${reason}: asked every time)`)}` : `[Y]es · ${always}[n]o`;
    const a = await answer(pad + c.yellow(`Allow? ${hint} › `));
    if (running?.signal.aborted) return "no";
    return confirmAnswer(a, !!reason);
  };

  const approvePlan = async (plan: string): Promise<PlanDecision> => {
    endText();
    line(mdBox(plan, "Plan", c.cyan));
    line(`${c.cyan("Approve this plan?")}
  ${c.bold("1")} yes, auto-accept edits    ${c.bold("2")} yes, ask before each change
  ${c.bold("3")} yes, auto mode            ${c.bold("n")} no, keep planning`);
    const a = ((await answer(c.cyan("› "))) ?? "n").trim().toLowerCase();
    if (running?.signal.aborted) return { approved: false, feedback: "" };
    if (a === "" || a === "1" || a === "y") return { approved: true, mode: "acceptEdits" };
    if (a === "2") return { approved: true, mode: "ask" };
    if (a === "3") return { approved: true, mode: "auto" };
    const feedback = (await answer(c.cyan("What should change? › "))) ?? "";
    return { approved: false, feedback };
  };

  const makeUI = (depth: number): AgentUI => {
    const pad = depth ? c.gray("  │ ".repeat(depth)) : "";
    // args of started calls per tool name, matched to their results in order (sequential and parallel calls)
    const started = new Map<string, Record<string, unknown>[]>();
    return {
      onText: (t) => {
        if (depth) return; // a subagent's prose stays inside the subagent; its report is the tool result
        if (thinkingShown) {
          thinkingShown = false;
          endText();
        }
        md.push(t);
      },
      onReasoning: (t) => {
        if (depth || !showThinking) return;
        thinkingShown = true;
        raw(c.dim(c.italic(t)));
      },
      onWaiting: () => footer.draw(),
      onToolStart: (name, args) => {
        const list = started.get(name) ?? [];
        list.push(args);
        started.set(name, list);
        const summary = argSummary(name, args, agent.cwd);
        line(pad + c.cyan("● ") + c.bold(name) + (summary ? c.dim(`(${summary})`) : ""));
      },
      onToolEnd: (name, result, isError, change?: WriteChange) => renderToolEnd(pad, name, result, isError, started.get(name)?.shift() ?? {}, change),
      onInfo: (m) => line(pad + c.yellow(`  ${m}`)),
      confirm: (tool, args, reason) => confirm(pad, tool, args, reason),
      approvePlan: depth ? undefined : approvePlan,
      child: (label) => {
        line(pad + c.magenta("  ◆ ") + c.bold("subagent ") + c.dim(label));
        return makeUI(depth + 1);
      },
    };
  };
  const ui = makeUI(0);

  const status = async () => {
    const win = (ctxWindow = await agent.contextWindow());
    const used = agent.contextUsed();
    const pct = Math.round((used / win) * 100);
    const paintPct = pct >= 80 ? c.red : pct >= 60 ? c.yellow : c.gray;
    const t = agent.lastTimings;
    const speed = t ? c.gray(` · ${t.predicted_per_second.toFixed(0)} tok/s`) : "";
    const n = agent.changes.list().length;
    const files = n ? c.gray(" · ") + c.yellow(`${n} file${n === 1 ? "" : "s"} changed`) : "";
    line(
      c.gray("── ") + MODE_STYLE[agent.mode](MODES[agent.mode].label) + c.gray(` · ctx ${formatTokens(used)}/${formatTokens(win)} `) +
        paintPct(`(${pct}%)`) + speed + files + c.gray(" ──"),
    );
  };

  const run = async (fn: (signal: AbortSignal) => Promise<unknown>) => {
    running = new AbortController();
    runStarted = Date.now();
    md.reset();
    footer.start();
    try {
      await fn(running.signal);
    } catch (e) {
      if (!running.signal.aborted) line(c.red(`  ✗ ${(e as Error).message}`));
    } finally {
      footer.stop();
      endText();
      running = undefined;
      await status();
    }
  };
  const ask = (text: string) => run((signal) => agent.send(text, ui, signal));

  // ----- change tracking commands -----
  const STATUS_PAINT = { A: c.green, M: c.yellow, D: c.red };
  const tracker = () => agent.changes;
  const tellModel = (paths: string[], what: string) => {
    if (!paths.length) return;
    const message = `The user ${what}: ${paths.map((p) => shortPath(p, agent.cwd)).join(", ")}. Re-read files before editing them.`;
    agent.notifyFilesChanged(paths, message);
  };
  const confirmYesNo = async (question: string) => /^\s*[yд]/i.test((await answer(c.yellow(`${question} [y/N] › `))) ?? "");
  const listPaths = (paths: string[]) => paths.map((p) => "    " + shortPath(p, agent.cwd)).join("\n");

  const showFiles = () => {
    const tr = tracker();
    if (!tr) return;
    const files = tr.list();
    if (!files.length) return line(c.dim("  No files changed in this session."));
    const names = files.map((f) => shortPath(f.path, agent.cwd));
    const nw = Math.max(...names.map((n) => n.length));
    files.forEach((f, i) => {
      const stat = `${c.green(`+${f.added}`.padStart(5))} ${c.red(`-${f.removed}`.padEnd(5))}`;
      line(`  ${STATUS_PAINT[f.status](f.status)} ${names[i].padEnd(nw)}  ${stat} ${c.dim(`${f.tools.join(",")}×${f.writes}`)}`);
    });
  };

  const showDiff = (arg: string) => {
    const tr = tracker();
    if (!tr) return;
    const target = arg ? resolve(agent.cwd, arg) : undefined;
    const files = tr.list().filter((f) => !target || f.path === target);
    if (!files.length) return line(c.dim(target ? `  No changes to ${arg} in this session.` : "  No files changed in this session."));
    const text: string[] = [];
    for (const f of files) {
      text.push(c.bold(`${STATUS_PAINT[f.status](f.status)} ${shortPath(f.path, agent.cwd)}`) + " " + c.green(`+${f.added}`) + " " + c.red(`-${f.removed}`));
      const base = tr.base(f.path);
      const now = readText(f.path);
      if (base === undefined || now === undefined) text.push(c.dim("  (binary or too large to diff)"));
      else text.push(...renderDiff(f.path, base, now, { width: out.columns || 100 }));
      text.push("");
    }
    page(text.join("\n"), rl);
  };

  const view = (arg: string) => {
    if (!arg) return line(c.dim("  Usage: /view <path>[:start[-end]]"));
    const spec = parseViewSpec(arg);
    const abs = resolve(agent.cwd, spec.path);
    const text = readText(abs);
    if (text === null) return line(c.red(`  No such file: ${spec.path}`));
    if (text === undefined) return line(c.dim(`  ${spec.path} is binary or too large to show.`));
    const lines = text.split("\n");
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    const start = Math.max(1, spec.start ?? 1);
    const end = Math.min(lines.length, spec.end ?? lines.length);
    if (start > end) return line(c.dim(`  ${spec.path} has ${lines.length} lines.`));
    const hl = lineHighlighter(langFromPath(abs, lines[0]));
    const nw = String(end).length;
    const shown: string[] = [c.bold(shortPath(abs, agent.cwd)) + c.dim(` (${start}-${end} of ${lines.length})`)];
    for (let i = 0; i < end; i++) {
      const code = hl(lines[i]); // earlier lines too, so block comments/strings carry over
      if (i + 1 >= start) shown.push(c.gray(String(i + 1).padStart(nw) + " │ ") + code);
    }
    page(shown.join("\n"), rl);
  };

  const undo = async () => {
    const tr = tracker();
    if (!tr) return;
    const last = tr.peekUndo();
    if (!last) return line(c.dim("  Nothing to undo."));
    line(`  The last turn${last.turn ? c.dim(` (${oneLine(last.turn, 60)})`) : ""} changed:\n${listPaths(last.paths)}`);
    if (!(await confirmYesNo("  Restore these files?"))) return line(c.dim("  Kept."));
    const res = tr.undo();
    if (!res) return;
    if (res.paths.length) line(c.green(`  Restored ${res.paths.length} file${res.paths.length === 1 ? "" : "s"}.`));
    if (res.notRestored.length) line(c.yellow(`  Not restorable (binary or too large):\n${listPaths(res.notRestored)}`));
    tellModel(res.paths, "undid your changes to");
  };

  const revert = async (arg: string) => {
    const tr = tracker();
    if (!tr) return;
    const target = arg ? resolve(agent.cwd, arg) : undefined;
    const files = tr.list().filter((f) => !target || f.path === target);
    if (!files.length) return line(c.dim(target ? `  No changes to ${arg} in this session.` : "  No files changed in this session."));
    line(`  Back to how they were at session start:\n${listPaths(files.map((f) => f.path))}`);
    if (!(await confirmYesNo("  Revert?"))) return line(c.dim("  Kept."));
    const done = target ? tr.revert(target) : tr.revert();
    line(c.green(`  Reverted ${done.length} file${done.length === 1 ? "" : "s"}.`));
    tellModel(done, "reverted these files to how they were at session start");
  };

  const showContext = async () => {
    const used = agent.contextUsed();
    const w = await agent.contextWindow();
    const loaded = [...agent.registry.loaded].filter((n) => agent.registry.deferred.has(n));
    line(
      `  ${formatTokens(used)} / ${formatTokens(w)} tokens (${Math.round((used / w) * 100)}%) · ${agent.messages.length} messages` +
        c.dim(`\n  auto-compact at ${Math.round(agent.settings.autoCompact * 100)}% · loaded deferred tools: ${loaded.join(", ") || "none"}`),
    );
  };

  /** Markdown rendered into a box (side answers, plans). */
  const mdBox = (text: string, title: string, paint: (s: string) => string) => {
    const rendered: string[] = [];
    const r = new MarkdownStream((x) => rendered.push(...x.replace(/\n$/, "").split("\n")));
    r.push(wrapText(text, width() - 6).join("\n") + "\n");
    return box(rendered, title, paint);
  };

  // ----- typing while the agent works -----
  // ">note" goes to the main agent, ">#2 note" to subagent #2, a few /commands run right away,
  // anything else is a question about the progress, answered on the side without touching the history.
  const whileRunning = (text: string) => {
    const t = text.trim();
    if (!t) return;
    remember(t);
    if (t.startsWith("/") && !isPathLike(t)) {
      const cmd = t.slice(1).split(/\s+/)[0];
      if (cmd === "status") line(renderStatus(agent.board));
      else if (cmd === "context") void showContext();
      else if (cmd === "files") showFiles();
      else line(c.dim(`  While the agent works: /status, /context, /files; >note tells the agent something; other text asks about the progress.`));
      return;
    }
    const steer = /^>\s*(?:#(\d+)\s+)?([\s\S]+)$/.exec(t);
    if (steer) {
      const id = Number(steer[1] ?? 0);
      const note = steer[2].trim();
      if (agent.steer(note, id)) line(c.gray("  ↳ ") + c.dim(`for ${id ? `#${id}` : "the agent"}, with its next step: `) + note);
      else if (id) line(c.yellow(`  #${id} is not running. /status lists the agents.`));
      else {
        queue.push(note);
        line(c.dim("  ↳ the agent has just finished: this will be the next message"));
      }
      return;
    }
    line(c.cyan("  ? ") + t);
    const ac = new AbortController();
    asides.add(ac);
    agent
      .askAside(t, ac.signal)
      .then((a) => line(mdBox(a || "(no answer)", c.cyan("ⓘ"), c.cyan)))
      .catch((e) => {
        if (!ac.signal.aborted) line(c.red(`  ✗ side question failed: ${(e as Error).message}`));
      })
      .finally(() => asides.delete(ac));
  };

  // ----- banner -----
  const reg = agent.registry;
  const win = (ctxWindow = await agent.contextWindow());
  const host = agent.settings.baseUrl.replace(/^https?:\/\//, "").replace(/\/v1\/?$/, "");
  line(
    box(
      [
        c.bold("agent") + c.dim(" — local coding agent"),
        `${c.cyan(agent.settings.model)} ${c.dim("@")} ${host} ${c.dim("·")} ctx ${formatTokens(win)}`,
        c.dim(`${reg.core.size} tools · ${reg.skills.size} skills · ${reg.agents.size} subagents · ${reg.deferred.size} deferred · ${reg.commands.size} commands`),
        `${key("/")} ${c.dim("commands ·")} ${key("@")} ${c.dim("files ·")} ${key("?")} ${c.dim("shortcuts ·")} ${key("shift+tab")} ${c.dim("mode")}`,
      ],
      "",
      c.magenta,
    ),
  );
  for (const w of warnings) line(c.yellow(w));
  if (agent.mode !== "ask") line(MODE_STYLE[agent.mode](`⏵⏵ mode: ${MODES[agent.mode].label}`) + c.dim(` — ${MODES[agent.mode].description}`));

  // ----- main loop -----
  if (initialPrompt?.trim()) queue.unshift(initialPrompt);
  while (true) {
    let rawInput = await nextLine(promptFor(agent.mode));
    if (rawInput === null) break;
    // a trailing backslash continues the input on the next line
    while (rawInput.endsWith("\\")) {
      const more = await nextLine(c.gray("… "));
      if (more === null) break;
      rawInput = rawInput.slice(0, -1) + "\n" + more;
    }
    // stray tabs come from shift+tab; multi-line (pasted) input keeps its indentation
    const input = (rawInput.includes("\n") ? rawInput : rawInput.replace(/\t/g, "")).trim();
    if (!input) continue;
    remember(input);
    if (input === "?") {
      line(shortcutsText());
      continue;
    }
    const [, cmd, args] = input.slice(1).match(/^(\S*)\s*([\s\S]*)$/)!;
    if (!input.startsWith("/") || (isPathLike(input) && !reg.commands.has(cmd) && !reg.skills.has(cmd))) {
      const { text, attached } = expandMentions(input, agent.cwd);
      for (const a of attached) line(c.gray("  ⎿ ") + c.dim(`@${a.path} (${a.summary})`));
      await ask(text);
      continue;
    }

    switch (cmd) {
      case "exit":
      case "quit":
        rl.close();
        return;
      case "help":
        line(helpText());
        break;
      case "keys":
        line(shortcutsText());
        break;
      case "status":
        line(renderStatus(agent.board));
        break;
      case "clear":
        agent.reset();
        line(c.dim("  New conversation."));
        break;
      case "mode": {
        const m = parseMode(args);
        if (m) agent.setMode(m);
        else {
          for (const k of [...MODE_CYCLE, "yolo" as Mode]) {
            line(`  ${k === agent.mode ? MODE_STYLE[k]("●") : " "} ${MODE_STYLE[k](MODES[k].label.padEnd(13))} ${c.dim(MODES[k].description)}`);
          }
        }
        break;
      }
      case "plan":
      case "auto":
        agent.setMode(cmd);
        if (args) await ask(args);
        break;
      case "compact":
        await run((signal) => agent.compact(ui, signal, { focus: args || undefined }));
        break;
      case "context":
        await showContext();
        break;
      case "thinking":
        showThinking = !showThinking;
        line(c.dim(`  reasoning ${showThinking ? "shown" : "hidden"}`));
        break;
      case "skills":
        line([...reg.skills.values()].map((s) => `  ${c.bold(s.name)} ${c.dim(oneLine(s.description, 90))}`).join("\n") || "  No skills.");
        break;
      case "agents":
        line(
          [...reg.agents.values()].map((a) => `  ${c.bold(a.name)}${a.readOnly ? c.dim(" (read-only)") : ""} ${c.dim(oneLine(a.description, 90))}`).join("\n") ||
            "  No subagents.",
        );
        break;
      case "commands":
        line([...reg.commands.values()].map((x) => `  /${c.bold(x.name)} ${c.dim(oneLine(x.description, 90))}`).join("\n") || "  No commands.");
        break;
      case "tools": {
        const core = [...reg.core.keys()].join(", ");
        const deferred = [...reg.deferred.values()].map((t) => `  ${reg.loaded.has(t.name) ? c.green("✓") : " "} ${t.name} ${c.dim(t.source ?? "")}`);
        line(`  ${c.bold("core:")} ${core}\n  ${c.bold("deferred")} ${c.dim("(✓ = loaded)")}:\n${deferred.join("\n") || "    none"}`);
        break;
      }
      case "files":
        showFiles();
        break;
      case "diff":
        showDiff(args);
        break;
      case "view":
        view(args);
        break;
      case "undo":
        await undo();
        break;
      case "revert":
        await revert(args);
        break;
      case "last":
        if (!lastResult) line(c.dim("  No tool has run yet."));
        else page(c.bold(lastResult.name) + "\n" + lastResult.result, rl);
        break;
      default:
        if (reg.commands.has(cmd)) await ask(expandCommand(reg.commands.get(cmd)!.template, args));
        else if (reg.skills.has(cmd)) await ask(`The user invoked the "${cmd}" skill. Follow these instructions:\n\n${skillPrompt(reg, cmd, args)}`);
        else line(c.red(`  Unknown command /${cmd}. Try /help.`));
    }
  }
  rl.close();
}
