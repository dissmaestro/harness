import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export function resolvePath(cwd: string, p: string): string {
  if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** Keeps head and tail of long output; the middle is usually the least useful part. */
export function truncateMiddle(s: string, max = 30_000): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n... [${s.length - max} chars truncated] ...\n\n${s.slice(-half)}`;
}

export function oneLine(s: string, max = 100): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

export function numberLines(lines: string[], firstLine: number): string {
  return lines.map((l, i) => `${String(firstLine + i).padStart(6)}\t${l}`).join("\n");
}

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const MAX_CAPTURE = 5_000_000;

/** Runs a process in its own process group so timeouts and Ctrl+C kill its children too. */
export function runProcess(cmd: string, args: string[], opts: ProcOptions): Promise<ProcResult> {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // no stdin unless input is given: tools like rg would otherwise read the empty pipe instead of files
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs ?? 120_000);
    opts.signal?.addEventListener("abort", kill, { once: true });
    const finish = (code: number | null, extraErr = "") => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      done({ code, stdout, stderr: stderr + extraErr, timedOut });
    };
    child.stdout!.on("data", (d) => {
      if (stdout.length < MAX_CAPTURE) stdout += d;
    });
    child.stderr!.on("data", (d) => {
      if (stderr.length < MAX_CAPTURE) stderr += d;
    });
    child.on("error", (e) => finish(-1, e.message));
    child.on("close", (code) => finish(code));
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }
  });
}
