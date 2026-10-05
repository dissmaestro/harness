import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

// No wrappers that run another command (env, xargs, nohup, timeout, nice…): they would bypass the list.
const READONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "rg", "grep", "egrep", "fgrep", "find", "fd", "tree", "pwd", "echo", "printf",
  "file", "stat", "du", "df", "which", "whereis", "type", "printenv", "uname", "date", "whoami", "id",
  "sort", "uniq", "cut", "tr", "diff", "cmp", "md5sum", "sha256sum", "basename", "dirname", "realpath",
  "readlink", "less", "jq", "true", "test", "[",
]);
const READONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "blame", "ls-files", "rev-parse", "remote", "describe", "shortlog", "tag", "grep"]);

/** Flags that make an otherwise read-only command write files or run other programs. */
const FORBIDDEN_FLAGS: Record<string, RegExp> = {
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  fd: /^(-x|-X|--exec|--exec-batch)(=|$)/,
  rg: /^--pre(=|$)/,
  sort: /^(-[^-]*o|--output|--compress-program)/,
  tree: /^(-o|--output)/,
  date: /^(-s|--set)/,
  file: /^-[^-]*C/,
};

/** Variables a read-only command may be prefixed with; others (GIT_*, PAGER, LD_PRELOAD…) can run code. */
const SAFE_ENV = /^(LC_\w+|LANG|LANGUAGE|TZ|NO_COLOR|COLUMNS|TERM)=/;

/**
 * Splits a command line into simple commands (on ; & | && || and newlines) made of words, honouring
 * quotes. Returns null for anything that can run or write something unseen: command and process
 * substitution, heredocs, output redirection to anything but /dev/null.
 */
function splitCommands(command: string): string[][] | null {
  const cmds: string[][] = [[]];
  let word = "";
  let inWord = false;
  let quote = "";
  let redirect: "" | "in" | "out" = "";
  const endWord = (): boolean => {
    if (!inWord) return true;
    const w = word;
    word = "";
    inWord = false;
    if (redirect) {
      const r = redirect;
      redirect = "";
      return r === "in" || w === "/dev/null";
    }
    cmds[cmds.length - 1].push(w);
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (c === "'") quote = "";
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "`" || (c === "$" && next === "(")) return null;
      else if (c === "\\" && next !== undefined) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "`" || (c === "$" && next === "(")) return null;
    if (c === "\\") {
      if (next !== undefined && next !== "\n") word += next;
      i++;
      inWord = true;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === " " || c === "\t") {
      if (!endWord()) return null;
    } else if (c === "<" || c === ">" || (c === "&" && next === ">")) {
      if (next === "(") return null; // process substitution <(…) >(…)
      if (inWord && /^\d+$/.test(word)) {
        word = ""; // file descriptor: 2>…
        inWord = false;
      } else if (!endWord()) return null;
      if (redirect) return null;
      let op = c;
      while (op.length < 3 && /[<>&|]/.test(command[i + 1] ?? "")) op += command[++i];
      if (/^[<>]&$/.test(op)) {
        while (/[\d-]/.test(command[i + 1] ?? "")) i++; // fd duplication: 2>&1, >&2, 1>&-
        continue;
      }
      if (op.startsWith("<<") && op !== "<<<") return null; // heredoc bodies aren't parsed
      redirect = op.includes(">") ? "out" : "in";
    } else if (c === "\n" || c === ";" || c === "&" || c === "|") {
      if (!endWord() || redirect) return null;
      if (cmds[cmds.length - 1].length) cmds.push([]);
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote || !endWord() || redirect) return null;
  return cmds.filter((w) => w.length);
}

/** git branch/tag only list when given no names, or names together with a listing flag. */
function gitListsOnly(sub: string, args: string[]): boolean {
  const mutating =
    sub === "branch"
      ? /^(-[a-zA-Z]*[dDmMcCfut]|--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|track|no-track|create-reflog)(=|$))/
      : /^(-[a-zA-Z]*[dasufmFe]|--(delete|annotate|sign|local-user|force|message|file|edit|create-reflog)(=|$))/;
  if (args.some((a) => mutating.test(a))) return false;
  const listing = args.some((a) => /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)(=|$)/.test(a));
  return listing || args.every((a) => a.startsWith("-"));
}

