import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** One row of the completion menu. */
export interface Item {
  /** what the menu shows on the left */
  label: string;
  /** dim text on the right */
  hint?: string;
  /** replaces line[start..end) when accepted */
  insert: string;
  /** a directory: accepting it keeps the menu open for the next level */
  dir?: boolean;
}

export interface Completion {
  kind: "command" | "path";
  items: Item[];
  start: number;
  end: number;
}

export interface CommandInfo {
  name: string;
  /** e.g. "[path]" */
  args?: string;
  description: string;
}

/** Keyboard shortcuts, shown by `?`, /keys and /help. */
export const SHORTCUTS: [string, string][] = [
  ["enter", "send the message"],
  ["\\ enter", "new line (end the line with \\)"],
  ["shift+tab", "switch mode: ask → accept edits → plan → auto"],
  ["/", "commands, skills and custom commands"],
  ["@", "attach a file or folder: @src/app.ts"],
  ["tab", "complete the selected item"],
  ["↑ ↓", "move in the menu, otherwise input history"],
  ["esc", "close the menu"],
  ["ctrl+c", "interrupt the answer · clear the line · twice: quit"],
  ["ctrl+d", "quit"],
  ["ctrl+l", "clear the screen"],
  ["ctrl+a ctrl+e", "start / end of the line"],
  ["ctrl+w", "delete the previous word"],
  ["ctrl+u ctrl+k", "delete to the start / end of the line"],
  ["alt+← alt+→", "move by word"],
];

const MAX_ITEMS = 50;

/** What to suggest for the input `line` with the cursor at `cursor`, or undefined for no menu. */
export function complete(line: string, cursor: number, commands: CommandInfo[], cwd: string, files?: () => string[]): Completion | undefined {
  const m = /^\/(\S*)$/.exec(line.slice(0, cursor));
  if (m && !/\s/.test(line)) {
    const q = m[1].toLowerCase();
    const ranked = commands
      .map((x) => ({ x, n: x.name.toLowerCase() }))
      .filter(({ n }) => n.includes(q))
      .sort((a, b) => Number(!a.n.startsWith(q)) - Number(!b.n.startsWith(q)));
    if (!ranked.length) return undefined;
    return {
      kind: "command",
      start: 0,
      end: line.length,
      items: ranked.slice(0, MAX_ITEMS).map(({ x }) => ({ label: "/" + x.name + (x.args ? " " + x.args : ""), hint: x.description, insert: "/" + x.name })),
    };
  }
  // /view, /diff, /revert take a path: complete it like @ but without the @
  const arg = /^\/(view|diff|revert)\s+(\S*)$/.exec(line.slice(0, cursor));
  if (arg && commands.some((x) => x.name === arg[1])) {
    const items = pathItems(arg[2], cwd, files).map((i) => ({ ...i, insert: i.label }));
    if (!items.length) return undefined;
    const tail = /^\S*/.exec(line.slice(cursor))![0];
    return { kind: "path", start: cursor - arg[2].length, end: cursor + tail.length, items };
  }
  const at = /(?:^|\s)@(\S*)$/.exec(line.slice(0, cursor));
  if (at) {
    const items = pathItems(at[1], cwd, files);
    if (!items.length) return undefined;
    const tail = /^\S*/.exec(line.slice(cursor))![0];
    return { kind: "path", start: cursor - at[1].length - 1, end: cursor + tail.length, items };
  }
  return undefined;
}

const SKIP_DIRS = new Set([".git", "node_modules"]);

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

