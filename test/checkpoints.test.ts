import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/core/loop.ts";
import { loadSettings } from "../src/core/settings.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { call, fakeServer, noWarn, silentUI, tempDir, text } from "./helpers.ts";

test("checkpoints before Write and Bash; files (Bash changes included) and the conversation can be restored", async () => {
  const srv = await fakeServer([
    call("Write", { file_path: "a.txt", content: "one\n" }),
    call("Bash", { command: "echo two > b.txt && echo changed > keep.txt" }),
    text("done"),
  ]);
  try {
    const cwd = tempDir();
    const home = tempDir();
    writeFileSync(join(cwd, "keep.txt"), "original\n");
    writeFileSync(join(cwd, ".gitignore"), "build/\n");
    mkdirSync(join(cwd, "build"));
    writeFileSync(join(cwd, "build", "out.bin"), "ignored\n");
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url, permissionMode: "auto" as const };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    await agent.send("make files", silentUI([]), new AbortController().signal);

    const list = agent.checkpoints!.list;
    assert.deepEqual(list.map((c) => c.before), ["Write(a.txt)", "Bash(echo two > b.txt && echo changed > keep.txt)"]);
    assert.equal(list[0].turn, "make files");
    assert.deepEqual((await agent.checkpoints!.changedSince(list[0])).sort(), [["A", "a.txt"], ["A", "b.txt"], ["M", "keep.txt"]]);

    // back to before the first change: the Bash command's files are restored too
    const r = await agent.restore(1, "files");
    assert.deepEqual(r.removed.sort(), ["a.txt", "b.txt"]);
    assert.deepEqual(r.restored, ["keep.txt"]);
    assert.ok(!existsSync(join(cwd, "a.txt")) && !existsSync(join(cwd, "b.txt")));
    assert.equal(readFileSync(join(cwd, "keep.txt"), "utf8"), "original\n");
    assert.equal(readFileSync(join(cwd, "build", "out.bin"), "utf8"), "ignored\n", ".gitignore'd files are left alone");

    // the restore made its own checkpoint: restoring that one undoes the restore
    const undo = agent.checkpoints!.list.at(-1)!;
    assert.match(undo.before, /restore to #1/);
    await agent.restore(undo.n, "files");
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(cwd, "keep.txt"), "utf8"), "changed\n");

    // conversation: back to before the turn
    assert.ok(agent.messages.length > 3);
    await agent.restore(1, "chat");
    assert.equal(agent.messages.length, 1);
    assert.equal(agent.messages[0].role, "system");
    assert.ok(existsSync(join(cwd, "a.txt")), "chat-only restore keeps the files");
  } finally {
    srv.close();
  }
});

test("read-only commands and reads take no checkpoint; checkpoints can be turned off", async () => {
  const srv = await fakeServer([call("Bash", { command: "ls" }), call("Read", { file_path: "x" }), text("ok"), call("Write", { file_path: "y", content: "y" }), text("ok")]);
  try {
    const cwd = tempDir();
    const home = tempDir();
    writeFileSync(join(cwd, "x"), "x\n");
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url, permissionMode: "auto" as const };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    await agent.send("look", silentUI([]), new AbortController().signal);
    assert.equal(agent.checkpoints!.list.length, 0);
    const off = new Agent({ cwd, settings: { ...settings, checkpoints: false }, registry, home });
    await off.send("write", silentUI([]), new AbortController().signal);
    assert.equal(off.checkpoints, undefined);
  } finally {
    srv.close();
  }
});

test("fork: a new session that starts as a copy; the original is kept and listed as its parent", async () => {
  const srv = await fakeServer([text("first answer"), text("on the fork")]);
  try {
    const cwd = tempDir();
    const home = tempDir();
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home, persist: true });
    await agent.send("start", silentUI([]), new AbortController().signal);
    const original = agent.journal!.id;
    const { from, to } = agent.fork("try b");
    assert.equal(from, original);
    await agent.send("continue on the fork", silentUI([]), new AbortController().signal);
    const { listSessions, readSession } = await import("../src/core/sessions.ts");
    const all = listSessions(cwd, home);
    const fork = all.find((s) => s.id === to)!;
    const orig = all.find((s) => s.id === original)!;
    assert.equal(fork.parent, original);
    assert.equal(fork.label, "try b");
    assert.equal(readSession(orig.file).filter((m) => m.role === "user").length, 1, "the original is untouched");
    assert.equal(readSession(fork.file).filter((m) => m.role === "user").length, 2);
  } finally {
    srv.close();
  }
});
