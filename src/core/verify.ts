import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess, truncateMiddle } from "../util.ts";

/** Commands that check the agent's work at the end of a turn (settings "verify"). */
export interface VerifyConfig {
  test?: string;
  lint?: string;
  /** run them automatically after a turn that changed files, and let the model fix failures (default true) */
  auto?: boolean;
  /** how many times the model may try to fix a failure in one turn */
  maxFixes?: number;
  timeoutSeconds?: number;
}

export interface CheckResult {
  name: "lint" | "test";
  command: string;
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  output: string;
  ms: number;
}

/** Runs lint, then tests (tests are skipped when lint fails: one problem at a time). */
export async function runChecks(cfg: VerifyConfig, cwd: string, signal?: AbortSignal, onStart?: (name: string, command: string) => void): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const name of ["lint", "test"] as const) {
    const command = cfg[name];
    if (!command) continue;
    onStart?.(name, command);
    const t0 = Date.now();
    const r = await runProcess("bash", ["-c", command], { cwd, signal, timeoutMs: (cfg.timeoutSeconds ?? 300) * 1000 });
    const res: CheckResult = {
      name,
      command,
      ok: r.code === 0 && !r.timedOut,
      code: r.code,
      timedOut: r.timedOut,
      output: [r.stdout, r.stderr].filter((x) => x.trim()).join("\n").trim(),
      ms: Date.now() - t0,
    };
    out.push(res);
    if (!res.ok || signal?.aborted) break;
  }
  return out;
}

/** The message that sends a failure back to the model. */
export function failureReport(r: CheckResult): string {
  const why = r.timedOut ? "timed out" : `exited with code ${r.code}`;
  return (
    `Automatic verification after your changes failed: \`${r.command}\` (${r.name}) ${why}.\n` +
    "Find the cause and fix it (in the code, or in the test if the test is wrong), then finish. Output:\n" +
    "```\n" + truncateMiddle(r.output || "(no output)", 6000) + "\n```"
  );
}

/** Guesses test and lint commands from the project files (shown as a suggestion, never run on its own). */
export function detectChecks(cwd: string): { test?: string; lint?: string } {
  const has = (f: string) => existsSync(join(cwd, f));
  if (has("package.json")) {
    try {
      const scripts = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts ?? {};
      const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") ? "bun" : "npm";
      const run = (s: string) => (pm === "npm" ? (s === "test" ? "npm test" : `npm run ${s}`) : `${pm} ${s}`);
      return {
        test: scripts.test && !/no test specified/.test(scripts.test) ? run("test") : undefined,
        lint: scripts.lint ? run("lint") : scripts.typecheck ? run("typecheck") : undefined,
      };
    } catch {}
  }
  if (has("pyproject.toml") || has("setup.py") || has("pytest.ini")) return { test: "pytest -q", lint: "ruff check ." };
  if (has("go.mod")) return { test: "go test ./...", lint: "go vet ./..." };
  if (has("Cargo.toml")) return { test: "cargo test", lint: "cargo clippy -q" };
  if (has("Makefile")) return { test: "make test" };
  return {};
}
