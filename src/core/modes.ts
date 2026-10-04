import { isAbsolute, relative, resolve } from "node:path";
import type { Tool } from "../types.ts";

/**
 * ask         — read freely, ask before edits and commands
 * acceptEdits — edits inside the project without asking, commands still ask
 * plan        — read-only research, ends with ExitPlanMode for the user to approve
 * auto        — everything runs, except dangerous commands and edits outside the project
 * yolo        — nothing is ever asked
 */
export type Mode = "ask" | "acceptEdits" | "plan" | "auto" | "yolo";

/** Shift+Tab cycles through these; yolo is only reachable explicitly. */
export const MODE_CYCLE: Mode[] = ["ask", "acceptEdits", "plan", "auto"];

export const MODES: Record<Mode, { label: string; description: string }> = {
  ask: { label: "ask", description: "asks before edits and commands" },
  acceptEdits: { label: "accept edits", description: "edits without asking, commands ask" },
  plan: { label: "plan", description: "read-only, proposes a plan for approval" },
  auto: { label: "auto", description: "runs everything except dangerous actions" },
  yolo: { label: "yolo", description: "never asks" },
};

export function parseMode(s: string | undefined): Mode | undefined {
  if (!s) return undefined;
  const k = s.trim().toLowerCase().replace(/[-_\s]/g, "");
  const map: Record<string, Mode> = {
    ask: "ask", default: "ask", acceptedits: "acceptEdits", edits: "acceptEdits",
    plan: "plan", auto: "auto", yolo: "yolo", bypass: "yolo",
  };
  return map[k];
}

export function nextMode(m: Mode): Mode {
  const i = MODE_CYCLE.indexOf(m);
  return MODE_CYCLE[(i + 1) % MODE_CYCLE.length];
}

const READONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "rg", "grep", "egrep", "find", "fd", "tree", "pwd", "echo", "printf",
  "file", "stat", "du", "df", "which", "whereis", "type", "env", "printenv", "uname", "date", "whoami", "id",
  "sort", "uniq", "cut", "tr", "diff", "cmp", "md5sum", "sha256sum", "basename", "dirname", "realpath",
  "readlink", "less", "jq", "true", "test", "[",
]);
const READONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "blame", "ls-files", "rev-parse", "remote", "describe", "shortlog", "tag", "grep"]);

/** True when every part of a shell command only reads (used in plan mode and read-only subagents). */
export function isReadOnlyCommand(command: string): boolean {
  command = command.replace(/\d?>\s*\/dev\/null/g, "");
  if (/(^|[^>&])>(?!&)|>>|\btee\b|`|\$\(/.test(command)) return false; // redirection to files, substitutions
  if (/\bsed\b[^|;&]*\s-i|\bfind\b[^|;&]*\s-(delete|exec)/.test(command)) return false;
  for (const part of command.split(/&&|\|\||;|\||\n/)) {
    const words = part.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w)); // skip VAR=value prefixes
    if (!words.length) continue;
    const [cmd, sub] = words;
    if (cmd === "git") {
      if (!READONLY_GIT.has(sub ?? "")) return false;
      continue;
    }
    if (!READONLY_COMMANDS.has(cmd)) return false;
  }
  return true;
}

const DANGEROUS: RegExp[] = [
  /\bsudo\b|\bsu\s|\bdoas\b/,
  /\brm\s+(-\w*[rf]\w*\s+)+(\/|~|\$HOME|\*|\.\.?)(\s|$)/, // rm -rf / ~ * . ..
  /\bgit\s+push\b[^;&|]*(--force|-f\b|--mirror|--delete)/,
  /\bgit\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|filter-branch)/,
  /\b(mkfs|fdisk|parted|wipefs|dd\s+.*of=\/dev)/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  /\bchmod\s+(-R\s+)?777\b|\bchown\s+-R\b/,
  /(curl|wget)[^|]*\|\s*(ba|z)?sh\b/,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b/,
  /\bdocker\s+(system\s+prune|rm\s+-f|rmi)/,
  /\bkubectl\s+delete\b|\bterraform\s+(apply|destroy)\b/,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command));
}

function insideProject(cwd: string, path: unknown): boolean {
  if (typeof path !== "string") return true;
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(cwd, abs);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export type Decision = { action: "allow" } | { action: "ask"; reason?: string } | { action: "deny"; reason: string };

/** Pure permission policy. The agent adds per-session "always allow" answers on top. */
export function decide(mode: Mode, tool: Tool, args: Record<string, unknown>, cwd: string): Decision {
  if (tool.kind === "read") return { action: "allow" };
  if (mode === "plan") {
    if (tool.name === "Bash" && isReadOnlyCommand(String(args.command ?? ""))) return { action: "allow" };
    return {
      action: "deny",
      reason:
        `${tool.name} is not allowed in plan mode: only read-only tools work. ` +
        "Finish researching, then present your plan with ExitPlanMode.",
    };
  }
  if (mode === "yolo") return { action: "allow" };
  const command = tool.name === "Bash" ? String(args.command ?? "") : "";
  if (tool.kind === "edit") {
    const inside = insideProject(cwd, args.file_path);
    if ((mode === "acceptEdits" || mode === "auto") && inside) return { action: "allow" };
    return { action: "ask", reason: inside ? undefined : "edit outside the project" };
  }
  if (mode === "auto") {
    if (command && isDangerousCommand(command)) return { action: "ask", reason: "potentially dangerous command" };
    return { action: "allow" };
  }
  if (command && isReadOnlyCommand(command)) return { action: "allow" };
  return { action: "ask" };
}
