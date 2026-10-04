import type { Tool } from "../types.ts";
import { search } from "../registry/search.ts";

export const ToolSearchTool: Tool = {
  name: "ToolSearch",
  kind: "read",
  description:
    "Load schemas of deferred tools (listed by name in <system-reminder> messages) so they can be called with UseTool. " +
    'Query examples: "select:db-migrate" (exact name, comma-separate several), "database migration" (keyword search), ' +
    '"+github issue" (name must contain github). Load each tool once, then call it with UseTool. ' +
    "Also use it to discover capabilities (database, deploy, issues…) before saying you can't do something.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      max_results: { type: "integer", description: "Default 5" },
    },
    required: ["query"],
  },
  async run(args, ctx) {
    const reg = ctx.registry;
    const query = String(args.query).trim();
    const all = [...reg.deferred.values()];
    let found: Tool[];
    const missing: string[] = [];

    if (query.startsWith("select:")) {
      found = [];
      for (const raw of query.slice(7).split(",").map((s) => s.trim()).filter(Boolean)) {
        const t = reg.deferred.get(raw) ?? all.find((x) => x.name.toLowerCase() === raw.toLowerCase());
        if (t) found.push(t);
        else if (reg.core.has(raw)) missing.push(`${raw} (core tool, already callable)`);
        else missing.push(raw);
      }
    } else {
      found = search(all, query, args.max_results ?? 5);
    }

    for (const t of found) reg.loaded.add(t.name);
    const parts: string[] = [];
    if (found.length) {
      const lines = found.map(
        (t) => `<function>${JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })}</function>`,
      );
      parts.push(`<functions>\n${lines.join("\n")}\n</functions>\nLoaded. Call them with UseTool, e.g. {"name": "${found[0].name}", "arguments": {...}}.`);
    }
    if (missing.length) parts.push(`Not found: ${missing.join(", ")}.`);
    if (!query.startsWith("select:")) {
      const skills = search([...reg.skills.values()], query, 3);
      if (skills.length) parts.push(`Matching skills (load with the Skill tool): ${skills.map((s) => s.name).join(", ")}.`);
    }
    if (!parts.length) {
      const names = all.map((t) => t.name).join(", ") || "none";
      return `No deferred tools matched "${query}". Deferred tools: ${names}.`;
    }
    return parts.join("\n\n");
  },
};
