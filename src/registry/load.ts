import { homedir } from "node:os";
import { configBases, type Settings } from "../core/settings.ts";
import { Edit, Read, Write } from "../tools/core/files.ts";
import { Bash, Glob, Grep } from "../tools/core/shell.ts";
import { SkillTool } from "../tools/Skill.ts";
import { ToolSearchTool } from "../tools/ToolSearch.ts";
import { UseTool } from "../tools/UseTool.ts";
import { ExitPlanMode, TodoWrite, agentTool } from "../tools/session-tools.ts";
import { WebFetch, webSearchTool } from "../tools/web.ts";
import { loadMcp } from "./loaders/mcp.ts";
import { loadPlugins } from "./loaders/plugins.ts";
import { loadScripts } from "./loaders/scripts.ts";
import { loadAgents, loadCommands, loadSkills } from "./loaders/skills.ts";
import { Registry } from "./registry.ts";

export async function loadRegistry(
  cwd: string,
  settings: Settings,
  warn: (msg: string) => void,
  home = homedir(),
): Promise<Registry> {
  const reg = new Registry();
  const bases = configBases(cwd, settings.claudeCompat, home, settings.builtins);
  for (const s of loadSkills(bases, warn)) reg.skills.set(s.name, s);
  for (const c of loadCommands(bases, warn)) reg.commands.set(c.name, c);
  for (const a of loadAgents(bases, warn)) reg.agents.set(a.name, a);

  // Core tools: always in the request, in this order (the list must never change during a session).
  const core = [Read, Write, Edit, Bash, Grep, Glob, TodoWrite, SkillTool, ToolSearchTool, UseTool, ExitPlanMode];
  if (reg.agents.size) core.splice(7, 0, agentTool(reg));
  for (const t of core) reg.addCore(t);
  // Built-in deferred tools.
  if (settings.builtins) {
    reg.addDeferred({ ...webSearchTool(settings.webSearch), source: "builtin" });
    reg.addDeferred({ ...WebFetch, source: "builtin" });
  }
  for (const t of loadScripts(bases, warn)) reg.addDeferred(t);
  for (const t of await loadPlugins(bases, warn)) reg.addDeferred(t);
  for (const t of await loadMcp(settings.mcpServers, reg, home, warn)) reg.addDeferred(t);
  return reg;
}
