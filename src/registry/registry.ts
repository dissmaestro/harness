import type { Tool } from "../types.ts";
import { oneLine } from "../util.ts";

export interface Skill {
  name: string;
  description: string;
  /** directory containing SKILL.md (scripts next to it are referenced from the instructions) */
  dir: string;
  file: string;
}

export interface AgentDef {
  name: string;
  description: string;
  /** allowed tool names, or "*" for all (Agent and ExitPlanMode are never available to subagents) */
  tools: string[] | "*";
  /** read-only subagent: edits and non-read-only commands are refused */
  readOnly: boolean;
  /** system prompt for the subagent */
  prompt: string;
  file: string;
}

export interface Command {
  name: string;
  description: string;
  file: string;
  template: string;
}

/** Max description length in the always-in-context skill list. */
export const SKILL_DESC_MAX = 120;

/**
 * Everything the agent can do. Core tools are always sent to the model. Deferred tools are
 * listed by name only; the model fetches a schema with ToolSearch, which marks it loaded, and calls
 * it through UseTool (or by name on servers that allow tool names outside the tools list).
 */
export class Registry {
  core = new Map<string, Tool>();
  deferred = new Map<string, Tool>();
  skills = new Map<string, Skill>();
  commands = new Map<string, Command>();
  agents = new Map<string, AgentDef>();
  /** deferred tools whose schema the model has seen in this session */
  loaded = new Set<string>();
  disposers: Array<() => void> = [];

  addCore(tool: Tool) {
    this.core.set(tool.name, { source: "core", ...tool });
  }

  addDeferred(tool: Tool) {
    if (this.core.has(tool.name)) return;
    this.deferred.set(tool.name, tool);
  }

  resolve(name: string): { tool: Tool; error?: undefined } | { tool?: undefined; error: string } {
    const core = this.core.get(name);
    if (core) return { tool: core };
    const deferred = this.deferred.get(name);
    if (deferred) {
      if (this.loaded.has(name)) return { tool: deferred };
      return {
        error: `${name} is a deferred tool and its schema is not loaded yet. Call ToolSearch with query "select:${name}" first, then call it with UseTool.`,
      };
    }
    if (this.skills.has(name)) return { error: `${name} is a skill, not a tool. Call the Skill tool with skill: "${name}".` };
    return { error: `Unknown tool "${name}". Available tools: ${[...this.core.keys()].join(", ")}.` };
  }

  /** Text for the <system-reminder>: skill names + descriptions, deferred tool names only. */
  catalog(): string {
    const parts: string[] = [];
    if (this.skills.size) {
      const list = [...this.skills.values()].map((s) => `- ${s.name}: ${oneLine(s.description, SKILL_DESC_MAX)}`);
      parts.push(`The following skills are available via the Skill tool:\n${list.join("\n")}`);
    }
    if (this.agents.size) {
      const list = [...this.agents.values()].map((a) => `- ${a.name}: ${oneLine(a.description, SKILL_DESC_MAX)}`);
      parts.push(
        "Subagents you can delegate to with the Agent tool (they work in their own context and return only a report; " +
          `prefer them for broad searches and web research):\n${list.join("\n")}`,
      );
    }
    if (this.deferred.size) {
      parts.push(
        "The following deferred tools are available. Only their names are known: load a schema with ToolSearch, then call the tool with UseTool.\n" +
          [...this.deferred.keys()].join("\n"),
      );
    }
    return parts.join("\n\n");
  }

  allToolNames(): Set<string> {
    return new Set([...this.core.keys(), ...this.deferred.keys()]);
  }

  dispose() {
    for (const d of this.disposers.splice(0)) {
      try {
        d();
      } catch {}
    }
  }
}
