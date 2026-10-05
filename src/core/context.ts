import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDef } from "../registry/registry.ts";
import type { Settings } from "./settings.ts";

const BASE_PROMPT = `You are a coding agent running in the user's terminal. You help with software engineering tasks by using tools.

# Working rules
- Read files before editing them. Prefer Edit for changes; use Write only for new files or full rewrites.
- Use Grep and Glob to find code instead of guessing paths.
- Verify your work: run the project's tests, linters or build with Bash when they exist.
- Keep answers short. Don't repeat file contents back to the user.
- If a tool returns an error, read it carefully, fix the call and retry.
- For tasks with 3+ steps, keep a checklist with TodoWrite and update it as you go.
- Web access: WebSearch and WebFetch are deferred tools (load them with ToolSearch). Use them for documentation, error messages and anything that may be newer than your knowledge.

# Skills and deferred tools
- Skills are listed in <system-reminder> blocks as "name: description". When the task matches a skill, call the Skill tool with its name BEFORE doing the work yourself, then follow the instructions it returns.
- Deferred tools are listed in <system-reminder> blocks by name only. Load a schema once with ToolSearch ("select:<name>" when you know the name, keywords to discover), then call the tool with UseTool: {"name": "<tool>", "arguments": {...}}.
- When you need a capability you don't see (database, deploy, issue tracker, browser…), try ToolSearch with keywords before saying it isn't possible.
- <system-reminder> blocks are added by the harness, not typed by the user.`;

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

/**
 * Built once per session and never changed, so the server can reuse its KV cache for this prefix.
 * Dynamic info (skill list, deferred tools) goes into <system-reminder> blocks in user messages.
 */
export function buildSystemPrompt(cwd: string, settings: Settings, home = homedir(), subagent?: AgentDef): string {
  const env = [
    "# Environment",
    `- Working directory: ${cwd}`,
    `- Platform: ${process.platform}`,
    `- Git repository: ${existsSync(join(cwd, ".git")) ? "yes" : "no"}`,
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n");

  const instructions: string[] = [];
  const candidates: Array<[string, string]> = [
    [join(home, ".agent", "AGENTS.md"), "user instructions (~/.agent/AGENTS.md)"],
    [join(cwd, "AGENTS.md"), "project instructions (AGENTS.md)"],
  ];
  if (settings.claudeCompat) {
    candidates.unshift([join(home, ".claude", "CLAUDE.md"), "user instructions (~/.claude/CLAUDE.md)"]);
    candidates.push([join(cwd, "CLAUDE.md"), "project instructions (CLAUDE.md)"]);
  }
  for (const [path, label] of candidates) {
    const text = readIfExists(path);
    if (text) instructions.push(`# ${label}\n${text}`);
  }

  if (subagent) {
    const role =
      `You are a "${subagent.name}" subagent started by a coding agent for one self-contained task. ` +
      "You cannot ask the user questions. Work autonomously with your tools, then reply with a concise final report: " +
      "the caller sees ONLY your last message, so include every finding it needs (file paths, line numbers, facts, URLs)." +
      (subagent.readOnly ? " You are read-only: do not try to modify files." : "");
    return [role, subagent.prompt, BASE_PROMPT.split("# Skills and deferred tools")[0].replace(/^You are[^\n]*\n\n/, ""), env, ...instructions]
      .filter(Boolean)
      .join("\n\n");
  }
  return [BASE_PROMPT, settings.subagents?.delegate === "normal" ? DELEGATION_NORMAL : DELEGATION_PREFER, env, ...instructions].join("\n\n");
}

const DELEGATION_NORMAL = `# Subagents
- Use the Agent tool for broad exploration or web research that would otherwise fill your context with file contents; give the subagent a complete, self-contained prompt.
- Several Agent calls in one reply run in parallel.`;

const DELEGATION_PREFER = `# Delegation: you are the coordinator
Your context is small and must last the whole session. Hand work to subagents with the Agent tool and keep for yourself only planning, decisions and precise edits.
- Searching the codebase, reading more than 2-3 files, tracing a flow, reviewing a diff: delegate to "explore".
- Questions about libraries, APIs, errors, documentation: delegate to "web-researcher".
- Independent subtasks (fix module A, write tests for B, update docs): delegate each to "general-purpose".
- Put independent Agent calls in ONE reply: they run in parallel. Writing subagents that run in parallel each get their own copy of the project (git worktree) and their changes are merged back afterwards, so give them tasks that touch different files.
- Every subagent prompt must be self-contained: the goal, relevant paths and facts you already know, constraints, and exactly what to report back. The subagent sees none of this conversation.
- Trust the reports: don't re-read the files a subagent already summarized; read a file yourself only right before editing it.
- Do it yourself when it is a small, local change (one file you already know) or when the subagent would need most of your context.`;

export function reminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

export const PLAN_MODE_ON = `Plan mode is active. The user wants a plan before any changes are made.
- Do NOT edit files or run commands that change anything. Only read-only tools work: Read, Grep, Glob, read-only Bash (ls, git log/diff/status, cat…), web tools, read-only subagents.
- Research the code, ask the user if requirements are unclear, then call ExitPlanMode with a concrete Markdown plan: goal, files to change, step-by-step changes, how to verify.
- Do not start implementing until the plan is approved.`;

export const PLAN_MODE_OFF = (mode: string) =>
  `Plan mode is off (mode: ${mode}). You may now edit files and run commands, subject to the user's permissions.`;

export const COMPACT_REQUEST = (focus?: string) => `The conversation is about to be compacted to free context. Write a summary that lets you continue the work in a fresh context without the history. Include:
1. The user's requests and goals (quote short ones verbatim).
2. Key decisions and constraints.
3. Files read or changed: paths and what changed.
4. Commands run and important results; errors and how they were fixed.
5. Current state and the exact next steps.
Be specific (paths, names, numbers). Use concise Markdown. Do not call any tools.${focus ? `\nPay special attention to: ${focus}` : ""}`;
