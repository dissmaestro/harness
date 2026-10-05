import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { call, fakeServer, tempDir, text } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

function run(args: string[], input?: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const home = tempDir();
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, AGENT_BASE_URL: "", AGENT_MODEL: "", NO_COLOR: "1", ...env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.stdin?.end(input);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

test("cli: --version and --help", async () => {
  const version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version;
  for (const flag of ["--version", "-v"]) {
    const r = await run([flag]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), version);
  }
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--max-steps/);
});

test("cli: argument errors", async () => {
  const r = await run(["-p"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /-p needs a prompt/);
  const steps = await run(["-p", "hi", "--max-steps", "zero"]);
  assert.equal(steps.code, 1);
  assert.match(steps.stderr, /--max-steps/);
});

test("cli: -p joins positional words and appends piped stdin", async () => {
  const srv = await fakeServer([text("explained")]);
  try {
    const r = await run(["-p", "explain", "this", "--base-url", srv.url, "--max-steps", "3"], "line 1\nline 2\n");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /explained/);
    const sent = JSON.stringify(srv.requests[0].messages);
    assert.ok(sent.includes("explain this\\n\\n<stdin>\\nline 1\\nline 2\\n</stdin>"), sent);
  } finally {
    srv.close();
  }
});

test("cli: --api-key is sent as a bearer token; -p reports context usage on stderr", async () => {
  const srv = await fakeServer([text("ok")]);
  try {
    const r = await run(["-p", "hi", "--base-url", srv.url, "--api-key", "sk-test"], undefined, { AGENT_API_KEY: "" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(srv.headers[0].authorization, "Bearer sk-test");
    assert.doesNotMatch(r.stdout, /ctx/);
    assert.match(r.stderr, /ctx [\d.]+k?\/100k \(\d+%\)/);
  } finally {
    srv.close();
  }
});

test("cli: -p --json prints one result object; stream-json prints events then the result", async () => {
  const srv = await fakeServer([call("Write", { file_path: "out.txt", content: "hi\n" }), text("wrote it")]);
  try {
    const r = await run(["-p", "write a file", "--base-url", srv.url, "--accept-edits", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    assert.equal(res.type, "result");
    assert.equal(res.ok, true);
    assert.equal(res.answer, "wrote it");
    assert.deepEqual(res.filesChanged, [{ path: "out.txt", status: "A", added: 1, removed: 0 }]);
    assert.equal(res.toolCalls[0].name, "Write");
    assert.equal(res.toolCalls[0].ok, true);
    assert.equal(res.steps, 2);
  } finally {
    srv.close();
  }
  const srv2 = await fakeServer([call("Bash", { command: "rm -rf build" }), text("could not")]);
  try {
    const r = await run(["-p", "clean", "--base-url", srv2.url, "--output-format", "stream-json"]);
    const events = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual([...new Set(events.map((e) => e.type))], ["tool_start", "denied", "tool_end", "text", "result"]);
    assert.equal(events.at(-1).denied.length, 1);
  } finally {
    srv2.close();
  }
  const bad = await run(["--json"]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /works with -p/);
});
