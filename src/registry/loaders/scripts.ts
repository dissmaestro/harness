import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ConfigBase } from "../../core/settings.ts";
import type { JSONSchema, Tool } from "../../types.ts";
import { runProcess, truncateMiddle } from "../../util.ts";

interface ScriptArg {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

interface ScriptMeta {
  name: string;
  description: string;
  tags: string[];
  args: ScriptArg[];
  kind: "read" | "exec";
}

const ARG_RE = /^@arg\s+([A-Za-z0-9_]+)\s*:\s*(string|number|integer|boolean)?\s*(\(required\))?\s*(?:[—–-]+\s*)?(.*)$/;

/**
 * Reads the leading comment block:
 *   # @name: db-migrate
 *   # @description: Create a new database migration
 *   # @tags: db, sql
 *   # @readonly            (optional: run without asking for permission)
 *   # @arg name: string (required) — migration name
 */
export function parseScriptHeader(text: string, fallbackName: string): ScriptMeta | undefined {
  const meta: ScriptMeta = { name: fallbackName, description: "", tags: [], args: [], kind: "exec" };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#!") || !line) continue;
    if (!line.startsWith("#") && !line.startsWith("//")) break;
    const c = line.replace(/^(#|\/\/)\s?/, "").trim();
    if (c.startsWith("@arg ")) {
      const m = c.match(ARG_RE);
      if (m) meta.args.push({ name: m[1], type: m[2] ?? "string", required: !!m[3], description: m[4].trim() });
    } else if (c === "@readonly") {
      meta.kind = "read";
    } else {
      const m = c.match(/^@(name|description|tags):\s*(.*)$/);
      if (m?.[1] === "name") meta.name = m[2].trim();
      if (m?.[1] === "description") meta.description = m[2].trim();
      if (m?.[1] === "tags") meta.tags = m[2].split(",").map((t) => t.trim()).filter(Boolean);
    }
  }
  return meta.description ? meta : undefined;
}

function isExecutable(file: string) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function scriptTool(file: string, meta: ScriptMeta): Tool {
  const properties: Record<string, JSONSchema> = {};
  for (const a of meta.args) properties[a.name] = { type: a.type, description: a.description };
  return {
    name: meta.name.replace(/[^A-Za-z0-9_-]/g, "_"),
    description: meta.description,
    tags: meta.tags,
    kind: meta.kind,
    source: `script:${file}`,
    parameters: { type: "object", properties, required: meta.args.filter((a) => a.required).map((a) => a.name) },
    async run(args, ctx) {
      const positional = meta.args.map((a) => (args[a.name] === undefined ? "" : String(args[a.name])));
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const a of meta.args) if (args[a.name] !== undefined) env[`ARG_${a.name.toUpperCase()}`] = String(args[a.name]);
      const [cmd, cmdArgs] = isExecutable(file) ? [file, positional] : ["bash", [file, ...positional]];
      const r = await runProcess(cmd, cmdArgs, { cwd: ctx.cwd, env, signal: ctx.signal, timeoutMs: 300_000 });
      let out = r.stdout + (r.stderr.trim() ? `\n[stderr]\n${r.stderr}` : "");
      if (r.timedOut) out += "\n[timed out]";
      else if (r.code !== 0) out += `\n[exit code ${r.code}]`;
      return truncateMiddle(out.trim() || "(no output)");
    },
  };
}

/** <base>/scripts/* with a header comment become deferred tools. Files without @description are skipped. */
export function loadScripts(bases: ConfigBase[], warn: (msg: string) => void): Tool[] {
  const byName = new Map<string, Tool>();
  for (const { dir, claude } of bases) {
    if (claude) continue;
    const root = join(dir, "scripts");
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const entry of readdirSync(root)) {
      const file = join(root, entry);
      if (!statSync(file).isFile()) continue;
      try {
        const meta = parseScriptHeader(readFileSync(file, "utf8").slice(0, 8000), basename(entry, extname(entry)));
        if (meta) {
          const tool = scriptTool(file, meta);
          byName.set(tool.name, tool);
        }
      } catch (e) {
        warn(`Skipping script ${file}: ${(e as Error).message}`);
      }
    }
  }
  return [...byName.values()];
}
