import { createInterface } from "node:readline";
import type { Agent, AgentUI, PlanDecision } from "../core/loop.ts";
import { MODES, MODE_CYCLE, nextMode, parseMode, type Mode } from "../core/modes.ts";
import { expandCommand } from "../registry/loaders/skills.ts";
import { skillPrompt } from "../tools/Skill.ts";
import type { Tool } from "../types.ts";
import { oneLine } from "../util.ts";
import { MarkdownStream } from "./markdown.ts";
import { MODE_STYLE, argSummary, box, c, diffLines, formatTokens, resultSummary, shortPath } from "./render.ts";
import { Spinner } from "./spinner.ts";

const HELP = `${c.bold("Modes")} ${c.dim("(shift+tab cycles ask → accept edits → plan → auto)")}
  ask           reads freely, asks before edits and commands
  accept edits  edits files in the project without asking, commands still ask
  plan          read-only research, then a plan for you to approve
  auto          runs everything except dangerous commands and edits outside the project
  yolo          never asks (only via /mode yolo or --yolo)

${c.bold("Commands")}
  /mode [name]          show or switch mode       /plan  /auto  shortcuts
  /compact [focus]      summarize the conversation to free context
  /context              context usage
  /clear                start a new conversation
  /skills /agents /tools /commands   what is available
  /thinking             show or hide the model's reasoning
  /exit                 quit (or ctrl+d)
  /<skill> [args]       run a skill        /<command> [args]  run a command
${c.dim("ctrl+c interrupts the current answer; at an empty prompt it quits.")}`;

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

