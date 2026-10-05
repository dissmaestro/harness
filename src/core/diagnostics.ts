import { relative } from "node:path";
import { runProcess } from "../util.ts";
import { type Diagnostic, LspManager, type ServerSpec } from "./lsp.ts";

export interface DiagnosticsConfig {
  /** use language servers when installed (default true); otherwise only quick syntax checks */
  lsp?: boolean;
  /** how long to wait for a language server after an edit */
  timeoutMs?: number;
  /** extension → server, e.g. {".vue": {"command": "vue-language-server", "args": ["--stdio"]}} */
  servers?: Record<string, ServerSpec>;
}

const MAX_SHOWN = 10;

/** Syntax checks that need no language server: fast, and catch the broken edits local models make. */
async function quickCheck(file: string, text: string, cwd: string): Promise<{ tool: string; diags: Diagnostic[] } | undefined> {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  const run = async (tool: string, cmd: string, args: string[], parse: RegExp) => {
    const r = await runProcess(cmd, args, { cwd, timeoutMs: 10_000 });
    if (r.code === null && /ENOENT|not found/i.test(r.stderr)) return undefined;
    if (r.code === 0) return { tool, diags: [] };
    const out = `${r.stderr}\n${r.stdout}`;
    const m = parse.exec(out);
    const message = (/(?:SyntaxError|Error|error):?\s*(.+)/.exec(out)?.[1] ?? out.trim().split("\n").at(-1) ?? "syntax error").trim();
    return { tool, diags: [{ line: Number(m?.[1] ?? 1), col: Number(m?.[2] ?? 1), severity: "error" as const, message }] };
  };
  switch (ext) {
    case ".json":
      try {
        JSON.parse(text);
        return { tool: "JSON.parse", diags: [] };
      } catch (e) {
        const pos = Number(/position (\d+)/.exec(String((e as Error).message))?.[1] ?? 0);
        const before = text.slice(0, pos).split("\n");
        return { tool: "JSON.parse", diags: [{ line: before.length, col: before.at(-1)!.length + 1, severity: "error", message: (e as Error).message }] };
      }
    case ".js":
    case ".mjs":
    case ".cjs":
      return run("node --check", process.execPath, ["--check", file], /:(\d+)\n/);
    case ".py":
      return run("python3 ast.parse", "python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read(), sys.argv[1])", file], /line (\d+)/);
    case ".sh":
    case ".bash":
      return run("bash -n", "bash", ["-n", file], /line (\d+)/);
    case ".go":
      return run("gofmt -e", "gofmt", ["-e", "-l", file], /:(\d+):(\d+):/);
  }
  return undefined;
}

/**
 * After an edit: the problems the file has now (language server if installed, else a syntax check),
 * phrased so the model knows the edit itself succeeded and which errors are new.
 */
export class Diagnostics {
  private lsp: LspManager | undefined;
  /** file → how many times each problem was reported at the previous check */
  private last = new Map<string, Map<string, number>>();
  private cfg: DiagnosticsConfig;

  constructor(cwd: string, cfg: DiagnosticsConfig = {}) {
    this.cfg = cfg;
    if (cfg.lsp !== false) this.lsp = new LspManager(cwd, cfg.servers);
  }

  async afterEdit(file: string, text: string, cwd: string): Promise<string> {
    let tool: string | undefined;
    let diags: Diagnostic[] | undefined;
    const server = this.lsp?.serverFor(file, cwd);
    if (server) {
      diags = await this.lsp!.check(file, text, cwd, this.cfg.timeoutMs ?? 4000);
      tool = server;
    }
    if (!diags) {
      const q = await quickCheck(file, text, cwd).catch(() => undefined);
      if (!q) return "";
      ({ tool, diags } = q);
    }
    const key = (d: Diagnostic) => `${d.severity}:${d.message}`;
    const before = this.last.get(file);
    const counts = new Map<string, number>();
    for (const d of diags) counts.set(key(d), (counts.get(key(d)) ?? 0) + 1);
    this.last.set(file, counts);
    const errors = diags.filter((d) => d.severity === "error");
    const warnings = diags.length - errors.length;
    const rel = relative(cwd, file) || file;
    if (!errors.length) {
      // only worth saying when it fixes earlier errors (no noise on every clean edit)
      return before && [...before.keys()].some((k) => k.startsWith("error:")) ? `\n\nDiagnostics (${tool}): ${rel} has no errors now.` : "";
    }
    // the same message reported more often than last time counts as new (identical errors on several lines)
    const left = new Map(before ?? []);
    const fresh = new Set<Diagnostic>();
    for (const d of [...errors].sort((a, b) => a.line - b.line)) {
      const n = left.get(key(d)) ?? 0;
      if (n > 0) left.set(key(d), n - 1);
      else fresh.add(d);
    }
    const lines = errors
      .sort((a, b) => Number(fresh.has(b)) - Number(fresh.has(a)) || a.line - b.line)
      .slice(0, MAX_SHOWN)
      .map((d) => `  ${rel}:${d.line}:${d.col} error${d.source ? ` [${d.source}]` : ""}: ${d.message}${before && fresh.has(d) ? " (new)" : ""}`);
    const more = errors.length > MAX_SHOWN ? `\n  … ${errors.length - MAX_SHOWN} more errors` : "";
    const head =
      `\n\nThe edit was applied, but ${rel} now has ${errors.length} error${errors.length === 1 ? "" : "s"}` +
      (before ? ` (${fresh.size} new since your previous edit of this file)` : "") +
      `${warnings ? ` and ${warnings} warning${warnings === 1 ? "" : "s"}` : ""} according to ${tool}:`;
    const tail = fresh.size || !before ? "\nFix the errors your change caused before moving on (errors that were there before your change can be left)." : "";
    return `${head}\n${lines.join("\n")}${more}${tail}`;
  }

  stop() {
    this.lsp?.stop();
  }
}
