import type { Tool } from "../types.ts";

/**
 * Calls a deferred tool by name. Needed because llama-server (and other servers with grammar-constrained
 * tool calling) only lets the model emit names from the request's tools list, and we keep that list
 * fixed so the prompt cache stays valid. The agent loop unwraps this call before permissions and hooks,
 * so they see the real tool.
 */
export const USE_TOOL = "UseTool";

export const UseTool: Tool = {
  name: USE_TOOL,
  kind: "read",
  description:
    "Call a deferred tool after its schema was loaded with ToolSearch. " +
    'Example: {"name": "db-migrate", "arguments": {"name": "add_users"}}. ' +
    "Use {} as arguments for tools without parameters.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Deferred tool name, exactly as listed" },
      arguments: { type: "object", description: "Arguments matching the tool's schema" },
    },
    required: ["name"],
  },
  async run() {
    throw new Error("UseTool is handled by the agent loop.");
  },
};
