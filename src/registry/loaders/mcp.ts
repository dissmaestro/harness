import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "../../core/settings.ts";
import type { JSONSchema, Tool } from "../../types.ts";
import { truncateMiddle } from "../../util.ts";
import type { Registry } from "../registry.ts";

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
  annotations?: { readOnlyHint?: boolean };
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

/** Minimal MCP client over stdio (newline-delimited JSON-RPC). Starts the server on first use. */
export class McpClient {
  name: string;
  cfg: McpServerConfig;
  private proc: ChildProcess | undefined;
  private ready: Promise<void> | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private stderrTail = "";

  constructor(name: string, cfg: McpServerConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  get started() {
    return this.ready !== undefined;
  }

  start(): Promise<void> {
    this.ready ??= this.init();
    return this.ready;
  }

  private async init() {
    const proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...this.cfg.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (d: string) => this.onData(d));
    proc.stderr!.on("data", (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    proc.stdin!.on("error", () => {});
    const fail = (e: Error) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
      this.proc = undefined;
      this.ready = undefined; // next call restarts the server
    };
    proc.on("error", (e) => fail(new Error(`MCP server "${this.name}" failed to start: ${e.message}`)));
    proc.on("exit", (code) => fail(new Error(`MCP server "${this.name}" exited (code ${code}). ${this.stderrTail.trim()}`)));
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "agent", version: "0.1.0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private onData(d: string) {
    this.buf += d;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        // request from the server (ping, roots/list, sampling…)
        if (msg.method === "ping") this.send({ jsonrpc: "2.0", id: msg.id, result: {} });
        else this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not supported" } });
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  private send(msg: object) {
    this.proc?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params: object, timeoutMs = 60_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}: ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.start();
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(r.tools ?? []));
      cursor = r.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.start();
    const r = await this.request("tools/call", { name, arguments: args }, 300_000);
    const text = (r.content ?? [])
      .map((c: any) => (c.type === "text" ? c.text : `[${c.type} content omitted]`))
      .join("\n");
    if (r.isError) throw new Error(text || "MCP tool returned an error");
    return text || (r.structuredContent ? JSON.stringify(r.structuredContent) : "(no output)");
  }

  close() {
    this.proc?.kill();
  }
}

function mcpTool(server: string, info: McpToolInfo, client: McpClient, onFirstStart: () => void): Tool {
  return {
    name: `mcp__${server}__${info.name}`,
    description: info.description ?? "",
    tags: ["mcp", server],
    kind: info.annotations?.readOnlyHint ? "read" : "exec",
    source: `mcp:${server}`,
    parameters: info.inputSchema ?? { type: "object", properties: {} },
    async run(args) {
      const first = !client.started;
      const out = await client.callTool(info.name, args);
      if (first) onFirstStart();
      return truncateMiddle(out);
    },
  };
}

/**
 * Tool names come from a cache (~/.agent/cache/mcp/<server>.json) so servers don't have to start
 * with the agent; they start on first call and refresh the cache. Without a cache the server is
 * started once at launch to list its tools.
 */
export async function loadMcp(
  servers: Record<string, McpServerConfig>,
  registry: Registry,
  home: string,
  warn: (msg: string) => void,
): Promise<Tool[]> {
  const cacheDir = join(home, ".agent", "cache", "mcp");
  const out: Tool[] = [];
  await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const client = new McpClient(name, cfg);
      registry.disposers.push(() => client.close());
      const cacheFile = join(cacheDir, `${name}.json`);
      const writeCache = (list: McpToolInfo[]) => {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(list, null, 2));
      };
      let infos: McpToolInfo[] | undefined;
      let fromCache = false;
      if (existsSync(cacheFile)) {
        try {
          infos = JSON.parse(readFileSync(cacheFile, "utf8"));
          fromCache = true;
        } catch {}
      }
      if (!infos) {
        try {
          infos = await client.listTools();
          writeCache(infos);
        } catch (e) {
          warn(`MCP server "${name}": ${(e as Error).message}`);
          return;
        }
      }
      const refresh = () => {
        if (fromCache) client.listTools().then(writeCache, () => {});
      };
      for (const info of infos) out.push(mcpTool(name, info, client, refresh));
    }),
  );
  return out;
}
