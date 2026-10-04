import { statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Tool } from "../../types.ts";
import { resolvePath, runProcess, truncateMiddle } from "../../util.ts";

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
    return truncateMiddle(parts.filter(Boolean).join("\n") || "(no output)");
  },
};

export const Grep: Tool = {
  name: "Grep",
  kind: "read",
  description:
    "Search file contents with ripgrep (regex). Respects .gitignore. " +
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
    const rg = ["--color=never", "--no-heading", "--max-columns=500"];
    rg.push(mode === "files_with_matches" ? "-l" : mode === "count" ? "-c" : "-n");
    if (args.case_insensitive) rg.push("-i");
    if (args.glob) rg.push("--glob", args.glob);
    rg.push("-e", args.pattern);
    if (args.path) rg.push("--", resolvePath(ctx.cwd, args.path));
    const r = await runProcess("rg", rg, { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: 60_000 });
    if (r.code === 1) return "No matches found.";
    if (r.code !== 0) throw new Error(r.stderr.trim() || `ripgrep failed with exit code ${r.code}`);
    const lines = r.stdout.trimEnd().split("\n");
    const limit = args.head_limit ?? 200;
    const more = lines.length > limit ? `\n... [${lines.length - limit} more lines; narrow the search or raise head_limit]` : "";
    return lines.slice(0, limit).join("\n") + more;
  },
};

export const Glob: Tool = {
  name: "Glob",
  kind: "read",
  description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/test_*.py"). Respects .gitignore. Newest first.',
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
    const r = await runProcess("rg", ["--files", "--color=never", "--glob", args.pattern, "--glob", "!.git"], { cwd: base, signal: ctx.signal, timeoutMs: 60_000 });
    if (r.code === 1 || !r.stdout.trim()) return "No files found.";
    if (r.code !== 0) throw new Error(r.stderr.trim() || `ripgrep failed with exit code ${r.code}`);
    const files = r.stdout
      .trim()
      .split("\n")
      .map((f) => join(base, f))
      .map((f) => ({ f, t: statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
      .sort((a, b) => b.t - a.t);
    const limit = 200;
    const out = files.slice(0, limit).map(({ f }) => relative(ctx.cwd, f) || f);
    return out.join("\n") + (files.length > limit ? `\n... [${files.length - limit} more files]` : "");
  },
};
