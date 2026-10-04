import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ConfigBase } from "../../core/settings.ts";
import type { AgentDef, Command, Skill } from "../registry.ts";
import { firstParagraph, parseFrontmatter } from "./frontmatter.ts";

function isDir(p: string) {
  return statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** <base>/skills/<name>/SKILL.md — the same layout as Claude Code, so its skills work as-is. */
export function loadSkills(bases: ConfigBase[], warn: (msg: string) => void): Skill[] {
  const byName = new Map<string, Skill>();
  for (const { dir } of bases) {
    const root = join(dir, "skills");
    if (!isDir(root)) continue;
    for (const entry of readdirSync(root)) {
      const skillDir = join(root, entry);
      const file = join(skillDir, "SKILL.md");
      if (!isDir(skillDir) || !existsSync(file)) continue;
      try {
        const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
        const name = data.name || entry;
        byName.set(name, { name, description: data.description || firstParagraph(body), dir: skillDir, file });
      } catch (e) {
        warn(`Skipping skill ${file}: ${(e as Error).message}`);
      }
    }
  }
  return [...byName.values()];
}

/** <base>/commands/*.md — prompt templates the user runs as /name args. */
export function loadCommands(bases: ConfigBase[], warn: (msg: string) => void): Command[] {
  const byName = new Map<string, Command>();
  for (const { dir } of bases) {
    const root = join(dir, "commands");
    if (!isDir(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!entry.endsWith(".md")) continue;
      const file = join(root, entry);
      try {
        const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
        const name = basename(entry, ".md");
        byName.set(name, { name, description: data.description || firstParagraph(body), file, template: body.trim() });
      } catch (e) {
        warn(`Skipping command ${file}: ${(e as Error).message}`);
      }
    }
  }
  return [...byName.values()];
}

/** $ARGUMENTS -> all args, $1..$9 -> positional args. Args are appended if the template doesn't use them. */
export function expandCommand(template: string, args: string): string {
  const a = args.trim();
  const parts = a ? a.split(/\s+/) : [];
  const usesArgs = /\$ARGUMENTS|\$[1-9]\b/.test(template);
  let out = template.replace(/\$ARGUMENTS/g, a).replace(/\$([1-9])\b/g, (_m, n: string) => parts[Number(n) - 1] ?? "");
  if (!usesArgs && a) out += `\n\nARGUMENTS: ${a}`;
  return out;
}

export function readSkillBody(skill: Skill): string {
  return parseFrontmatter(readFileSync(skill.file, "utf8")).body.trim();
}

/**
 * <base>/agents/*.md — subagent definitions (Claude Code format):
 *   ---
 *   name: explore
 *   description: When to use this subagent
 *   tools: Read, Grep, Glob        (omit or "*" for all tools)
 *   readonly: true                 (optional)
 *   ---
 *   System prompt for the subagent…
 */
export function loadAgents(bases: ConfigBase[], warn: (msg: string) => void): AgentDef[] {
  const byName = new Map<string, AgentDef>();
  for (const { dir } of bases) {
    const root = join(dir, "agents");
    if (!isDir(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!entry.endsWith(".md")) continue;
      const file = join(root, entry);
      try {
        const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
        const name = data.name || basename(entry, ".md");
        const tools = !data.tools || data.tools.trim() === "*" ? "*" : data.tools.split(",").map((t) => t.trim()).filter(Boolean);
        byName.set(name, {
          name,
          description: data.description || firstParagraph(body),
          tools,
          readOnly: /^(true|yes|1)$/i.test(data.readonly ?? ""),
          prompt: body.trim(),
          file,
        });
      } catch (e) {
        warn(`Skipping agent ${file}: ${(e as Error).message}`);
      }
    }
  }
  return [...byName.values()];
}
