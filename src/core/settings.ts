import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HooksConfig } from "../hooks/hooks.ts";
import { parseMode, type Mode } from "./modes.ts";
import type { VerifyConfig } from "./verify.ts";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface WebSearchConfig {
  /** bing (no key, scrapes the HTML page), searxng (needs url), brave (needs apiKey) */
  provider: "bing" | "searxng" | "brave";
  url?: string;
  apiKey?: string;
}

export interface SubagentsConfig {
  /** prefer: the main agent coordinates and hands searches, reading and independent subtasks to subagents */
  delegate: "prefer" | "normal";
  /** how many subagents run at the same time (Agent calls in one reply) */
  parallel: number;
  /** auto: writing subagents that run in parallel get their own git worktree; always; off */
  worktree: "auto" | "always" | "off";
}

export interface Settings {
  /** OpenAI-compatible endpoint: llama-server, Ollama (http://localhost:11434/v1), vLLM, LM Studio */
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  /** starting mode: ask | acceptEdits | plan | auto | yolo ("default" = ask) */
  permissionMode: Mode;
  /** context size in tokens; read from the server's /props when not set */
  contextWindow?: number;
  /** compact the conversation automatically when it fills this share of the context (0 disables) */
  autoCompact: number;
  webSearch: WebSearchConfig;
  /** built-in skills, subagents and web tools shipped with the agent */
  builtins: boolean;
  /** also read .claude/skills, .claude/commands and CLAUDE.md */
  claudeCompat: boolean;
  hooks: HooksConfig;
  mcpServers: Record<string, McpServerConfig>;
  subagents: SubagentsConfig;
  /** what a click on a file path opens: auto, vscode, cursor, codium, zed, idea, file, or a template with {path} {line} {col} */
  editor?: string;
  /** clickable file paths (OSC 8 terminal hyperlinks) */
  hyperlinks?: boolean;
  /** snapshot the project in a shadow git repo before every changing tool call (/restore) */
  checkpoints?: boolean;
  /** lint/test commands run after a turn that changed files; failures go back to the model */
  verify?: VerifyConfig;
}

const DEFAULTS: Settings = {
  baseUrl: "http://localhost:8080/v1",
  model: "local",
  permissionMode: "ask",
  autoCompact: 0.8,
  webSearch: { provider: "bing" },
  builtins: true,
  claudeCompat: true,
  hooks: {},
  mcpServers: {},
  subagents: { delegate: "prefer", parallel: 3, worktree: "auto" },
};

function readJson(path: string): Partial<Settings> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${(e as Error).message}`);
  }
}

/** User settings (~/.agent/settings.json), then project (.agent/settings.json); env vars win. */
export function loadSettings(cwd: string, home = homedir()): Settings {
  const s: Settings = { ...DEFAULTS, hooks: {}, mcpServers: {}, webSearch: { ...DEFAULTS.webSearch }, subagents: { ...DEFAULTS.subagents } };
  for (const file of [join(home, ".agent", "settings.json"), join(cwd, ".agent", "settings.json")]) {
    const { hooks, mcpServers, webSearch, subagents, ...rest } = readJson(file);
    Object.assign(s, rest);
    if (webSearch) Object.assign(s.webSearch, webSearch);
    if (subagents) Object.assign(s.subagents, subagents);
    if (mcpServers) Object.assign(s.mcpServers, mcpServers);
    for (const [event, list] of Object.entries(hooks ?? {})) {
      const key = event as keyof HooksConfig;
      s.hooks[key] = [...(s.hooks[key] ?? []), ...(list ?? [])];
    }
  }
  const mode = parseMode(String(s.permissionMode));
  if (!mode) throw new Error(`Unknown permissionMode "${s.permissionMode}". Use ask, acceptEdits, plan, auto or yolo.`);
  s.permissionMode = mode;
  const env = process.env;
  if (env.AGENT_BASE_URL) s.baseUrl = env.AGENT_BASE_URL;
  if (env.AGENT_MODEL) s.model = env.AGENT_MODEL;
  if (env.AGENT_API_KEY) s.apiKey = env.AGENT_API_KEY;
  return s;
}

export interface ConfigBase {
  dir: string;
  /** a .claude directory: only skills and commands are read from it */
  claude: boolean;
}

/** Built-in skills and agents shipped with the agent (lowest priority). */
export const BUILTIN_DIR = join(import.meta.dirname, "..", "..");

/** Config directories from lowest to highest priority: later ones override earlier ones by name. */
export function configBases(cwd: string, claudeCompat: boolean, home = homedir(), builtins = true): ConfigBase[] {
  const bases: ConfigBase[] = builtins ? [{ dir: BUILTIN_DIR, claude: true }] : [];
  if (claudeCompat) bases.push({ dir: join(home, ".claude"), claude: true });
  bases.push({ dir: join(home, ".agent"), claude: false });
  if (claudeCompat) bases.push({ dir: join(cwd, ".claude"), claude: true });
  bases.push({ dir: join(cwd, ".agent"), claude: false });
  return bases;
}
