import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import type { Mode } from "../core/modes.ts";
import { oneLine } from "../util.ts";

/**
 * Colors: off with NO_COLOR, or when stdout is not a terminal (FORCE_COLOR=1/0 overrides).
 * The test runner (NODE_TEST_CONTEXT) keeps them on so rendering can be asserted.
 */
const force = process.env.FORCE_COLOR;
let color = !process.env.NO_COLOR && (force !== undefined ? force !== "0" : !!process.stdout.isTTY || !!process.env.NODE_TEST_CONTEXT);
export const colorEnabled = () => color;
export const setColor = (on: boolean) => {
  color = on;
};
const wrap = (open: number, close: number) => (s: string) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  inverse: wrap(7, 27),
};

/** Removes colors and OSC 8 hyperlinks (for measuring visible width). */
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

// ---------- clickable file paths (OSC 8) ----------

/** URL templates with {path} (absolute, URI-encoded), {line} and {col}. */
export const EDITOR_URLS: Record<string, string> = {
  vscode: "vscode://file{path}:{line}:{col}",
  cursor: "cursor://file{path}:{line}:{col}",
  codium: "vscodium://file{path}:{line}:{col}",
  zed: "zed://file{path}:{line}:{col}",
  idea: "idea://open?file={path}&line={line}&column={col}",
  file: "file://{host}{path}",
};

let linkTemplate: string | undefined;

function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, cmd)));
}

/**
 * Turns links on or off. `editor`: auto (VS Code, Cursor, VSCodium or Zed if installed, else file://),
 * one of EDITOR_URLS, or a custom template. Off when output isn't a terminal, TERM=dumb,
 * hyperlinks: false or AGENT_HYPERLINKS=0.
 */
export function configureLinks(opts: { editor?: string; hyperlinks?: boolean }, env: NodeJS.ProcessEnv = process.env, tty = !!process.stdout.isTTY) {
  linkTemplate = undefined;
  if (opts.hyperlinks === false || env.AGENT_HYPERLINKS === "0" || env.TERM === "dumb" || !color || !(tty || env.AGENT_HYPERLINKS === "1")) return;
  let editor = opts.editor || "auto";
  if (editor === "auto") {
    editor = onPath("code", env) ? "vscode" : onPath("cursor", env) ? "cursor" : onPath("codium", env) ? "codium" : onPath("zed", env) || onPath("zeditor", env) ? "zed" : "file";
  }
  linkTemplate = EDITOR_URLS[editor] ?? (editor.includes("{path}") ? editor : EDITOR_URLS.file);
}

export const linksEnabled = () => linkTemplate !== undefined;

