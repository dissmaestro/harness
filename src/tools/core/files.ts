import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool, ToolContext } from "../../types.ts";
import { numberLines, resolvePath } from "../../util.ts";
import { applyEdit } from "./edit-match.ts";

const DEFAULT_LIMIT = 2000;
const MAX_LINE = 1000;
/** ~11k tokens: a single Read must leave room in a 64k context */
const MAX_CHARS = 40_000;

function requireFreshRead(path: string, ctx: ToolContext) {
  const readAt = ctx.readFiles.get(path);
  if (readAt === undefined) throw new Error(`You must Read ${path} before modifying it.`);
  if (statSync(path).mtimeMs !== readAt) throw new Error(`${path} changed since you last read it. Read it again first.`);
}

function markRead(path: string, ctx: ToolContext) {
  ctx.readFiles.set(path, statSync(path).mtimeMs);
}

export const Read: Tool = {
  name: "Read",
  kind: "read",
  description:
    "Read a file. Returns lines prefixed with line numbers (the prefix is not part of the file). " +
    "Use offset/limit for large files. Always read a file before editing it.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file (absolute or relative to cwd)" },
      offset: { type: "integer", description: "1-based line to start from" },
      limit: { type: "integer", description: `Max lines to return (default ${DEFAULT_LIMIT})` },
    },
    required: ["file_path"],
  },
  async run(args, ctx) {
    const path = resolvePath(ctx.cwd, args.file_path);
    if (!existsSync(path)) throw new Error(`File not found: ${path}`);
    if (statSync(path).isDirectory()) throw new Error(`${path} is a directory. Use Glob or Bash ls to list it.`);
    const text = readFileSync(path, "utf8");
    if (text.includes("\0")) throw new Error(`${path} looks like a binary file.`);
    markRead(path, ctx);
    if (!text) return "(empty file)";
    const lines = text.split("\n");
    const start = Math.max(1, args.offset ?? 1);
    const limit = args.limit ?? DEFAULT_LIMIT;
    const slice: string[] = [];
    let chars = 0;
    for (let l of lines.slice(start - 1, start - 1 + limit)) {
      if (l.length > MAX_LINE) l = l.slice(0, MAX_LINE) + "…";
      chars += l.length + 8; // + line-number prefix
      if (chars > MAX_CHARS && slice.length) break;
      slice.push(l);
    }
    let out = numberLines(slice, start);
    const end = start - 1 + slice.length;
    if (slice.length < Math.min(limit, lines.length - start + 1)) {
      out += `\n[truncated at line ${end} of ${lines.length} — use offset=${end + 1} to continue]`;
    } else if (end < lines.length) out += `\n[showing lines ${start}-${end} of ${lines.length}; use offset to read more]`;
    return out;
  },
};

export const Write: Tool = {
  name: "Write",
  kind: "edit",
  description:
    "Create a new file or fully overwrite an existing one. Prefer Edit for changes to existing files. " +
    "An existing file must be Read first.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      content: { type: "string" },
    },
    required: ["file_path", "content"],
  },
  async run(args, ctx) {
    const path = resolvePath(ctx.cwd, args.file_path);
    const existed = existsSync(path);
    if (existed) requireFreshRead(path, ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, args.content);
    markRead(path, ctx);
    const lines = args.content.split("\n").length;
    return `${existed ? "Overwrote" : "Created"} ${path} (${lines} lines)`;
  },
};

export const Edit: Tool = {
  name: "Edit",
  kind: "edit",
  description:
    "Replace old_string with new_string in a file. old_string must match the file text exactly and be unique " +
    "(include surrounding lines if needed), or set replace_all. Do not include line-number prefixes from Read. " +
    "The file must be Read first.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  async run(args, ctx) {
    const path = resolvePath(ctx.cwd, args.file_path);
    if (!existsSync(path)) throw new Error(`File not found: ${path}. Use Write to create it.`);
    requireFreshRead(path, ctx);
    if (args.old_string === args.new_string) throw new Error("old_string and new_string are identical.");
    const original = readFileSync(path, "utf8");
    const crlf = original.includes("\r\n");
    const text = crlf ? original.replace(/\r\n/g, "\n") : original;
    const r = applyEdit(text, args.old_string.replace(/\r\n/g, "\n"), args.new_string.replace(/\r\n/g, "\n"), !!args.replace_all);
    writeFileSync(path, crlf ? r.content.replace(/\n/g, "\r\n") : r.content);
    markRead(path, ctx);
    const lines = r.content.split("\n");
    const from = Math.max(0, r.line - 3);
    const snippet = numberLines(lines.slice(from, r.line + args.new_string.split("\n").length + 2), from + 1);
    const how = r.fuzzy ? " (matched ignoring whitespace differences)" : "";
    return `Edited ${path}: ${r.count} replacement(s)${how}.\n${snippet}`;
  },
};
