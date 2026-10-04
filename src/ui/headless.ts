import type { Agent, AgentUI } from "../core/loop.ts";
import { argSummary, c, resultSummary } from "./render.ts";

/** agent -p "prompt": answer on stdout, tool activity on stderr. Actions that would need a question are denied. */
export async function runHeadless(agent: Agent, prompt: string, warnings: string[]): Promise<number> {
  const err = (s: string) => process.stderr.write(s + "\n");
  for (const w of warnings) err(c.yellow(w));
  const makeUI = (pad: string): AgentUI => ({
    onText: (t) => {
      if (!pad) process.stdout.write(t);
    },
    onToolStart: (name, args) => err(pad + c.dim(`● ${name}(${argSummary(name, args, agent.cwd)})`)),
    onToolEnd: (_n, result, isError) => err(pad + c.dim("  ⎿ ") + (isError ? c.red(resultSummary(result)) : c.dim(resultSummary(result)))),
    onInfo: (m) => err(pad + c.yellow(m)),
    confirm: async (tool, _args, reason) => {
      const hint = reason ? "only --yolo allows it" : "use --mode acceptEdits, --auto or --yolo";
      err(pad + c.yellow(`  denied ${tool.name}${reason ? ` (${reason})` : ""}: nobody to ask in -p mode; ${hint}`));
      return "no";
    },
    child: (label) => {
      err(pad + c.magenta(`◆ subagent ${label}`));
      return makeUI(pad + "  │ ");
    },
  });
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  try {
    await agent.send(prompt, makeUI(""), ac.signal);
    process.stdout.write("\n");
    return 0;
  } catch (e) {
    err(c.red(`Error: ${(e as Error).message}`));
    return 1;
  }
}
