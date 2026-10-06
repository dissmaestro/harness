import { relative } from "node:path";
import type { Agent, AgentUI } from "../core/loop.ts";
import { diffStat } from "./diff.ts";
import { argSummary, c, contextLabel, resultSummary } from "./render.ts";

export type OutputFormat = "text" | "json" | "stream-json";

interface ToolRecord {
  /** 0 = the main agent, otherwise the subagent's number */
  agent: number;
  name: string;
  args: Record<string, unknown>;
  ok?: boolean;
  summary?: string;
}

/**
 * agent -p "prompt": actions that would need a question are denied.
 * text: the answer on stdout, tool activity on stderr.
 * json: one JSON object on stdout at the end (answer, tool calls, changed files, context, subagents).
 * stream-json: one JSON object per line as things happen, then the same final object with "type": "result".
 */
export async function runHeadless(agent: Agent, prompt: string, warnings: string[], format: OutputFormat = "text"): Promise<number> {
  const text = format === "text";
  const err = (s: string) => process.stderr.write(s + "\n");
  const emit = (event: object) => {
    if (format === "stream-json") process.stdout.write(JSON.stringify(event) + "\n");
  };
  for (const w of warnings) text ? err(c.yellow(w)) : emit({ type: "info", message: w });

  const started = Date.now();
  const tools: ToolRecord[] = [];
  const denied: string[] = [];
  let answer = "";

  const makeUI = (pad: string, id: number): AgentUI => {
    const open: ToolRecord[] = [];
    return {
      onText: (t) => {
        if (id) return;
        answer += t;
        if (text) process.stdout.write(t);
        else emit({ type: "text", text: t });
      },
      onToolStart: (name, args) => {
        const rec: ToolRecord = { agent: id, name, args };
        tools.push(rec);
        open.push(rec);
        if (text) err(pad + c.dim(`● ${name}(${argSummary(name, args, agent.cwd)})`));
        else emit({ type: "tool_start", agent: id, name, args });
      },
      onToolEnd: (name, result, isError, change?: { path: string; before: string | null; after: string | null }) => {
        const rec = open.find((r) => r.name === name && r.ok === undefined);
        if (rec) open.splice(open.indexOf(rec), 1);
        const summary = resultSummary(result).replace(/\x1b\[[0-9;]*m/g, "");
        if (rec) Object.assign(rec, { ok: !isError, summary });
        if (!text) {
          emit({ type: "tool_end", agent: id, name, ok: !isError, summary });
          return;
        }
        let line = isError && !result.startsWith("Not run:") ? c.red(resultSummary(result)) : c.dim(resultSummary(result));
        if (!isError && change) {
          const { added, removed } = diffStat(change.before ?? "", change.after ?? "");
          line += " " + c.green(`+${added}`) + " " + c.red(`-${removed}`);
        }
        err(pad + c.dim("  ⎿ ") + line);
      },
      onInfo: (m) => (text ? err(pad + c.yellow(m)) : emit({ type: "info", agent: id, message: m })),
      confirm: async (tool, _args, reason) => {
        const hint = reason ? "only --yolo allows it" : tool.kind === "edit" ? "use --accept-edits, --auto or --yolo" : "commands need --auto or --yolo";
        const msg = `denied ${tool.name}${reason ? ` (${reason})` : ""}: nobody to ask in -p mode; ${hint}`;
        denied.push(msg);
        if (text) err(pad + c.yellow(`  ${msg}`));
        else emit({ type: "denied", agent: id, tool: tool.name, message: msg });
        return "no";
      },
      child: (label, childId) => {
        if (text) err(pad + c.magenta(`◆ subagent${childId ? ` #${childId}` : ""} ${label}`));
        else emit({ type: "subagent", id: childId, label });
        return makeUI(childId ? `  #${childId} │ ` : pad + "  │ ", childId ?? id);
      },
    };
  };

  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  let error: string | undefined;
  try {
    answer = await agent.send(prompt, makeUI("", 0), ac.signal);
  } catch (e) {
    error = (e as Error).message;
  }
  const window = await agent.contextWindow();
  if (text) {
    if (error) err(c.red(`Error: ${error}`));
    else {
      process.stdout.write("\n");
      // on stderr, so `agent -p ... > answer.txt` still gets only the answer
      err(c.dim(contextLabel(agent.contextUsed(), window)));
    }
    return error ? 1 : 0;
  }
  const result = {
    type: "result",
    ok: !error,
    ...(error && { error }),
    answer: answer.trim(),
    session: agent.journal?.id,
    model: agent.settings.model,
    mode: agent.mode,
    durationMs: Date.now() - started,
    steps: agent.board.root.step,
    context: { used: agent.contextUsed(), window },
    filesChanged: agent.changes.list().map((f) => ({ path: relative(agent.cwd, f.path) || f.path, status: f.status, added: f.added, removed: f.removed })),
    toolCalls: tools,
    subagents: agent.board.root.children.map((a) => ({ id: a.id, type: a.type, description: a.description, state: a.state, steps: a.step, worktree: a.worktree })),
    denied,
  };
  process.stdout.write(JSON.stringify(result, null, format === "json" ? 2 : 0) + "\n");
  return error ? 1 : 0;
}
