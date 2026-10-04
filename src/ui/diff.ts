import { langFromPath, lineHighlighter } from "./highlight.ts";
import { c, colorEnabled, stripAnsi } from "./render.ts";

/** One line of a diff: " " context, "-" removed, "+" added. Line numbers are 1-based. */
export interface DiffLine {
  t: " " | "-" | "+";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** Myers gives up beyond this many edits and the changed middle is shown as replaced wholesale. */
const MAX_EDITS = 4000;

export function splitLines(s: string): string[] {
  if (!s) return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Myers O(ND) diff of two int sequences: a list of " ", "-", "+" ops, or undefined if there are too many edits. */
function myers(a: Int32Array, b: Int32Array): (" " | "-" | "+")[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    if (d > MAX_EDITS) return undefined;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) x++, y++;
      v[off + k] = x;
      if (x >= n && y >= m) found = d;
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  const ops: (" " | "-" | "+")[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const get = (k: number) => prev[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push(" "), x--, y--;
    ops.push(prevK === k + 1 ? "+" : "-");
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) ops.push(" "), x--, y--;
  return ops.reverse();
}

/** The full line-by-line edit script from a to b (common prefix/suffix trimmed before diffing). */
export function diffOps(a: string[], b: string[]): DiffLine[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ids = new Map<string, number>();
  const intern = (lines: string[]) => Int32Array.from(lines, (l) => ids.get(l) ?? (ids.set(l, ids.size), ids.size - 1));
  const ops = myers(intern(am), intern(bm)) ?? [...am.map(() => "-" as const), ...bm.map(() => "+" as const)];

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (; i < pre; i++, j++) out.push({ t: " ", text: a[i], oldNo: i + 1, newNo: j + 1 });
  for (const op of ops) {
    if (op === " ") out.push({ t: " ", text: a[i], oldNo: ++i, newNo: ++j });
    else if (op === "-") out.push({ t: "-", text: a[i], oldNo: ++i });
    else out.push({ t: "+", text: b[j], newNo: ++j });
  }
  for (; i < a.length; i++, j++) out.push({ t: " ", text: a[i], oldNo: i + 1, newNo: j + 1 });
  return out;
}

/** Hunks of changed lines with `context` lines of unchanged text around them. */
export function diffHunks(a: string, b: string, context = 3): Hunk[] {
  const ops = diffOps(splitLines(a), splitLines(b));
  const changed: number[] = [];
  ops.forEach((o, idx) => o.t !== " " && changed.push(idx));
  const hunks: Hunk[] = [];
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k] - context);
    let last = changed[k];
    while (k + 1 < changed.length && changed[k + 1] - last <= 2 * context + 1) last = changed[++k];
    k++;
    const end = Math.min(ops.length, last + context + 1);
    const lines = ops.slice(start, end);
    // Start numbers: the first line's own number, or (for a pure insertion/deletion at the edge) the line before it.
    let oldBefore = 0;
    let newBefore = 0;
    for (let p = start - 1; p >= 0 && (!oldBefore || !newBefore); p--) {
      oldBefore ||= ops[p].oldNo ?? 0;
      newBefore ||= ops[p].newNo ?? 0;
    }
    const oldLines = lines.filter((l) => l.t !== "+").length;
    const newLines = lines.filter((l) => l.t !== "-").length;
    hunks.push({
      oldStart: oldLines ? oldBefore + 1 : oldBefore,
      oldLines,
      newStart: newLines ? newBefore + 1 : newBefore,
      newLines,
      lines,
    });
  }
  return hunks;
}

export function diffStat(a: string, b: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const o of diffOps(splitLines(a), splitLines(b))) {
    if (o.t === "+") added++;
    else if (o.t === "-") removed++;
  }
  return { added, removed };
}

const BG_DEL = "\x1b[48;5;52m";
const BG_ADD = "\x1b[48;5;22m";
const BG_OFF = "\x1b[49m";

/**
 * A colored unified diff: `@@` headers, old/new line-number gutter, syntax-highlighted code on a
 * red/green background. A new file (before = null) is shown as all-added, a deleted one as all-removed.
 */
export function renderDiff(path: string, before: string | null, after: string | null, opts: { maxLines?: number; width?: number } = {}): string[] {
  const oldText = before ?? "";
  const newText = after ?? "";
  const lang = langFromPath(path, (newText || oldText).slice(0, 200).split("\n")[0]);
  const ctx = before === null || after === null ? 0 : 3;
  const hunks = before === null || after === null ? allOneSide(oldText, newText) : diffHunks(oldText, newText, ctx);
  const maxNo = Math.max(1, ...hunks.map((h) => Math.max(h.oldStart + h.oldLines, h.newStart + h.newLines)));
  const nw = String(maxNo).length;
  const color = colorEnabled();
  const width = opts.width ?? 0;
  const showOld = before !== null;
  const showNew = after !== null;

  const out: string[] = [];
  for (const h of hunks) {
    if (before !== null && after !== null) out.push(c.cyan(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`));
    const hlOld = lineHighlighter(lang);
    const hlNew = lineHighlighter(lang);
    for (const l of h.lines) {
      let code: string;
      if (l.t === "-") code = hlOld(l.text);
      else if (l.t === "+") code = hlNew(l.text);
      else {
        hlOld(l.text);
        code = hlNew(l.text);
      }
      const gutter =
        (showOld ? String(l.oldNo ?? "").padStart(nw) + " " : "") + (showNew ? String(l.newNo ?? "").padStart(nw) + " " : "");
      let body = `${l.t} ${code}`;
      if (!color) {
        out.push(gutter + body);
        continue;
      }
      if (l.t === " ") {
        out.push(c.gray(gutter) + "  " + code);
        continue;
      }
      const visible = gutter.length + stripAnsi(body).length;
      if (width > visible) body += " ".repeat(width - visible);
      const sign = l.t === "-" ? c.red("-") : c.green("+");
      // Highlighter colors close with 39/22/23 only, so the background survives across tokens.
      out.push(c.gray(gutter) + (l.t === "-" ? BG_DEL : BG_ADD) + sign + body.slice(1) + BG_OFF);
    }
  }
  const max = opts.maxLines;
  if (max !== undefined && out.length > max) {
    const rest = out.length - max;
    return [...out.slice(0, max), c.dim(`… ${rest} more line${rest === 1 ? "" : "s"}`)];
  }
  return out;
}

/** A single hunk with every line added (new file) or removed (deleted file). */
function allOneSide(oldText: string, newText: string): Hunk[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (!a.length && !b.length) return [];
  const lines: DiffLine[] = [...a.map((text, i): DiffLine => ({ t: "-", text, oldNo: i + 1 })), ...b.map((text, i): DiffLine => ({ t: "+", text, newNo: i + 1 }))];
  return [{ oldStart: a.length ? 1 : 0, oldLines: a.length, newStart: b.length ? 1 : 0, newLines: b.length, lines }];
}