/** `text` that opens `absPath` (at `line`) when clicked; plain text when links are off. */
export function fileLink(text: string, absPath: string, line?: number, col?: number): string {
  if (!linkTemplate) return text;
  const url = linkTemplate
    .replace("{path}", encodeURI(absPath).replace(/[?#]/g, encodeURIComponent))
    .replace("{host}", hostname())
    .replace("{line}", String(line ?? 1))
    .replace("{col}", String(col ?? 1));
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** A link to any URL (http links in the model's text). */
export function urlLink(text: string, url: string): string {
  return linkTemplate ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
}

const existsCache = new Map<string, boolean>();
function isFile(abs: string): boolean {
  let v = existsCache.get(abs);
  if (v === undefined) {
    try {
      v = statSync(abs).isFile();
    } catch {
      v = false;
    }
    if (existsCache.size > 5000) existsCache.clear();
    existsCache.set(abs, v);
  }
  return v;
}

// a path with an extension (src/ui/app.ts, ./a.py, /etc/hosts.conf), optionally :line[:col]
const PATH_IN_TEXT = /(?<![\w/.@-])((?:~|\.{1,2})?\/?(?:[\w.@-]+\/)*[\w@-][\w.@-]*\.[A-Za-z0-9]{1,10})(?::(\d+)(?::(\d+))?)?(?![\w/])/g;

/** Wraps paths of existing files in plain text (no ANSI codes in it yet) into links. */
export function linkPaths(text: string, cwd: string): string {
  if (!linkTemplate || !/[./]/.test(text)) return text;
  let checks = 0;
  return text.replace(PATH_IN_TEXT, (m, p: string, line?: string, col?: string) => {
    if (++checks > 50 || /^\d+(\.\d+)+$/.test(p)) return m; // 1.2.3 is a version, not a file
    const abs = p.startsWith("~/") ? join(process.env.HOME ?? "", p.slice(2)) : resolve(cwd, p);
    return isFile(abs) ? fileLink(m, abs, line ? Number(line) : undefined, col ? Number(col) : undefined) : m;
  });
}

export const MODE_STYLE: Record<Mode, (s: string) => string> = {
  ask: c.green,
  acceptEdits: c.yellow,
  plan: c.cyan,
  auto: c.magenta,
  yolo: c.red,
};

export function shortPath(p: string, cwd: string): string {
  if (!isAbsolute(p)) return p;
  const rel = relative(cwd, p);
  return rel && !rel.startsWith("..") ? rel : p;
}

const PRIMARY_ARGS = ["file_path", "command", "pattern", "query", "url", "skill", "path", "subagent_type"];

export function argSummary(name: string, args: Record<string, unknown>, cwd: string): string {
  if (name === "Agent") return oneLine(`${args.subagent_type}${args.description ? `: ${args.description}` : ""}`, 80);
  if (name === "TodoWrite") return `${(args.todos as unknown[] | undefined)?.length ?? 0} items`;
  if (name === "ExitPlanMode") return "";
  const key = PRIMARY_ARGS.find((k) => typeof args[k] === "string");
  if (!key) return oneLine(JSON.stringify(args), 80);
  const v = String(args[key]);
  return oneLine(key === "file_path" || key === "path" ? shortPath(v, cwd) : v, 80);
}

export function resultSummary(result: string, maxLines = 1): string {
  const lines = result.trim().split("\n");
  const shown = lines.slice(0, maxLines).map((l) => oneLine(l, 110));
  const more = lines.length > maxLines ? c.dim(` (+${lines.length - maxLines} lines)`) : "";
  return shown.join("\n") + more;
}

/** Changed lines only (common leading/trailing lines trimmed), with one line of context around them. */
export function diffLines(oldStr: string, newStr: string, max = 12): string[] {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const side = (lines: string[], sign: string, paint: (x: string) => string) => {
    const out = lines.slice(0, max).map((l) => paint(`${sign} ${l}`));
    if (lines.length > max) out.push(c.dim(`  … ${lines.length - max} more`));
    return out;
  };
  const before = pre > 0 ? [c.dim(`  ${a[pre - 1]}`)] : [];
  const after = suf > 0 ? [c.dim(`  ${a[a.length - suf]}`)] : [];
  return [...before, ...side(a.slice(pre, a.length - suf), "-", c.red), ...side(b.slice(pre, b.length - suf), "+", c.green), ...after];
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** "ctx 3.2k/66k (5%)" */
export function contextLabel(used: number, win: number): string {
  return `ctx ${formatTokens(used)}/${formatTokens(win)} (${Math.round((used / win) * 100)}%)`;
}

/** A rounded box around lines (ANSI-aware width). */
export function box(lines: string[], title = "", paint: (s: string) => string = c.gray): string {
  const width = Math.max(stripAnsi(title).length + 4, ...lines.map((l) => stripAnsi(l).length)) + 2;
  const top = paint("╭─" + (title ? ` ${title} ` : "") + "─".repeat(Math.max(0, width - stripAnsi(title).length - (title ? 3 : 1))) + "╮");
  const body = lines.map((l) => paint("│ ") + l + " ".repeat(Math.max(0, width - 1 - stripAnsi(l).length)) + paint("│"));
  const bottom = paint("╰" + "─".repeat(width) + "╯");
  return [top, ...body, bottom].join("\n");
}
