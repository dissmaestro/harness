#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Agent } from "./core/loop.ts";
import { parseMode } from "./core/modes.ts";
import { findSession, listSessions } from "./core/sessions.ts";
import { stopAllLsp } from "./core/lsp.ts";
import { loadSettings } from "./core/settings.ts";
import type { Registry } from "./registry/registry.ts";
import { loadRegistry } from "./registry/load.ts";
import { type OutputFormat, runHeadless } from "./ui/headless.ts";
import { c, configureLinks } from "./ui/render.ts";
import { runRepl } from "./ui/repl.ts";
import { killAllProcesses, VERSION } from "./util.ts";

const USAGE = `Usage: agent [options] [prompt]
  [prompt]               start the REPL with this first message (with -p: run it headless)
  -p, --print            run the prompt non-interactively and print the answer;
                         piped stdin is appended: cat log | agent -p "explain"
      --output-format <f> with -p: text (default) | json (one object at the end:
                         answer, tool calls, changed files, context) | stream-json
                         (one JSON event per line, then the result)
      --json             same as --output-format json
  -m, --model <name>     model name sent to the server
      --base-url <url>   OpenAI-compatible endpoint (default http://localhost:8080/v1)
      --api-key <key>    API key sent as "Authorization: Bearer <key>" (server --api-key)
      --mode <mode>      start in: ask | acceptEdits | plan | auto | yolo
      --plan             same as --mode plan (read-only research, then a plan)
      --auto             same as --mode auto (everything except dangerous actions)
      --accept-edits     same as --mode acceptEdits
      --yolo             same as --mode yolo (never ask)
      --max-steps <n>    stop after n model turns per prompt (default 60)
      --test-cmd <cmd>   run after a turn that changed files; failures go back to the model
      --lint-cmd <cmd>   same, run before the tests
  -c, --continue         continue the latest conversation in this directory
  -r, --resume [id]      continue a saved conversation (without id: list them)
  -v, --version
  -h, --help

Env: AGENT_BASE_URL, AGENT_MODEL, AGENT_API_KEY
Config: ~/.agent/settings.json, .agent/settings.json`;

let registry: Registry | undefined;
let interactive = false;

function cleanup() {
  stopAllLsp();
  killAllProcesses();
  registry?.dispose();
}

process.on("exit", cleanup);
for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(code);
  });
}
// A bug in one tool or callback must not kill a REPL session with all its context.
const onCrash = (kind: string) => (e: unknown) => {
  const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
  process.stderr.write(c.red(`\n${kind}: `) + c.dim(msg) + "\n");
  if (!interactive) process.exit(1);
};
process.on("uncaughtException", onCrash("uncaught exception"));
process.on("unhandledRejection", onCrash("unhandled rejection"));

async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: "boolean", short: "p" },
      "output-format": { type: "string" },
      json: { type: "boolean" },
      model: { type: "string", short: "m" },
      "base-url": { type: "string" },
      "api-key": { type: "string" },
      mode: { type: "string" },
      plan: { type: "boolean" },
      auto: { type: "boolean" },
      "accept-edits": { type: "boolean" },
      yolo: { type: "boolean" },
      "max-steps": { type: "string" },
      "test-cmd": { type: "string" },
      "lint-cmd": { type: "string" },
      continue: { type: "boolean", short: "c" },
      resume: { type: "boolean", short: "r" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.version) {
    console.log(VERSION);
    return;
  }

  let maxSteps: number | undefined;
  if (values["max-steps"] !== undefined) {
    maxSteps = Number(values["max-steps"]);
    if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error(`--max-steps needs a positive integer, got "${values["max-steps"]}".`);
  }

  const cwd = process.cwd();
  // --resume [id]: the id, if any, is the first positional word
  let resumeId = values.continue ? "latest" : undefined;
  if (values.resume) {
    const sessions = listSessions(cwd);
    const id = positionals[0] && sessions.some((s) => s.id === positionals[0] || s.id.startsWith(positionals[0])) ? positionals.shift()! : undefined;
    if (!id) {
      if (!sessions.length) throw new Error("No saved conversations for this directory.");
      console.log(c.bold("Saved conversations") + c.dim(" (agent --resume <id>):"));
      for (const s of sessions.slice(0, 20)) {
        console.log(`  ${c.cyan(s.id)}  ${c.dim(s.updated.toLocaleString())}  ${s.title}${c.dim(` (${s.messages} msgs)`)}`);
      }
      return;
    }
    resumeId = id;
  }

  let prompt = positionals.join(" ").trim();
  if (values.print && !process.stdin.isTTY) {
    const input = (await readStdin()).trimEnd();
    if (input) prompt = `${prompt}\n\n<stdin>\n${input}\n</stdin>`.trimStart();
  }
  if (values.print && !prompt) throw new Error('-p needs a prompt: agent -p "your task" (or pipe text into stdin).');
  const format = (values.json ? "json" : (values["output-format"] ?? "text")) as OutputFormat;
  if (!["text", "json", "stream-json"].includes(format)) throw new Error(`Unknown --output-format "${format}". Use text, json or stream-json.`);
  if (format !== "text" && !values.print) throw new Error(`--output-format ${format} works with -p.`);

  const settings = loadSettings(cwd);
  if (values.model) settings.model = values.model;
  if (values["base-url"]) settings.baseUrl = values["base-url"];
  if (values["api-key"]) settings.apiKey = values["api-key"];
  if (values["test-cmd"] || values["lint-cmd"]) {
    settings.verify = { ...settings.verify, ...(values["test-cmd"] && { test: values["test-cmd"] }), ...(values["lint-cmd"] && { lint: values["lint-cmd"] }) };
  }
  configureLinks(settings);
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
  registry = await loadRegistry(cwd, settings, (w) => warnings.push(w));
  const agent = new Agent({ cwd, settings, registry, maxSteps, persist: true });
  if (resumeId) {
    const saved = findSession(cwd, resumeId);
    if (!saved) throw new Error(resumeId === "latest" ? "No saved conversation to continue in this directory." : `No saved conversation "${resumeId}". Run agent --resume to list them.`);
    agent.loadSession(saved.file, saved.id);
    warnings.push(`Continuing "${saved.title}" (${saved.messages} messages, ${saved.updated.toLocaleString()}).`);
  }

  if (values.print) {
    const code = await runHeadless(agent, prompt, warnings, format);
    process.exit(code);
  }
  interactive = true;
  await runRepl(agent, warnings, prompt || undefined);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
