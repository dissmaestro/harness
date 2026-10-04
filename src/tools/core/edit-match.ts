import { numberLines } from "../../util.ts";

export interface EditResult {
  content: string;
  count: number;
  /** 0-based line where the (first) replacement starts */
  line: number;
  fuzzy: boolean;
}

const leadingWs = (s: string) => s.match(/^\s*/)![0];

function trimBlankEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

function levenshtein(a: string, b: string): number {
  a = a.slice(0, 200);
  b = b.slice(0, 200);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function closestHint(fileLines: string[], oldLines: string[]): string {
  const target = oldLines.find((l) => l.trim())?.trim();
  if (!target) return "";
  let best = -1;
  let bestScore = 0;
  fileLines.forEach((l, i) => {
    const t = l.trim();
    if (!t) return;
    const score = 1 - levenshtein(t, target) / Math.max(t.length, target.length);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (best < 0 || bestScore < 0.5) return "";
  const snippet = numberLines(fileLines.slice(best, best + oldLines.length + 1), best + 1);
  return `\nClosest match starts at line ${best + 1}:\n${snippet}\nRe-read the file and copy old_string exactly.`;
}

/**
 * Exact replacement first. If nothing matches, retry line-by-line ignoring indentation and
 * trailing whitespace (the most common local-model mistake), re-indenting new_string to fit.
 */
export function applyEdit(content: string, oldStr: string, newStr: string, replaceAll: boolean): EditResult {
  if (!oldStr) throw new Error("old_string is empty. Use Write to create or overwrite a file.");
  const count = content.split(oldStr).length - 1;
  if (count > 1 && !replaceAll) {
    throw new Error(`old_string matches ${count} places. Include more surrounding lines to make it unique, or set replace_all.`);
  }
  if (count >= 1) {
    const line = content.slice(0, content.indexOf(oldStr)).split("\n").length - 1;
    const next = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr);
    return { content: next, count, line, fuzzy: false };
  }

  const fileLines = content.split("\n");
  const oldLines = trimBlankEdges(oldStr.split("\n"));
  if (!oldLines.length) throw new Error("old_string contains only whitespace.");
  const found: number[] = [];
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    if (oldLines.every((l, j) => fileLines[i + j].trim() === l.trim())) found.push(i);
  }
  if (found.length > 1 && !replaceAll) {
    throw new Error(`old_string matches ${found.length} places (ignoring whitespace). Include more surrounding lines.`);
  }
  if (!found.length) throw new Error(`old_string not found in file.${closestHint(fileLines, oldLines)}`);

  const newLinesRaw = newStr === "" ? [] : trimBlankEdges(newStr.split("\n"));
  for (const i of [...found].reverse()) {
    const fileIndent = leadingWs(fileLines[i]);
    const oldIndent = leadingWs(oldLines[0]);
    const newLines = newLinesRaw.map((l) => (l.startsWith(oldIndent) ? fileIndent + l.slice(oldIndent.length) : l));
    fileLines.splice(i, oldLines.length, ...newLines);
  }
  return { content: fileLines.join("\n"), count: found.length, line: found[0], fuzzy: true };
}
