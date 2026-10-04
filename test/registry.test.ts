import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildSystemPrompt } from "../src/core/context.ts";
import { loadSettings as loadSettingsFull } from "../src/core/settings.ts";
const loadSettings = (cwd: string, home: string) => ({ ...loadSettingsFull(cwd, home), builtins: false });
import { toolSpec } from "../src/providers/openai.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { parseFrontmatter } from "../src/registry/loaders/frontmatter.ts";
import { parseScriptHeader } from "../src/registry/loaders/scripts.ts";
import { expandCommand } from "../src/registry/loaders/skills.ts";
import { search } from "../src/registry/search.ts";
import type { ToolContext } from "../src/types.ts";
import { noWarn, put, tempDir } from "./helpers.ts";

function setup() {
  const home = tempDir();
  const cwd = tempDir();
  return { home, cwd, settings: loadSettings(cwd, home) };
}

const ctxFor = (cwd: string, registry: any): ToolContext => ({
  cwd,
  registry,
  signal: new AbortController().signal,
  readFiles: new Map(),
});

test("frontmatter: quoted, folded and plain values", () => {
  const { data, body } = parseFrontmatter(`---\nname: "x"\ndescription: >\n  first line\n  second line\nother: y\n---\nBody`);
  assert.equal(data.name, "x");
  assert.equal(data.description, "first line second line");
  assert.equal(data.other, "y");
  assert.equal(body, "Body");
});

test("skills: .agent and .claude dirs, project overrides user", async () => {
  const { home, cwd, settings } = setup();
  put(home, ".claude/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: user pdf skill\n---\nuser body");
  put(home, ".agent/skills/deploy/SKILL.md", "---\ndescription: deploy things\n---\nsteps");
  put(cwd, ".agent/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: project pdf skill\n---\nproject body");
  const reg = await loadRegistry(cwd, settings, noWarn, home);
  assert.deepEqual([...reg.skills.keys()].sort(), ["deploy", "pdf"]);
  assert.equal(reg.skills.get("pdf")!.description, "project pdf skill");
  const out = await reg.core.get("Skill")!.run({ skill: "pdf", args: "a.pdf" }, ctxFor(cwd, reg));
  assert.match(out, /project body/);
  assert.match(out, /ARGUMENTS: a\.pdf/);
  assert.doesNotMatch(out, /description:/, "frontmatter is stripped");
});

test("claudeCompat=false ignores .claude", async () => {
  const { home, cwd, settings } = setup();
  put(cwd, ".claude/skills/x/SKILL.md", "---\ndescription: d\n---\n");
  settings.claudeCompat = false;
  const reg = await loadRegistry(cwd, settings, noWarn, home);
  assert.equal(reg.skills.size, 0);
});

test("script header becomes a schema", () => {
  const meta = parseScriptHeader(
    "#!/bin/bash\n# @name: db-migrate\n# @description: Create migration\n# @tags: db, sql\n# @arg name: string (required) — the name\n# @arg dry: boolean — dry run\necho",
    "fallback",
  )!;
  assert.equal(meta.name, "db-migrate");
  assert.deepEqual(meta.tags, ["db", "sql"]);
  assert.deepEqual(meta.args, [
    { name: "name", type: "string", required: true, description: "the name" },
    { name: "dry", type: "boolean", required: false, description: "dry run" },
  ]);
  assert.equal(parseScriptHeader("#!/bin/bash\necho hi", "x"), undefined, "no @description -> not a tool");
});

test("deferred tool: refused before ToolSearch, callable after", async () => {
  const { home, cwd, settings } = setup();
  put(
    cwd,
    ".agent/scripts/hello.sh",
    "#!/usr/bin/env bash\n# @description: Say hello\n# @arg who: string (required) — name\necho \"hello $1 $ARG_WHO\"\n",
    true,
  );
  const reg = await loadRegistry(cwd, settings, noWarn, home);
  assert.ok(reg.deferred.has("hello"));
  assert.ok(!reg.core.has("hello"));
  assert.match(reg.resolve("hello").error!, /ToolSearch.*select:hello/);

  const found = await reg.core.get("ToolSearch")!.run({ query: "select:hello" }, ctxFor(cwd, reg));
  assert.match(found, /<functions>/);
  const fn = JSON.parse(found.match(/<function>(.*)<\/function>/)![1]);
  assert.deepEqual(fn.parameters.required, ["who"]);

  const { tool } = reg.resolve("hello");
  assert.ok(tool);
  assert.equal(await tool.run({ who: "max" }, ctxFor(cwd, reg)), "hello max max");
});

