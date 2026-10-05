import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentUI } from "../src/core/loop.ts";

const created: string[] = [];
process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory removed when the test process exits. */
export function tempDir(prefix = "agent-test-"): string {
  const dir = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function put(root: string, rel: string, content: string, executable = false) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (executable) chmodSync(file, 0o755);
  return file;
}

export const noWarn = (w: string) => {
  throw new Error(`unexpected warning: ${w}`);
};

/** A scripted reply: SSE chunks, or an HTTP error. */
export type Reply = object[] | { status: number; body: object };

/** Fake OpenAI-compatible server: replies with scripted SSE streams and records each request body. */
export async function fakeServer(script: Reply[], nCtx = 100_000) {
  const requests: any[] = [];
  const headers: IncomingMessage["headers"][] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ default_generation_settings: { n_ctx: nCtx } }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    headers.push(req.headers);
    const reply = script[requests.length - 1] ?? [{ choices: [{ delta: { content: "(script exhausted)" } }] }];
    if (!Array.isArray(reply)) {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const c of reply) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, headers, close: () => server.close() };
}

export const text = (content: string): Reply => [{ choices: [{ delta: { content } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];

export const call = (name: string, args: object, id = `c_${name}_${Math.random().toString(36).slice(2, 7)}`): Reply => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];

export const silentUI = (log: string[], extra: Partial<AgentUI> = {}): AgentUI => ({
  onText: () => {},
  onToolStart: (n) => log.push(`start ${n}`),
  onToolEnd: (n, _r, isError) => log.push(`end ${n}${isError ? " ERROR" : ""}`),
  onInfo: (m) => log.push(`info ${m}`),
  confirm: async () => "yes",
  ...extra,
});
