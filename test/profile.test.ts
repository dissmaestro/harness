import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/core/loop.ts";
import { profileName, resolveRequest } from "../src/core/profile.ts";
import { loadSettings } from "../src/core/settings.ts";
import { splitThinking, wireMessages } from "../src/providers/openai.ts";
import { stripThinking } from "../src/providers/toolcall-parse.ts";
import { loadRegistry } from "../src/registry/load.ts";
import type { Message } from "../src/types.ts";
import { fakeServer, noWarn, silentUI, tempDir, text } from "./helpers.ts";

const base = () => loadSettings(tempDir(), tempDir());

test("profiles: Qwen3.6 sampling and thinking switches; quick roles run without thinking", () => {
  const s = { ...base(), model: "qwen3.6" };
  assert.equal(profileName(s), "qwen3.6");
  const main = resolveRequest(s);
  assert.deepEqual(main.sampling, { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0 });
  assert.deepEqual(main.chatTemplateKwargs, { enable_thinking: true, preserve_thinking: true });
  assert.equal(main.preserve, "turn");
  const compact = resolveRequest(s, "compact");
  assert.deepEqual(compact.chatTemplateKwargs, { enable_thinking: false });
  assert.deepEqual(compact.sampling, { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5 });
  assert.equal(compact.preserve, "off");
  assert.deepEqual(resolveRequest(s, "explore").chatTemplateKwargs, { enable_thinking: true, preserve_thinking: true });
});

test("profiles: an alias needs the profile set; settings and roles override the profile", () => {
  const alias = { ...base(), model: "smart" };
  assert.equal(profileName(alias), "none");
  const plain = resolveRequest(alias);
  assert.deepEqual(plain.sampling, {});
  assert.equal(plain.chatTemplateKwargs, undefined, "nothing extra is sent without a profile");
  const s = {
    ...alias,
    profile: "qwen3.6",
    temperature: 0.3,
    thinking: { preserve: "all" as const },
    roles: { explore: { thinking: false, model: "small", baseUrl: "http://other/v1" } },
  };
  assert.equal(resolveRequest(s).sampling.temperature, 0.3);
  assert.equal(resolveRequest(s).preserve, "all");
  const explore = resolveRequest(s, "explore");
  assert.equal(explore.model, "small");
  assert.equal(explore.baseUrl, "http://other/v1");
  assert.deepEqual(explore.chatTemplateKwargs, { enable_thinking: false });
  assert.equal(profileName({ model: "Qwen3-Coder-30B", profile: undefined }), "qwen3");
});

test("reasoning goes back only for the current task (turn) or everywhere (all)", () => {
  const msgs: Message[] = [
    { role: "system", content: "s" },
    { role: "user", content: "old task" },
    { role: "assistant", content: "old", reasoning: "old thoughts" },
    { role: "user", content: "new task" },
    { role: "assistant", content: null, tool_calls: [], reasoning: "plan" },
    { role: "user", content: "<system-reminder>\nverify failed\n</system-reminder>" },
    { role: "assistant", content: "fixing", reasoning: "fix it" },
  ];
  const turn = wireMessages(msgs, "turn") as any[];
  assert.equal(turn[2].reasoning_content, undefined);
  assert.equal("reasoning" in turn[2], false);
  assert.equal(turn[4].reasoning_content, "plan");
  assert.equal(turn[4].reasoning, "plan");
  assert.equal(turn[6].reasoning_content, "fix it", "reminders don't start a new task");
  assert.equal((wireMessages(msgs, "all") as any[])[2].reasoning_content, "old thoughts");
  assert.ok((wireMessages(msgs, "off") as any[]).every((m) => !("reasoning" in m) && !("reasoning_content" in m)));
});

test("thinking split: <think> blocks and a lone </think> (the template opened the tag)", () => {
  assert.deepEqual(splitThinking("<think>a</think>\nanswer"), { text: "answer", thinking: "a" });
  assert.deepEqual(splitThinking("let me see\n</think>\n\nanswer"), { text: "answer", thinking: "let me see" });
  assert.equal(stripThinking("reasoning here</think>Done."), "Done.");
  assert.equal(stripThinking("plain answer"), "plain answer");
});

test("end to end: Qwen3.6 request body, reasoning replayed within the task, dropped for the next one", async () => {
  const srv = await fakeServer([
    [{ choices: [{ delta: { reasoning_content: "I should read a.txt" } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "Glob", arguments: '{"pattern":"*"}' } }] } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }],
    text("found nothing"),
    text("second task done"),
  ]);
  try {
    const cwd = tempDir();
    const home = tempDir();
    const settings = { ...loadSettings(cwd, home), baseUrl: srv.url, model: "qwen3.6", repoMap: false as const };
    const registry = await loadRegistry(cwd, settings, noWarn, home);
    const agent = new Agent({ cwd, settings, registry, home });
    await agent.send("list files", silentUI([]), new AbortController().signal);
    await agent.send("next", silentUI([]), new AbortController().signal);
    const [r1, r2, r3] = srv.requests;
    assert.deepEqual(r1.chat_template_kwargs, { enable_thinking: true, preserve_thinking: true });
    assert.equal(r1.top_k, 20);
    assert.equal(r1.temperature, 0.6);
    const asst2 = r2.messages.find((m: any) => m.role === "assistant");
    assert.equal(asst2.reasoning_content, "I should read a.txt");
    assert.equal(asst2.reasoning, "I should read a.txt");
    const asst3 = r3.messages.find((m: any) => m.role === "assistant" && m.tool_calls);
    assert.equal(asst3.reasoning_content, undefined, "the previous task's thinking is not sent again");
  } finally {
    srv.close();
  }
});
