import { runProcess } from "../util.ts";

/** Same shape as Claude Code's settings.json "hooks" section. */
export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";

export interface HookCommand {
  type: "command";
  command: string;
  /** seconds, default 60 */
  timeout?: number;
}

export interface HookMatcher {
  /** regex over the tool name (tool events only); empty or "*" matches everything */
  matcher?: string;
  hooks: HookCommand[];
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>;

export interface HookResult {
  /** some hook exited with code 2: block the action / send feedback to the model */
  blocked: boolean;
  /** stderr of blocking hooks, shown to the model */
  feedback: string;
  /** stdout of successful hooks; added to the prompt for UserPromptSubmit */
  context: string;
  /** failures that don't block (non-0, non-2 exit codes), shown to the user */
  warnings: string[];
}

function matches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === "*" || toolName === undefined) return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

/**
 * Runs hook commands with a JSON payload on stdin.
 * Exit 0: ok (stdout becomes context). Exit 2: block, stderr goes to the model. Other: warning.
 */
export async function runHooks(
  config: HooksConfig,
  event: HookEvent,
  payload: Record<string, unknown>,
  cwd: string,
  toolName?: string,
  signal?: AbortSignal,
): Promise<HookResult> {
  const result: HookResult = { blocked: false, feedback: "", context: "", warnings: [] };
  const commands = (config[event] ?? []).filter((m) => matches(m.matcher, toolName)).flatMap((m) => m.hooks);
  for (const hook of commands) {
    const input = JSON.stringify({ hook_event_name: event, cwd, ...payload });
    const r = await runProcess("bash", ["-c", hook.command], { cwd, input, signal, timeoutMs: (hook.timeout ?? 60) * 1000 });
    if (signal?.aborted) break; // Ctrl+C: skip the remaining hooks
    if (r.code === 2) {
      result.blocked = true;
      result.feedback += r.stderr.trim() + "\n";
    } else if (r.code === 0) {
      if (r.stdout.trim()) result.context += r.stdout.trim() + "\n";
    } else {
      const why = r.timedOut ? "timed out" : `exit code ${r.code}`;
      result.warnings.push(`${event} hook "${hook.command}" ${why}: ${r.stderr.trim()}`);
    }
  }
  result.feedback = result.feedback.trim();
  result.context = result.context.trim();
  return result;
}