export async function runRepl(agent: Agent, warnings: string[]) {
  const out = process.stdout;
  const width = () => Math.max(40, Math.min(out.columns || 100, 120));
  const rl = createInterface({ input: process.stdin, output: out, historySize: 1000, terminal: !!out.isTTY });
  const spinner = new Spinner(out);
  let atLineStart = true;
  let running: AbortController | undefined;
  let showThinking = false;
  let thinkingShown = false;

  const raw = (s: string) => {
    if (!s) return;
    spinner.stop();
    out.write(s);
    atLineStart = s.endsWith("\n");
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

  // ----- input: queued lines so type-ahead isn't lost -----
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | undefined;
  let closed = false;
  rl.on("line", (l) => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(l);
    } else queue.push(l);
  });
  rl.on("close", () => {
    closed = true;
    waiter?.(null);
  });
  const nextLine = (prompt: string): Promise<string | null> => {
    spinner.stop();
    rl.setPrompt(prompt);
    rl.prompt();
    atLineStart = true;
    if (queue.length) return Promise.resolve(queue.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise((r) => (waiter = r));
  };

  const promptFor = (m: Mode) => (m === "ask" ? "" : MODE_STYLE[m](`⏵⏵ ${MODES[m].label} `)) + c.green("› ");

  // ----- shift+tab cycles modes -----
  agent.onModeChange = (m) => {
    if (running) {
      line(MODE_STYLE[m](`  ⏵⏵ mode: ${MODES[m].label}`) + c.dim(` — ${MODES[m].description}`));
      return;
    }
    if (!waiter) return; // not at the prompt (e.g. "/plan <task>" is about to run): nothing to redraw
    setImmediate(() => {
      const r = rl as unknown as { line: string; cursor: number };
      if (r.line.includes("\t")) {
        r.line = r.line.replace(/\t/g, "");
        r.cursor = r.line.length;
      }
      rl.setPrompt(promptFor(m));
      rl.prompt(true);
    });
  };
  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (_s, key) => {
      if (key?.name === "tab" && key.shift) agent.setMode(nextMode(agent.mode));
    });
  }

  rl.on("SIGINT", () => {
    if (running) {
      running.abort();
      spinner.stop();
      line(c.yellow("  ⏹ interrupted"));
    } else rl.close();
  });

  // ----- rendering of tool activity -----
  const lastArgs = new Map<string, Record<string, unknown>>();

  const renderToolEnd = (pad: string, name: string, result: string, isError: boolean) => {
    const args = lastArgs.get(name) ?? {};
    const lead = pad + c.gray("  ⎿ ");
    const more = pad + "    ";
    if (isError) {
      line(lead + c.red(resultSummary(result, 3).replace(/\n/g, "\n" + more)));
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

  const confirm = async (pad: string, tool: Tool, args: Record<string, unknown>, reason?: string) => {
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
    const a = ((await nextLine(pad + c.yellow("Allow? [y]es · [a]lways for this tool · [n]o › "))) ?? "n").trim().toLowerCase();
    return a.startsWith("a") ? "always" : a === "" || a.startsWith("y") || a.startsWith("д") ? "yes" : "no";
  };

  const approvePlan = async (plan: string): Promise<PlanDecision> => {
    endText();
    const rendered: string[] = [];
    const r = new MarkdownStream((s) => rendered.push(...s.replace(/\n$/, "").split("\n")));
    r.push(wrapText(plan, width() - 6).join("\n") + "\n");
    line(box(rendered, "Plan", c.cyan));
    line(`${c.cyan("Approve this plan?")}
  ${c.bold("1")} yes, auto-accept edits    ${c.bold("2")} yes, ask before each change
  ${c.bold("3")} yes, auto mode            ${c.bold("n")} no, keep planning`);
    const a = ((await nextLine(c.cyan("› "))) ?? "n").trim().toLowerCase();
    if (a === "" || a === "1" || a === "y") return { approved: true, mode: "acceptEdits" };
    if (a === "2") return { approved: true, mode: "ask" };
    if (a === "3") return { approved: true, mode: "auto" };
    const feedback = (await nextLine(c.cyan("What should change? › "))) ?? "";
    return { approved: false, feedback };
  };

  const makeUI = (depth: number): AgentUI => {
    const pad = depth ? c.gray("  │ ".repeat(depth)) : "";
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
      onWaiting: (waiting) => {
        if (waiting) spinner.start(depth ? "subagent working" : agent.mode === "plan" ? "planning" : "thinking");
        else spinner.stop();
      },
      onToolStart: (name, args) => {
        lastArgs.set(name, args);
        const summary = argSummary(name, args, agent.cwd);
        line(pad + c.cyan("● ") + c.bold(name) + (summary ? c.dim(`(${summary})`) : ""));
      },
      onToolEnd: (name, result, isError) => renderToolEnd(pad, name, result, isError),
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
    const win = await agent.contextWindow();
    const used = agent.contextUsed();
    const pct = Math.round((used / win) * 100);
    const paintPct = pct >= 80 ? c.red : pct >= 60 ? c.yellow : c.gray;
    const t = agent.lastTimings;
    const speed = t ? c.gray(` · ${t.predicted_per_second.toFixed(0)} tok/s`) : "";
    line(
      c.gray("── ") + MODE_STYLE[agent.mode](MODES[agent.mode].label) + c.gray(` · ctx ${formatTokens(used)}/${formatTokens(win)} `) +
        paintPct(`(${pct}%)`) + speed + c.gray(" ──"),
    );
  };

  const run = async (fn: (signal: AbortSignal) => Promise<unknown>) => {
    running = new AbortController();
    md.reset();
    try {
      await fn(running.signal);
    } catch (e) {
      if (!running.signal.aborted) line(c.red(`  ✗ ${(e as Error).message}`));
    } finally {
      spinner.stop();
      endText();
      running = undefined;
      await status();
    }
  };
  const ask = (text: string) => run((signal) => agent.send(text, ui, signal));

  // ----- banner -----
  const reg = agent.registry;
  const win = await agent.contextWindow();
  const host = agent.settings.baseUrl.replace(/^https?:\/\//, "").replace(/\/v1\/?$/, "");
  line(
    box(
      [
        c.bold("agent") + c.dim(" — local coding agent"),
        `${c.cyan(agent.settings.model)} ${c.dim("@")} ${host} ${c.dim("·")} ctx ${formatTokens(win)}`,
        c.dim(`${reg.core.size} tools · ${reg.skills.size} skills · ${reg.agents.size} subagents · ${reg.deferred.size} deferred · ${reg.commands.size} commands`),
        c.dim("shift+tab: mode · /help · ctrl+c: interrupt"),
      ],
      "",
      c.magenta,
    ),
  );
  for (const w of warnings) line(c.yellow(w));
  if (agent.mode !== "ask") line(MODE_STYLE[agent.mode](`⏵⏵ mode: ${MODES[agent.mode].label}`) + c.dim(` — ${MODES[agent.mode].description}`));

  // ----- main loop -----
  while (true) {
    const rawInput = await nextLine(promptFor(agent.mode));
    if (rawInput === null) break;
    const input = rawInput.replace(/\t/g, "").trim();
    if (!input) continue;
    if (!input.startsWith("/")) {
      await ask(input);
      continue;
    }

    const [cmd, ...rest] = input.slice(1).split(" ");
    const args = rest.join(" ").trim();
    switch (cmd) {
      case "exit":
      case "quit":
        rl.close();
        return;
      case "help":
        line(HELP);
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
      case "context": {
        const used = agent.contextUsed();
        const w = await agent.contextWindow();
        const loaded = [...reg.loaded].filter((n) => reg.deferred.has(n));
        line(
          `  ${formatTokens(used)} / ${formatTokens(w)} tokens (${Math.round((used / w) * 100)}%) · ${agent.messages.length} messages` +
            c.dim(`\n  auto-compact at ${Math.round(agent.settings.autoCompact * 100)}% · loaded deferred tools: ${loaded.join(", ") || "none"}`),
        );
        break;
      }
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
      default:
        if (reg.commands.has(cmd)) await ask(expandCommand(reg.commands.get(cmd)!.template, args));
        else if (reg.skills.has(cmd)) await ask(`The user invoked the "${cmd}" skill. Follow these instructions:\n\n${skillPrompt(reg, cmd, args)}`);
        else line(c.red(`  Unknown command /${cmd}. Try /help.`));
    }
  }
  rl.close();
}
