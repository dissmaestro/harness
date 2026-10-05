import { spawnSync } from "node:child_process";

/** Shows text through $PAGER (default `less -R -F -X`) when it doesn't fit the terminal; otherwise just prints it. */
export function page(text: string, rl?: { pause(): unknown; resume(): unknown }): void {
  const out = process.stdout;
  const body = text.endsWith("\n") ? text : text + "\n";
  const lines = body.split("\n").length - 1;
  if (!out.isTTY || lines <= (out.rows || 24) - 2) {
    out.write(body);
    return;
  }
  const stdin = process.stdin;
  const wasRaw = !!stdin.isTTY && stdin.isRaw;
  // ctrl+c inside the pager also reaches us (same process group): don't let it kill the agent
  const ignore = () => {};
  process.on("SIGINT", ignore);
  rl?.pause();
  if (wasRaw) stdin.setRawMode(false);
  try {
    const cmd = process.env.PAGER || "less -R -F -X";
    const r = spawnSync(cmd, {
      shell: true,
      input: body,
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, LESS: process.env.LESS ?? "-R" },
    });
    if (r.error || r.status === 127) out.write(body);
  } finally {
    if (wasRaw) stdin.setRawMode(true);
    rl?.resume();
    process.off("SIGINT", ignore);
  }
}
