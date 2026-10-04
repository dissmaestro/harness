#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Agent } from "./core/loop.ts";
import { parseMode } from "./core/modes.ts";
import { loadSettings } from "./core/settings.ts";
import { loadRegistry } from "./registry/load.ts";
import { runHeadless } from "./ui/headless.ts";
import { runRepl } from "./ui/repl.ts";

const USAGE = `Usage: agent [options]
  -p, --print <prompt>   run one prompt non-interactively and print the answer
  -m, --model <name>     model name sent to the server
      --base-url <url>   OpenAI-compatible endpoint (default http://localhost:8080/v1)
      --mode <mode>      start in: ask | acceptEdits | plan | auto | yolo
      --plan             same as --mode plan (read-only research, then a plan)
      --auto             same as --mode auto (everything except dangerous actions)
      --accept-edits     same as --mode acceptEdits
      --yolo             same as --mode yolo (never ask)
  -h, --help

Env: AGENT_BASE_URL, AGENT_MODEL, AGENT_API_KEY
Config: ~/.agent/settings.json, .agent/settings.json`;

async function main() {
  const { values } = parseArgs({
    options: {
      print: { type: "string", short: "p" },
      model: { type: "string", short: "m" },
      "base-url": { type: "string" },
      mode: { type: "string" },
      plan: { type: "boolean" },
      auto: { type: "boolean" },
      "accept-edits": { type: "boolean" },
      yolo: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const cwd = process.cwd();
  const settings = loadSettings(cwd);
  if (values.model) settings.model = values.model;
  if (values["base-url"]) settings.baseUrl = values["base-url"];
  if (values["accept-edits"]) settings.permissionMode = "acceptEdits";
  if (values.plan) settings.permissionMode = "plan";
  if (values.auto) settings.permissionMode = "auto";
  if (values.yolo) settings.permissionMode = "yolo";
  if (values.mode) {
    const mode = parseMode(values.mode);
    if (!mode) throw new Error(`Unknown mode "${values.mode}". Use ask, acceptEdits, plan, auto or yolo.`);
    settings.permissionMode = mode;
  }

  const warnings: string[] = [];
  const registry = await loadRegistry(cwd, settings, (w) => warnings.push(w));
  process.on("exit", () => registry.dispose());
  const agent = new Agent({ cwd, settings, registry });

  if (values.print !== undefined) {
    const code = await runHeadless(agent, values.print, warnings);
    process.exit(code);
  }
  await runRepl(agent, warnings);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
