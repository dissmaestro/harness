import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/core/loop.ts";
import { buildRepoMap, extractSymbols } from "../src/core/repomap.ts";
import { loadSettings } from "../src/core/settings.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { call, fakeServer, noWarn, silentUI, tempDir, text } from "./helpers.ts";

const texts = (path: string, src: string) => extractSymbols(path, src).map((s) => `${s.member ? "  " : ""}${s.line}: ${s.text}`);

test("symbols: TypeScript, Python, Go, Rust", () => {
  assert.deepEqual(
    texts("a.ts", "export class Store {\n  get(key: string, opts: Record<string, number> = {}): number {\n    if (x) {\n  }\n  private hide() {\n  }\n}\nexport function load(path: string): Store {\n}\nexport interface Opts {}\nconst helper = async (a: number) => a;\n"),
    ["1: class Store", "  2: get(key, opts)", "8: function load(path)", "10: interface Opts", "11: const helper(a)"],
  );
  assert.deepEqual(texts("a.py", "class Repo(Base):\n    def __init__(self, path):\n        pass\n    def _private(self):\n        pass\n    def find(self, q, limit=10):\n        pass\n\ndef main(argv):\n    pass\n"), [
    "1: class Repo",
    "  2: __init__(path)",
    "  6: find(q, limit=10)",
    "9: def main(argv)",
  ]);
  assert.deepEqual(texts("a.go", "type Server struct {\n}\nfunc (s *Server) Start(ctx context.Context) error {\n}\nfunc New(addr string) *Server {\n}\n"), [
    "1: type Server struct",
    "3: func (Server) Start(ctx)",
    "5: func New(addr)",
  ]);
  assert.deepEqual(texts("a.rs", "pub struct Cache {}\nimpl Cache {\n    pub fn get(&self, key: &str) -> Option<String> {\n    }\n}\npub fn open(path: &Path) -> Cache {\n}\n"), [
    "1: struct Cache",
    "2: impl Cache",
    "  3: fn get(key)",
    "6: fn open(path)",
  ]);
});

test("the map puts the most referenced files first and respects the budget", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "src", "core.ts"), "export class CoreEngine {\n  start() {\n  }\n}\n");
  writeFileSync(join(dir, "src", "util.ts"), "export function rarelyUsedHelper() {}\n");
  for (const n of ["a", "b", "c"]) writeFileSync(join(dir, "src", `${n}.ts`), `import { CoreEngine } from "./core";\nexport function use${n.toUpperCase()}Thing() { new CoreEngine(); }\n`);
  writeFileSync(join(dir, "test", "core.test.ts"), "export function testCoreEngineWorks() { CoreEngine; }\n");
  const map = buildRepoMap(dir, { tokens: 1000 });
  assert.ok(map.startsWith("src/core.ts:\n  1: class CoreEngine\n    2: start()"), map);
  assert.ok(map.indexOf("src/util.ts") > map.indexOf("src/core.ts"));
  const tiny = buildRepoMap(dir, { tokens: 20 });
  assert.ok(tiny.length <= 20 * 3.5 + 60, tiny);
  assert.match(tiny, /more files with symbols not shown/);
  assert.equal(buildRepoMap(tempDir(), { tokens: 1000 }), "", "no source files, no map");
});

test("the map goes into the first message of a conversation and to code-reading subagents only", async () => {
  const srv = await fakeServer([
    call("Agent", { subagent_type: "explore", prompt: "look" }),
    text("explored"),
    call("Agent", { subagent_type: "web-researcher", prompt: "search" }),
    text("searched"),
    text("done"),
    text("second turn"),
  ]);
  try {
    const cwd = tempDir();
    const home = tempDir();
    writeFileSync(join(cwd, "main.py"), "def entry(argv):\n    pass\n");
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    await agent.send("go", silentUI([]), new AbortController().signal);
    await agent.send("again", silentUI([]), new AbortController().signal);
    const firstUser = (i: number) => String(srv.requests[i].messages.find((m: any) => m.role === "user").content);
    assert.match(firstUser(0), /Repository map:[\s\S]*main\.py:\n  1: def entry\(argv\)/);
    assert.match(firstUser(1), /Repository map:/, "explore gets the map");
    assert.doesNotMatch(firstUser(3), /Repository map:/, "web-researcher does not");
    const lastReq = srv.requests.at(-1).messages.filter((m: any) => m.role === "user");
    assert.doesNotMatch(String(lastReq.at(-1).content), /Repository map:/, "later turns don't repeat it");
  } finally {
    srv.close();
  }
});
