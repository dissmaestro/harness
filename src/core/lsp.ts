import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A minimal Language Server Protocol client: just enough to open a file, send its new text and collect
 * the diagnostics the server publishes. Servers are started on first use per (server, project root)
 * and kept running for the session.
 */

export interface Diagnostic {
  line: number;
  col: number;
  severity: "error" | "warning";
  message: string;
  source?: string;
}

export interface ServerSpec {
  command: string;
  args?: string[];
  /** files whose presence marks the project root for this server */
  roots?: string[];
}

interface Lang {
  exts: string[];
  id: (ext: string) => string;
  servers: ServerSpec[];
}

const TS_ROOTS = ["tsconfig.json", "jsconfig.json", "package.json"];
const LANGS: Lang[] = [
  {
    exts: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    id: (e) => ({ ".tsx": "typescriptreact", ".jsx": "javascriptreact", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript" })[e] ?? "typescript",
    servers: [{ command: "typescript-language-server", args: ["--stdio"], roots: TS_ROOTS }],
  },
  {
    exts: [".py", ".pyi"],
    id: () => "python",
    servers: [
      { command: "basedpyright-langserver", args: ["--stdio"], roots: ["pyproject.toml", "setup.py", "pyrightconfig.json"] },
      { command: "pyright-langserver", args: ["--stdio"], roots: ["pyproject.toml", "setup.py", "pyrightconfig.json"] },
      { command: "pylsp", roots: ["pyproject.toml", "setup.py"] },
    ],
  },
  { exts: [".go"], id: () => "go", servers: [{ command: "gopls", roots: ["go.work", "go.mod"] }] },
  { exts: [".rs"], id: () => "rust", servers: [{ command: "rust-analyzer", roots: ["Cargo.toml"] }] },
  {
    exts: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"],
    id: (e) => (e === ".c" || e === ".h" ? "c" : "cpp"),
    servers: [{ command: "clangd", roots: ["compile_commands.json", "CMakeLists.txt", ".clangd"] }],
  },
  { exts: [".lua"], id: () => "lua", servers: [{ command: "lua-language-server", roots: [".luarc.json"] }] },
  { exts: [".sh", ".bash"], id: () => "shellscript", servers: [{ command: "bash-language-server", args: ["start"] }] },
];

/** The executable for `cmd`: the project's node_modules/.bin first, then PATH. */
function findExecutable(cmd: string, from: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (cmd.includes("/")) return existsSync(cmd) ? cmd : undefined;
  for (let dir = from; ; dir = dirname(dir)) {
    const local = join(dir, "node_modules", ".bin", cmd);
    if (existsSync(local)) return local;
    if (dirname(dir) === dir) break;
  }
  for (const d of (env.PATH ?? "").split(delimiter)) if (d && existsSync(join(d, cmd))) return join(d, cmd);
  return undefined;
}

/** Nearest directory between the file and `top` that has one of the marker files, else `top`. */
function findRoot(file: string, top: string, markers: string[] = []): string {
  for (let dir = dirname(file); dir.startsWith(top); dir = dirname(dir)) {
    if (markers.some((m) => existsSync(join(dir, m)))) return dir;
    if (dir === top || dirname(dir) === dir) break;
  }
  return top;
}

class Client {
  private proc: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, (result: unknown) => void>();
  private versions = new Map<string, number>();
  /** uri → diagnostics, and listeners waiting for the next publish */
  private diags = new Map<string, Diagnostic[]>();
  private waiters = new Map<string, Array<() => void>>();
  private ready: Promise<void>;
  dead = false;
  /** checks in a row that got no diagnostics in time: a server that never answers stops being asked */
  private misses = 0;
  get unresponsive() {
    return this.misses >= 2;
  }

  readonly name: string;
  readonly root: string;

  constructor(exe: string, args: string[], root: string) {
    this.name = exe.split("/").pop()!;
    this.root = root;
    this.proc = spawn(exe, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.on("error", () => (this.dead = true));
    this.proc.on("exit", () => {
      this.dead = true;
      for (const fn of this.pending.values()) fn(undefined);
      this.pending.clear();
    });
    this.proc.stdin.on("error", () => (this.dead = true));
    this.proc.stdout.on("data", (d: Buffer) => this.onData(d));
    this.proc.stderr.on("data", () => {});
    // a language server must never keep the agent from exiting
    this.proc.unref();
    (this.proc.stdout as unknown as { unref?: () => void }).unref?.();
    (this.proc.stderr as unknown as { unref?: () => void }).unref?.();
    (this.proc.stdin as unknown as { unref?: () => void }).unref?.();
    const rootUri = pathToFileURL(root).href;
    this.ready = this.request("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: root,
      workspaceFolders: [{ uri: rootUri, name: root.split("/").pop() }],
      capabilities: {
        textDocument: { publishDiagnostics: { relatedInformation: false }, synchronization: { didSave: true } },
        workspace: { configuration: true, workspaceFolders: true },
      },
      initializationOptions: {},
    }).then(() => this.notify("initialized", {}));
  }

  private send(msg: object) {
    if (this.dead) return;
    const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.send({ id, method, params });
    });
  }

  private notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const len = Number(/Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, sep).toString())?.[1] ?? -1);
      if (len < 0 || this.buf.length < sep + 4 + len) return;
      const body = this.buf.subarray(sep + 4, sep + 4 + len).toString();
      this.buf = this.buf.subarray(sep + 4 + len);
      try {
        this.onMessage(JSON.parse(body));
      } catch {}
    }
  }

  private onMessage(m: any) {
    if (m.id !== undefined && m.method) {
      // a request from the server: answer what we can with empty results
      const result = m.method === "workspace/configuration" ? (m.params?.items ?? []).map(() => null) : null;
      this.send({ id: m.id, result });
      return;
    }
    if (m.id !== undefined) {
      this.pending.get(m.id)?.(m.result);
      this.pending.delete(m.id);
      return;
    }
    if (m.method === "textDocument/publishDiagnostics") {
      const uri: string = m.params.uri;
      this.diags.set(
        uri,
        (m.params.diagnostics ?? [])
          .filter((x: any) => (x.severity ?? 1) <= 2)
          .map((x: any) => ({
            line: x.range.start.line + 1,
            col: x.range.start.character + 1,
            severity: (x.severity ?? 1) === 1 ? "error" : "warning",
            message: String(x.message).split("\n")[0],
            source: [x.source, x.code].filter((v) => v !== undefined && v !== "").join(" ") || undefined,
          })),
      );
      for (const fn of this.waiters.get(uri) ?? []) fn();
      this.waiters.delete(uri);
    }
  }

  private nextPublish(uri: string, ms: number): Promise<boolean> {
    return new Promise((res) => {
      const t = setTimeout(() => res(false), ms);
      const list = this.waiters.get(uri) ?? [];
      list.push(() => {
        clearTimeout(t);
        res(true);
      });
      this.waiters.set(uri, list);
    });
  }

  /** Sends the file's current text and waits for the server's diagnostics (or the timeout). */
  async check(file: string, text: string, languageId: string, timeoutMs: number): Promise<Diagnostic[] | undefined> {
    const t0 = Date.now();
    const ok = await Promise.race([this.ready.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
    if (!ok || this.dead) {
      this.misses++;
      return undefined;
    }
    const uri = pathToFileURL(file).href;
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.diags.delete(uri);
    const published = this.nextPublish(uri, Math.max(500, timeoutMs - (Date.now() - t0)));
    if (version === 1) this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
    else this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    this.notify("textDocument/didSave", { textDocument: { uri }, text });
    if (!(await published)) {
      this.misses++;
      return this.diags.get(uri);
    }
    this.misses = 0;
    // some servers publish twice (syntax first, then semantic): give a later one a moment
    await this.nextPublish(uri, 300);
    return this.diags.get(uri) ?? [];
  }

  stop() {
    if (this.dead) return;
    try {
      this.proc.kill();
    } catch {}
    this.dead = true;
  }
}

const managers = new Set<LspManager>();

/** Stops every language server (on exit). */
export function stopAllLsp() {
  for (const m of managers) m.stop();
}

/** Language servers of one session. */
export class LspManager {
  private clients = new Map<string, Client>();
  private missing = new Set<string>();
  private top: string;
  private overrides: Record<string, ServerSpec>;

  constructor(top: string, overrides: Record<string, ServerSpec> = {}) {
    this.top = top;
    this.overrides = overrides;
    managers.add(this);
  }

  /** The server for a file, started if needed; undefined when none is installed for its language. */
  private client(file: string, topDir = this.top): { client: Client; languageId: string } | undefined {
    const ext = extname(file).toLowerCase();
    const lang = LANGS.find((l) => l.exts.includes(ext));
    const custom = this.overrides[ext];
    if (!lang && !custom) return undefined;
    for (const spec of custom ? [custom] : lang!.servers) {
      if (this.missing.has(spec.command)) continue;
      const exe = findExecutable(spec.command, dirname(file));
      if (!exe) {
        this.missing.add(spec.command);
        continue;
      }
      const top = resolve(file).startsWith(topDir) ? topDir : dirname(file);
      const root = findRoot(file, top, spec.roots);
      const key = `${spec.command}\0${root}`;
      let client = this.clients.get(key);
      if (client?.unresponsive) continue; // e.g. still indexing a huge project: don't make every edit wait
      if (!client || client.dead) {
        if (this.clients.size >= 6) return undefined; // worktrees could otherwise start a server each
        client = new Client(exe, spec.args ?? [], root);
        this.clients.set(key, client);
      }
      return { client, languageId: lang?.id(ext) ?? ext.slice(1) };
    }
    return undefined;
  }

  /** the server command that handles this file, if one is installed */
  serverFor(file: string, top?: string): string | undefined {
    const c = this.client(file, top);
    return c ? c.client.name : undefined;
  }

  async check(file: string, text: string, top?: string, timeoutMs = 4000): Promise<Diagnostic[] | undefined> {
    const c = this.client(file, top);
    return c ? c.client.check(file, text, c.languageId, timeoutMs) : undefined;
  }

  stop() {
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
  }
}
