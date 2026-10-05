import { type Activity, type ActivityBoard, formatDuration } from "../core/activity.ts";
import { c, contextLabel } from "./render.ts";

const mark = (state: Activity["state"]) => (state === "running" ? c.yellow("●") : state === "done" ? c.green("✓") : c.red("✗"));

/** One line about an agent: "#2 general "fix login" · step 9/30 · 1m05s · Edit(src/a.ts) · todo 1/3" */
export function activityLine(a: Activity, now = Date.now()): string {
  const parts: string[] = [c.dim(`step ${a.step}/${a.maxSteps}`), c.dim(formatDuration(a.elapsed(now)))];
  if (a.contextWindow && !a.id) parts.push(c.dim(contextLabel(a.contextUsed, a.contextWindow)));
  const todo = a.todoProgress();
  if (todo) parts.push(c.dim(`todo ${todo}`));
  if (a.state === "running" && a.tool) parts.push(c.cyan(`${a.tool.name}(${a.tool.summary})`) + c.dim(` ${formatDuration(now - a.tool.since)}`));
  else if (a.state !== "running") parts.push(a.state === "done" ? c.green("done") : c.red("failed"));
  const name = c.bold(a.label) + (a.description ? " " + c.dim(`"${a.description}"`) : "") + (a.worktree ? " " + c.magenta("[worktree]") : "");
  return `${mark(a.state)} ${name}  ${parts.join(c.dim(" · "))}`;
}

/** The /status tree. */
export function renderStatus(board: ActivityBoard, now = Date.now()): string {
  const root = board.root;
  if (root.state !== "running" && !root.children.length) return c.dim("  Idle: nothing is running.");
  const out: string[] = ["  " + activityLine(root, now)];
  const detail = (a: Activity, pad: string) => {
    const todo = a.currentTodo();
    if (todo) out.push(`${pad}${c.dim("▶ " + todo)}`);
    else if (a.state === "running" && a.lastText) out.push(`${pad}${c.dim("“" + a.lastText.slice(0, 100) + "”")}`);
  };
  detail(root, "    ");
  const walk = (a: Activity, pad: string) => {
    a.children.forEach((ch, i) => {
      const last = i === a.children.length - 1;
      out.push(`${pad}${c.gray(last ? "└ " : "├ ")}${activityLine(ch, now)}`);
      const next = pad + (last ? "  " : c.gray("│ "));
      detail(ch, next + "  ");
      walk(ch, next);
    });
  };
  walk(root, "  ");
  return out.join("\n");
}

/** Short one-liner for the footer: "main: Edit(src/a.ts) · #1 explore: Grep · #2 general: Bash" */
export function activitySummary(board: ActivityBoard): string {
  const running = board.all().filter((a) => a.state === "running");
  return running
    .map((a) => {
      const what = a.tool ? `${a.tool.name}(${a.tool.summary.slice(0, 30)})` : a.id ? "thinking" : running.length > 1 ? "waiting" : "thinking";
      return `${a.label}: ${what}`;
    })
    .join(" · ");
}
