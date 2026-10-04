import type { Settings } from "../core/settings.ts";
import type { Message, Tool, ToolCall } from "../types.ts";

export interface ChatRequest {
  messages: Message[];
  tools: Tool[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  maxTokens?: number;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

/** llama-server extension: per-request speed and cache statistics */
export interface Timings {
  prompt_n: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_per_second: number;
  cache_n?: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  timings?: Timings;
  finishReason?: string;
}

export function toolSpec(t: Tool) {
  return { type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } };
}

/** Streaming chat completion against any OpenAI-compatible server. */
export async function chat(settings: Settings, req: ChatRequest): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: req.messages,
    tools: req.tools.map(toolSpec),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (settings.temperature !== undefined) body.temperature = settings.temperature;
  if (req.maxTokens ?? settings.maxTokens) body.max_tokens = req.maxTokens ?? settings.maxTokens;

  const res = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: req.signal,
    headers: {
      "content-type": "application/json",
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM request failed: HTTP ${res.status} ${text.slice(0, 2000)}`);
  }

  let content = "";
  const calls: ToolCall[] = [];
  let usage: Usage | undefined;
  let timings: Timings | undefined;
  let finishReason: string | undefined;

  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw new Error(`LLM error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
    if (chunk.usage) usage = chunk.usage;
    if (chunk.timings) timings = chunk.timings;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) req.onReasoning?.(reasoning);
    if (delta.content) {
      content += delta.content;
      req.onText?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? calls.length;
      calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].function.name += tc.function.name;
      if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf.trim());

  const toolCalls = calls
    .filter((c) => c && c.function.name)
    .map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
  return { content, toolCalls, usage, timings, finishReason };
}

export function isContextOverflow(e: unknown): boolean {
  return /exceed_context_size|exceeds the available context|context length|maximum context|too many tokens/i.test(String((e as Error)?.message ?? e));
}

/** llama-server reports its context size at /props; other servers don't, then the caller uses a default. */
export async function fetchContextWindow(baseUrl: string, apiKey?: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "")}/props`, {
      signal: AbortSignal.timeout(5000),
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) return undefined;
    const props = await res.json();
    const n = props?.default_generation_settings?.n_ctx ?? props?.n_ctx;
    return typeof n === "number" && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}
