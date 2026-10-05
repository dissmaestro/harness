import { isAbsolute, relative } from "node:path";
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

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

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
