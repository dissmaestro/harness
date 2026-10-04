import type { Registry } from "../registry/registry.ts";
import type { Tool } from "../types.ts";
import { oneLine } from "../util.ts";

type TodoStatus = "pending" | "in_progress" | "completed";
const MARK: Record<TodoStatus, string> = { pending: "☐", in_progress: "▶", completed: "☒" };

export const TodoWrite: Tool = {
  name: "TodoWrite",
  kind: "read",
  description:
    "Keep a checklist for multi-step tasks (3+ steps). Send the whole list every time; exactly one item " +
    "should be in_progress while you work. Mark items completed as soon as they are done.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async run(args) {
    const todos = (args.todos as Array<{ content: string; status: TodoStatus }>) ?? [];
    if (!todos.length) return "Todo list cleared.";
    return todos.map((t) => `${MARK[t.status] ?? "☐"} ${t.content}`).join("\n");
  },
};

export const EXIT_PLAN_MODE = "ExitPlanMode";

export const ExitPlanMode: Tool = {
  name: EXIT_PLAN_MODE,
  kind: "read",
  description:
    "Only in plan mode: present your finished implementation plan to the user for approval. The plan is Markdown: " +
    "goal, files to change, steps, how to verify. If approved you can start editing; otherwise revise it.",
  parameters: {
    type: "object",
    properties: { plan: { type: "string", description: "The plan in Markdown" } },
    required: ["plan"],
  },
  async run(args, ctx) {
    if (!ctx.session) throw new Error("ExitPlanMode is not available here.");
    if (ctx.session.mode() !== "plan") throw new Error("Not in plan mode. Just carry on with the task.");
    return ctx.session.approvePlan(String(args.plan));
  },
};

export function agentTool(registry: Registry): Tool {
  const types = [...registry.agents.values()].map((a) => `- ${a.name}: ${oneLine(a.description, 140)}`).join("\n");
  return {
    name: "Agent",
    kind: "read", // the subagent's own tool calls go through permissions
    description:
      "Run a subagent with a fresh, separate context for a self-contained task; only its final report comes back. " +
      "Use it to keep your own context small: broad code exploration, web research, investigating a bug in parallel " +
      "to your main work. Give a complete prompt: the subagent sees none of this conversation.\nAvailable types:\n" +
      types,
    parameters: {
      type: "object",
      properties: {
        subagent_type: { type: "string", enum: [...registry.agents.keys()] },
        description: { type: "string", description: "3-5 word summary shown to the user" },
        prompt: { type: "string", description: "Full task: what to find or do and what to report back" },
      },
      required: ["subagent_type", "prompt"],
    },
    async run(args, ctx) {
      if (!ctx.session) throw new Error("Subagents cannot start other subagents.");
      return ctx.session.runSubagent(String(args.subagent_type), String(args.prompt), String(args.description ?? ""));
    },
  };
}
