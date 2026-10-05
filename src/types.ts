import type { Registry } from "./registry/registry.ts";

export type JSONSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  [key: string]: unknown;
};

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning?: string }
  | { role: "tool"; tool_call_id: string; content: string };

/** read: runs without asking; edit: auto-approved in acceptEdits mode; exec: always asks (unless yolo). */
export type ToolKind = "read" | "edit" | "exec";

/** Agent-level services a tool may need (modes, subagents, plan approval). */
export interface Session {
  runSubagent(type: string, prompt: string, description: string): Promise<string>;
  approvePlan(plan: string): Promise<string>;
  mode(): string;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  registry: Registry;
  /** absolute path -> mtime at last Read/Write; Edit/Write require a fresh read */
  readFiles: Map<string, number>;
  session?: Session;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  kind: ToolKind;
  tags?: string[];
  /** where it came from: "core", "script:<path>", "plugin:<path>", "mcp:<server>" */
  source?: string;
  /** Returns text for the model. Throw an Error to report a failure. */
  run(args: Record<string, any>, ctx: ToolContext): Promise<string>;
}