/** "@src/ap" → entries of src/ starting with "ap"; without a slash also fuzzy matches anywhere in the project. */
export function pathItems(partial: string, cwd: string, files?: () => string[]): Item[] {
  const slash = partial.lastIndexOf("/");
  const dirPart = slash >= 0 ? partial.slice(0, slash + 1) : "";
  const base = partial.slice(slash + 1).toLowerCase();
  const items: Item[] = [];
  const seen = new Set<string>();
  const add = (insert: string, dir: boolean, hint?: string) => {
    if (seen.has(insert)) return;
    seen.add(insert);
    items.push({ label: insert, insert: "@" + insert, dir, hint });
  };

  const abs = resolve(cwd, expandHome(dirPart) || ".");
  let entries: { name: string; dir: boolean }[] = [];
  try {
    entries = readdirSync(abs, { withFileTypes: true }).map((e) => {
      let dir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          dir = statSync(join(abs, e.name)).isDirectory();
        } catch {
          // broken link: a file
        }
      }
      return { name: e.name, dir };
    });
  } catch {
    // not a directory (yet)
  }
  entries = entries
    .filter((e) => e.name.toLowerCase().startsWith(base) && (base.startsWith(".") || !e.name.startsWith(".")) && !(e.dir && SKIP_DIRS.has(e.name)))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  for (const e of entries) add(dirPart + e.name + (e.dir ? "/" : ""), e.dir);

  // search the whole project when the user hasn't picked a directory yet
  if (!dirPart && base && files) {
    const scored: [number, string][] = [];
    for (const f of files()) {
      const score = matchScore(f.toLowerCase(), base);
      if (score >= 0) scored.push([score, f]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]));
    for (const [, f] of scored.slice(0, MAX_ITEMS)) add(f, false);
  }
  return items.slice(0, MAX_ITEMS);
}

/** Lower is better: file name starts with q, file name contains q, path contains q, letters in order; -1 = no match. */
export function matchScore(path: string, q: string): number {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  if (path.includes(q)) return 2;
  let i = 0;
  for (const ch of name) if (ch === q[i] && ++i === q.length) return 3;
  return -1;
}

/** Project files for fuzzy @-search (respects .gitignore), cached for a few seconds. */
export function projectFiles(cwd: string): () => string[] {
  let cache: string[] = [];
  let at = 0;
  return () => {
    if (Date.now() - at < 5000) return cache;
    at = Date.now();
    try {
      const out = execFileSync("rg", ["--files", "--hidden", "-g", "!.git", "--sort", "path"], { cwd, encoding: "utf8", maxBuffer: 32 << 20, timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      cache = out.split("\n").filter(Boolean).slice(0, 50_000);
    } catch (e) {
      // rg exits 1 when nothing matched; a partial list is still useful
      cache = String((e as { stdout?: string }).stdout ?? "").split("\n").filter(Boolean);
    }
    return cache;
  };
}

const ATTACH_LIMIT = 40_000;

export interface Attachment {
  path: string;
  /** "120 lines", "folder, 14 entries" */
  summary: string;
}

/**
 * @mentions of existing files and folders → their contents appended to the message, so the model
 * doesn't spend a step reading them. Other @words (emails, decorators) are left alone.
 */
export function expandMentions(input: string, cwd: string): { text: string; attached: Attachment[] } {
  const blocks: string[] = [];
  const attached: Attachment[] = [];
  const seen = new Set<string>();
  for (const m of input.matchAll(/(?:^|\s)@(\S+)/g)) {
    const rel = m[1].replace(/[,.;:!?)]+$/, "");
    const abs = isAbsolute(expandHome(rel)) ? expandHome(rel) : resolve(cwd, rel);
    if (seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);
    try {
      if (statSync(abs).isDirectory()) {
        const names = readdirSync(abs, { withFileTypes: true })
          .filter((e) => !SKIP_DIRS.has(e.name))
          .map((e) => e.name + (e.isDirectory() ? "/" : ""))
          .sort();
        blocks.push(`<folder path="${rel}">\n${names.slice(0, 500).join("\n")}${names.length > 500 ? `\n… ${names.length - 500} more` : ""}\n</folder>`);
        attached.push({ path: rel, summary: `folder, ${names.length} entries` });
        continue;
      }
      const buf = readFileSync(abs);
      if (buf.subarray(0, 8000).includes(0)) {
        attached.push({ path: rel, summary: "binary, not attached" });
        continue;
      }
      let text = buf.toString("utf8");
      const lines = text.split("\n").length;
      let note = "";
      if (text.length > ATTACH_LIMIT) {
        text = text.slice(0, ATTACH_LIMIT);
        const shown = text.split("\n").length - 1;
        text = text.split("\n").slice(0, shown).join("\n");
        note = `\n[truncated at line ${shown} of ${lines} — use Read with offset=${shown + 1} to continue]`;
      }
      blocks.push(`<file path="${rel}">\n${text}${note}\n</file>`);
      attached.push({ path: rel, summary: `${lines} lines${note ? ", truncated" : ""}` });
    } catch {
      // unreadable: leave the mention as plain text
    }
  }
  if (!blocks.length) return { text: input, attached };
  return { text: `${input}\n\nAttached by the user with @:\n${blocks.join("\n")}`, attached };
}
