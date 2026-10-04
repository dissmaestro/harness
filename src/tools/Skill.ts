import type { Tool } from "../types.ts";
import { readSkillBody } from "../registry/loaders/skills.ts";
import type { Registry } from "../registry/registry.ts";

export function skillPrompt(registry: Registry, name: string, args?: string): string {
  const skill =
    registry.skills.get(name) ?? [...registry.skills.values()].find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!skill) {
    throw new Error(`Unknown skill "${name}". Available skills: ${[...registry.skills.keys()].join(", ") || "none"}.`);
  }
  let out = `Base directory for this skill: ${skill.dir}\n\n${readSkillBody(skill)}`;
  if (args?.trim()) out += `\n\nARGUMENTS: ${args.trim()}`;
  return out;
}

export const SkillTool: Tool = {
  name: "Skill",
  kind: "read",
  description:
    "Load a skill. Skills are listed with descriptions in <system-reminder> messages. When a task matches " +
    "a skill's description, call this tool FIRST: it returns the skill's full instructions, which you then follow. " +
    "Paths in the instructions are relative to the skill's base directory.",
  parameters: {
    type: "object",
    properties: {
      skill: { type: "string", description: "Exact skill name from the list" },
      args: { type: "string", description: "Optional arguments for the skill" },
    },
    required: ["skill"],
  },
  async run(args, ctx) {
    return skillPrompt(ctx.registry, args.skill, args.args);
  },
};