test("search: BM25 ranks by name/tags/description, +word filters by name", () => {
  const items = [
    { name: "db-migrate", description: "Create a new SQL migration", tags: ["database", "schema"] },
    { name: "deploy-staging", description: "Deploy the app to staging" },
    { name: "mcp__github__create_issue", description: "Create a GitHub issue" },
    { name: "mcp__linear__create_issue", description: "Create a Linear issue" },
    { name: "screenshot", description: "Take a browser screenshot" },
    { name: "todo-list", description: "List TODO comments" },
  ];
  assert.equal(search(items, "database migration")[0].name, "db-migrate");
  assert.equal(search(items, "migrations")[0].name, "db-migrate", "stem match");
  assert.equal(search(items, "deploy")[0].name, "deploy-staging");
  assert.deepEqual(
    search(items, "+github issue").map((i) => i.name),
    ["mcp__github__create_issue"],
  );
  assert.deepEqual(search(items, "kubernetes"), []);
});

test("commands: $ARGUMENTS and positional expansion", () => {
  assert.equal(expandCommand("Review $1 then $2", "a b"), "Review a then b");
  assert.equal(expandCommand("Focus: $ARGUMENTS", "security only"), "Focus: security only");
  assert.equal(expandCommand("Do it", "now"), "Do it\n\nARGUMENTS: now");
});

test("context budget: 25 skills + 25 deferred tools", async () => {
  const { home, cwd, settings } = setup();
  for (let i = 0; i < 25; i++) {
    put(cwd, `.agent/skills/skill-${i}/SKILL.md`, `---\ndescription: ${"Does a specific workflow step number " + i + " for the project when asked. ".repeat(3)}\n---\n${"long body ".repeat(500)}`);
    put(cwd, `.agent/scripts/tool-${i}.sh`, `# @description: ${"Script tool number " + i + " with a long description. ".repeat(5)}\n# @arg x: string (required) — ${"arg ".repeat(50)}\n`);
  }
  const reg = await loadRegistry(cwd, settings, noWarn, home);
  const system = buildSystemPrompt(cwd, settings, home);
  const tools = JSON.stringify([...reg.core.values()].map(toolSpec));
  const catalog = reg.catalog();
  const est = (s: string) => Math.ceil(s.length / 4);
  const total = est(system) + est(tools) + est(catalog);
  console.log(`  system ${est(system)} + core tool schemas ${est(tools)} + catalog ${est(catalog)} = ~${total} tokens`);
  assert.doesNotMatch(catalog, /long body/, "skill bodies are not in context");
  assert.doesNotMatch(catalog, /arg arg/, "deferred schemas are not in context");
  assert.ok(est(catalog) < 1500, `catalog too big: ${est(catalog)}`);
  assert.ok(total < 4000, `always-on context too big: ${total}`);
});

test("example demo project loads without warnings", async () => {
  const demo = join(import.meta.dirname, "..", "examples", "demo");
  const home = tempDir();
  const settings = loadSettings(demo, home);
  const reg = await loadRegistry(demo, settings, noWarn, home);
  assert.deepEqual([...reg.skills.keys()], ["commit"]);
  assert.deepEqual([...reg.deferred.keys()].sort(), ["db-migrate", "todo-list"]);
  assert.equal(reg.deferred.get("todo-list")!.kind, "read");
  assert.ok(reg.commands.has("review"));
  assert.ok(readFileSync(join(demo, ".agent/settings.json"), "utf8").includes("PostToolUse"));
});