function isReadOnlyGit(words: string[]): boolean {
  let i = 1;
  while (i < words.length) {
    if (words[i] === "--no-pager") i++;
    else if (words[i] === "-C") i += 2;
    else break;
  }
  const sub = words[i] ?? "";
  const args = words.slice(i + 1);
  if (!READONLY_GIT.has(sub)) return false;
  if (args.some((a) => /^--(output|ext-diff|open-files-in-pager)(=|$)|^-O/.test(a))) return false;
  if (sub === "branch" || sub === "tag") return gitListsOnly(sub, args);
  if (sub === "remote") {
    const action = args.find((a) => !a.startsWith("-"));
    return action === undefined || action === "show" || action === "get-url";
  }
  return true;
}

/** True when every part of a shell command only reads (used in plan mode and read-only subagents). */
export function isReadOnlyCommand(command: string): boolean {
  const cmds = splitCommands(command);
  if (!cmds) return false;
  for (let words of cmds) {
    while (words.length && /^\w+=/.test(words[0])) {
      if (!SAFE_ENV.test(words[0])) return false;
      words = words.slice(1);
    }
    if (!words.length) continue;
    const [cmd, ...args] = words;
    if (cmd === "git") {
      if (!isReadOnlyGit(words)) return false;
      continue;
    }
    if (cmd === "env" && !args.length) continue; // bare env lists variables; with arguments it runs a command
    if (!READONLY_COMMANDS.has(cmd)) return false;
    const forbidden = FORBIDDEN_FLAGS[cmd];
    if (forbidden && args.some((a) => forbidden.test(a))) return false;
    if (cmd === "uniq" && args.filter((a) => !a.startsWith("-")).length > 1) return false; // uniq IN OUT writes OUT
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

/** The path with symlinks resolved; for a file that doesn't exist yet, its nearest existing parent is resolved. */
function realPath(p: string): string {
  let tail = "";
  for (let dir = p; ; dir = dirname(dir)) {
    try {
      return join(realpathSync(dir), tail);
    } catch {
      if (dirname(dir) === dir) return p;
      tail = join(dir.slice(dirname(dir).length + 1), tail);
    }
  }
}

function within(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function insideProject(cwd: string, path: unknown): boolean {
  if (typeof path !== "string") return true;
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  // the project may be opened through a symlink (~/proj → /data/proj) while the model writes the other spelling
  return within(cwd, abs) || within(realPath(cwd), realPath(abs));
}

/** Directories whose files configure git, the agent, editors or hooks: they can run code later. */
const PROTECTED_DIRS = new Set([".git", ".agent", ".claude", ".vscode", ".husky"]);

/** True for paths inside the project that change agent/git/hook configuration (.git/, .agent/, .envrc…). */
export function isProtectedPath(cwd: string, path: unknown): boolean {
  if (typeof path !== "string") return false;
  const parts = relative(cwd, isAbsolute(path) ? path : resolve(cwd, path)).split(/[\\/]/);
  return parts.some((p, i) => PROTECTED_DIRS.has(p) && i < parts.length - 1) || parts[parts.length - 1] === ".envrc";
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
    if (!inside) return { action: "ask", reason: "edit outside the project" };
    if (isProtectedPath(cwd, args.file_path)) return { action: "ask", reason: "edits agent/git configuration" };
    if (mode === "acceptEdits" || mode === "auto") return { action: "allow" };
    return { action: "ask" };
  }
  if (mode === "auto") {
    if (command && isDangerousCommand(command)) return { action: "ask", reason: "potentially dangerous command" };
    return { action: "allow" };
  }
  if (command && isReadOnlyCommand(command)) return { action: "allow" };
  return { action: "ask" };
}
