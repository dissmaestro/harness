import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Version from package.json (shown by --version, sent to MCP servers). */
export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export function resolvePath(cwd: string, p: string): string {
  if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** Keeps head and tail of long output; the middle is usually the least useful part. */
/** Saves long output (a command's, a subagent's report) so the model can page through it instead of losing the middle. */
export function saveFullOutput(out: string, ext = "log"): string | undefined {
  try {
    const dir = join(tmpdir(), "agent-output");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
    writeFileSync(file, out);
    return file;
  } catch {
    return undefined;
  }
}

export function truncateMiddle(s: string, max = 16_000): string {
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
/** After the main process exits, how long to wait for output from children still holding the pipes. */
const EXIT_GRACE_MS = 500;

/** Process groups started by runProcess that may still be alive. */
const liveGroups = new Set<number>();

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGKILLs every process group started by runProcess (for SIGTERM/SIGHUP/exit cleanup). */
export function killAllProcesses() {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  liveGroups.clear();
}

/** Runs a process in its own process group so timeouts and Ctrl+C kill its children too. */
export function runProcess(cmd: string, args: string[], opts: ProcOptions): Promise<ProcResult> {
  if (opts.signal?.aborted) return Promise.resolve({ code: null, stdout: "", stderr: "aborted", timedOut: false });
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // no stdin unless input is given: tools like rg would otherwise read the empty pipe instead of files
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    const pid = child.pid;
    if (pid !== undefined) liveGroups.add(pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;
    let grace: NodeJS.Timeout | undefined;
    const kill = () => {
      try {
        if (pid !== undefined) process.kill(-pid, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs ?? 120_000);
    opts.signal?.addEventListener("abort", kill, { once: true });
    const finish = (code: number | null, extraErr = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      opts.signal?.removeEventListener("abort", kill);
      // a daemonized grandchild may still hold the pipes: stop reading them
      child.stdout!.destroy();
      child.stderr!.destroy();
      if (pid !== undefined && !groupAlive(pid)) liveGroups.delete(pid); // background children stay tracked for cleanup
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
    // 'close' waits for every holder of the pipes; don't hang on background children
    child.on("exit", (code) => {
      grace = setTimeout(() => finish(code), EXIT_GRACE_MS);
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }
  });
}
