import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeServer, tempDir, text } from "./helpers.ts";

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
