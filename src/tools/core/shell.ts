import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Tool } from "../../types.ts";
import { resolvePath, runProcess, truncateMiddle } from "../../util.ts";

const BASH_MAX_OUTPUT = 16_000;
/** Grep content mode budget (a 64k context fills fast) */
const GREP_MAX_CHARS = 20_000;
const GREP_MAX_COLUMNS = 300;
const MAX_PATHS = 200;
/** search hidden files too (.github, .env.example…), but never inside .git */
const RG_HIDDEN = ["--hidden", "--glob", "!.git"];

/** Saves long command output so the model can page through it instead of losing the middle. */
function saveFullOutput(out: string): string | undefined {
  try {
    const dir = join(tmpdir(), "agent-output");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.log`);
    writeFileSync(file, out);
    return file;
  } catch {
    return undefined;
  }
}

export const Bash: Tool = {
  name: "Bash",
  kind: "exec",
  description:
    "Run a bash command in the project directory and return stdout/stderr. Use for git, builds, tests, " +
    "package managers. Prefer Read/Grep/Glob for reading and searching files. Each call is a fresh shell.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "integer", description: "Timeout in ms (default 120000, max 600000)" },
    },
    required: ["command"],
  },
  async run(args, ctx) {
    const timeoutMs = Math.min(args.timeout ?? 120_000, 600_000);
    const r = await runProcess("bash", ["-c", args.command], { cwd: ctx.cwd, signal: ctx.signal, timeoutMs });
    const parts = [r.stdout.trimEnd()];
    if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
    if (r.timedOut) parts.push(`[timed out after ${timeoutMs} ms]`);
    else if (r.code !== 0) parts.push(`[exit code ${r.code}]`);
    const out = parts.filter(Boolean).join("\n") || "(no output)";
    if (out.length <= BASH_MAX_OUTPUT) return out;
    const saved = saveFullOutput(out);
    const note = saved ? `\n[full output (${out.length} chars) saved to ${saved}; use Read with offset or Grep on it]` : "";
    return truncateMiddle(out, BASH_MAX_OUTPUT) + note;
  },
};

export const Grep: Tool = {
  name: "Grep",
  kind: "read",
  description:
    "Search file contents with ripgrep (regex). Respects .gitignore, includes hidden files, skips .git. " +
    'output_mode: "files_with_matches" (default), "content" (matching lines with numbers), "count".',
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      path: { type: "string", description: "File or directory (default: cwd)" },
      glob: { type: "string", description: 'Filter files, e.g. "*.ts" or "src/**/*.py"' },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
      case_insensitive: { type: "boolean" },
      head_limit: { type: "integer", description: "Max output lines (default 200)" },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    const mode = args.output_mode ?? "files_with_matches";
    const rg = ["--color=never", "--no-heading", `--max-columns=${GREP_MAX_COLUMNS}`, "--max-columns-preview"];
    rg.push(mode === "files_with_matches" ? "-l" : mode === "count" ? "-c" : "-n");
    if (args.case_insensitive) rg.push("-i");
    if (args.glob) rg.push("--glob", args.glob);
    rg.push(...RG_HIDDEN); // after the user's glob: later globs win, so .git stays excluded
    rg.push("-e", args.pattern);
    if (args.path) rg.push("--", resolvePath(ctx.cwd, args.path));
    const r = await runProcess("rg", rg, { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: 60_000 });
    if (r.code === 1) return "No matches found.";
    if (r.code !== 0) throw new Error(r.stderr.trim() || `ripgrep failed with exit code ${r.code}`);
    const lines = r.stdout.trimEnd().split("\n");
    const limit = mode === "content" ? (args.head_limit ?? 200) : Math.min(args.head_limit ?? MAX_PATHS, MAX_PATHS);
    const out: string[] = [];
    let chars = 0;
    for (const line of lines.slice(0, limit)) {
      if (chars + line.length + 1 > GREP_MAX_CHARS) break;
      out.push(line);
      chars += line.length + 1;
    }
    const rest = lines.length - out.length;
    const more = rest > 0 ? `\n... [${rest} more lines; narrow the search with path/glob or a stricter pattern]` : "";
    return out.join("\n") + more;
  },
};

export const Glob: Tool = {
  name: "Glob",
  kind: "read",
  description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/test_*.py"). Respects .gitignore, includes hidden files. Newest first.',
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Directory to search (default: cwd)" },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    const base = args.path ? resolvePath(ctx.cwd, args.path) : ctx.cwd;
    const r = await runProcess("rg", ["--files", "--color=never", "--glob", args.pattern, ...RG_HIDDEN], { cwd: base, signal: ctx.signal, timeoutMs: 60_000 });
    if (r.code === 1 || !r.stdout.trim()) return "No files found.";
    if (r.code !== 0) throw new Error(r.stderr.trim() || `ripgrep failed with exit code ${r.code}`);
    const files = r.stdout
      .trim()
      .split("\n")
      .map((f) => join(base, f))
      .map((f) => ({ f, t: statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
      .sort((a, b) => b.t - a.t);
    const limit = MAX_PATHS;
    const out = files.slice(0, limit).map(({ f }) => relative(ctx.cwd, f) || f);
    return out.join("\n") + (files.length > limit ? `\n... [${files.length - limit} more files]` : "");
  },
};
