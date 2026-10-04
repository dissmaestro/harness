import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConfigBase } from "../../core/settings.ts";
import type { Tool } from "../../types.ts";

/**
 * <base>/plugins/*.{ts,js,mjs}: default export is a Tool or Tool[] (see src/types.ts).
 * Plugin tools are deferred like scripts. kind defaults to "exec".
 */
export async function loadPlugins(bases: ConfigBase[], warn: (msg: string) => void): Promise<Tool[]> {
  const byName = new Map<string, Tool>();
  for (const { dir, claude } of bases) {
    if (claude) continue;
    const root = join(dir, "plugins");
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const entry of readdirSync(root).filter((f) => /\.(ts|js|mjs)$/.test(f))) {
      const file = join(root, entry);
      try {
        const mod = await import(pathToFileURL(file).href);
        const list: Partial<Tool>[] = Array.isArray(mod.default) ? mod.default : [mod.default];
        for (const t of list) {
          if (!t?.name || !t.description || typeof t.run !== "function") {
            warn(`Plugin ${file}: export needs name, description and run()`);
            continue;
          }
          byName.set(t.name, {
            kind: "exec",
            parameters: { type: "object", properties: {} },
            ...t,
            source: `plugin:${file}`,
          } as Tool);
        }
      } catch (e) {
        warn(`Skipping plugin ${file}: ${(e as Error).message}`);
      }
    }
  }
  return [...byName.values()];
}
