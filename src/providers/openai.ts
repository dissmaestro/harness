import { resolveRequest } from "../core/profile.ts";
import type { Settings } from "../core/settings.ts";
import type { Message, Tool, ToolCall } from "../types.ts";

export interface ChatRequest {
  messages: Message[];
  tools: Tool[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  maxTokens?: number;
  /** whose request this is: "main", "compact", "aside" or a subagent type (settings.roles) */
  role?: string;
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
  /** the model's thinking: the server's reasoning field, or the <think> part of the content */
  reasoning: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  timings?: Timings;
  finishReason?: string;
}

/** settings.retry: how hard to try before giving up on the model server */
export interface RetryConfig {
  /** keep retrying for this long (seconds); 0 disables retries */
  maxSeconds: number;
  /** abort if the first byte takes longer than this (prompt processing of a long context can be slow) */
  firstByteSeconds: number;
  /** abort if the stream stalls for this long between chunks */
  idleSeconds: number;
}

export const DEFAULT_RETRY: RetryConfig = { maxSeconds: 300, firstByteSeconds: 900, idleSeconds: 180 };

/** A request error, with whatever was streamed before it happened. */
export class ChatError extends Error {
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
  partial: string;
  constructor(message: string, opts: { retryable: boolean; status?: number; retryAfterMs?: number; partial?: string }) {
    super(message);
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.partial = opts.partial ?? "";
  }
}

export function toolSpec(t: Tool) {
  return { type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } };
}

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const NETWORK_ERROR = /fetch failed|terminated|socket|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR|other side closed|premature close/i;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(signal!.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** llama-server answers /health with 503 while it loads the model; wait until it is ready (or there is nothing to ask). */
async function waitForHealth(settings: Settings, deadline: number, signal?: AbortSignal): Promise<void> {
  const url = `${settings.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "")}/health`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) });
      if (res.ok || res.status === 404) return; // 404: the server has no /health (Ollama, vLLM…): just retry the request
    } catch {
      if (signal?.aborted) throw signal.reason;
    }
    await sleep(2000, signal);
  }
}

/**
 * Streaming chat completion that survives a flaky server: retries network errors, 429/5xx, stalled and
 * cut-off streams with exponential backoff, and waits for llama-server to finish loading a model.
 * `onRetry` reports each attempt; text streamed by a failed attempt is regenerated from scratch.
 */
export async function chat(settings: Settings, req: ChatRequest & { onRetry?: (message: string) => void }): Promise<ChatResult> {
  const cfg = { ...DEFAULT_RETRY, ...(settings as Settings & { retry?: Partial<RetryConfig> }).retry };
  const deadline = Date.now() + cfg.maxSeconds * 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await chatOnce(settings, req, cfg);
    } catch (e) {
      if (req.signal?.aborted) throw e;
      const err = e instanceof ChatError ? e : new ChatError((e as Error).message, { retryable: NETWORK_ERROR.test(String((e as Error).message) + String((e as any)?.cause?.code ?? "")) });
      if (!err.retryable || Date.now() >= deadline) throw err;
      const delay = Math.min(err.retryAfterMs ?? 1000 * 2 ** (attempt - 1), 30_000) * (0.8 + Math.random() * 0.4);
      const why = err.status ? `HTTP ${err.status}` : err.message.replace(/^LLM request failed: /, "").slice(0, 80);
      req.onRetry?.(`Model server problem (${why}); retry ${attempt} in ${Math.round(delay / 1000)}s…${err.partial ? " (the partial answer will be regenerated)" : ""}`);
      await sleep(delay, req.signal);
      if (!err.status) await waitForHealth(settings, deadline, req.signal);
    }
  }
}

/** One streaming request. Throws ChatError (retryable or not) with the partial content streamed so far. */
/**
 * The messages as sent: an assistant message's reasoning goes back to the server (as reasoning_content
 * for llama.cpp/older vLLM and reasoning for vLLM ≥ 0.20) only where the profile preserves thinking:
 * "turn" = after the user's latest real message, "all" = everywhere. Elsewhere it is dropped.
 */
export function wireMessages(messages: Message[], preserve: "turn" | "all" | "off"): unknown[] {
  let lastTask = -1;
  if (preserve === "turn") {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user" && !String(m.content).startsWith("<system-reminder>")) {
        lastTask = i;
        break;
      }
    }
  }
  return messages.map((m, i) => {
    if (m.role !== "assistant" || m.reasoning === undefined) return m;
    const { reasoning, ...rest } = m;
    const keep = reasoning && (preserve === "all" || (preserve === "turn" && i > lastTask));
    return keep ? { ...rest, reasoning_content: reasoning, reasoning } : rest;
  });
}

/** Splits "<think>…</think>answer" (or "…</think>answer" when the template opened the tag itself). */
export function splitThinking(content: string): { text: string; thinking: string } {
  const end = content.lastIndexOf("</think>");
  if (end < 0) return { text: content, thinking: "" };
  const thinking = content.slice(0, end).replace(/<\/?think>/g, "").trim();
  return { text: content.slice(end + "</think>".length).trim(), thinking };
}

async function chatOnce(settings: Settings, req: ChatRequest, cfg: RetryConfig): Promise<ChatResult> {
  const r = resolveRequest(settings, req.role);
  const body: Record<string, unknown> = {
    ...r.extraBody,
    model: r.model,
    messages: wireMessages(req.messages, r.preserve),
    // OpenAI rejects an empty tools array
    ...(req.tools.length && { tools: req.tools.map(toolSpec) }),
    stream: true,
    stream_options: { include_usage: true },
  };
  for (const [k, v] of Object.entries(r.sampling)) if (v !== undefined) body[k] = v;
  if (r.chatTemplateKwargs) body.chat_template_kwargs = { ...(r.extraBody?.chat_template_kwargs as object), ...r.chatTemplateKwargs };
  if (req.maxTokens ?? r.maxTokens) body.max_tokens = req.maxTokens ?? r.maxTokens;

  // Our own watchdog: the first byte may take long (prompt processing), but a stream must not stall.
  const watchdog = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stalled = "";
  const arm = (seconds: number, what: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = what;
      watchdog.abort(new Error(what));
    }, seconds * 1000);
  };
  arm(cfg.firstByteSeconds, `no response from the model server for ${cfg.firstByteSeconds}s`);
  const signal = req.signal ? AbortSignal.any([req.signal, watchdog.signal]) : watchdog.signal;
  // Errors caused by our watchdog are retryable; errors caused by the user's abort are passed through.
  const wrap = (e: unknown, partial: string): never => {
    if (req.signal?.aborted) {
      if (partial && e && typeof e === "object") (e as { partial?: string }).partial = partial;
      throw e;
    }
    if (e instanceof ChatError) throw e;
    if (stalled) throw new ChatError(stalled, { retryable: true, partial });
    const msg = (e as Error)?.message ?? String(e);
    const code = String((e as any)?.cause?.code ?? (e as any)?.cause?.message ?? "");
    throw new ChatError(`LLM request failed: ${msg}${code ? ` (${code})` : ""}`, { retryable: NETWORK_ERROR.test(msg + " " + code), partial });
  };

  let res: Response;
  try {
    res = await fetch(`${r.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        ...(r.apiKey ? { authorization: `Bearer ${r.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    clearTimeout(timer);
    return wrap(e, "");
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new ChatError(`LLM request failed: HTTP ${res.status} ${text.slice(0, 2000)}`, {
      retryable: RETRY_STATUS.has(res.status) && !isContextOverflow(text),
      status: res.status,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    });
  }

  let content = "";
  let reasoningText = "";
  const calls: ToolCall[] = [];
  let usage: Usage | undefined;
  let timings: Timings | undefined;
  let finishReason: string | undefined;

  let done = false;
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") done = true;
    if (!data || data === "[DONE]") return;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) {
      const message = chunk.error.message ?? JSON.stringify(chunk.error);
      throw new ChatError(`LLM error: ${message}`, { retryable: !isContextOverflow(message) && /unavailable|overload|busy|loading|timeout|internal/i.test(message), partial: content });
    }
    if (chunk.usage) usage = chunk.usage;
    if (chunk.timings) timings = chunk.timings;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) {
      reasoningText += reasoning;
      req.onReasoning?.(reasoning);
    }
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
  try {
    for await (const chunk of res.body) {
      arm(cfg.idleSeconds, `the model server stopped streaming for ${cfg.idleSeconds}s`);
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      }
    }
    handle(buf.trim());
  } catch (e) {
    wrap(e, content);
  } finally {
    clearTimeout(timer);
  }
  // The connection closed without [DONE] or a finish reason: the server died mid-answer.
  if (!done && !finishReason) throw new ChatError("the model server closed the stream mid-answer", { retryable: true, partial: content });

  const toolCalls = calls
    .filter((c) => c && c.function.name)
    .map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
  const inline = splitThinking(content);
  return { content, reasoning: reasoningText || inline.thinking, toolCalls, usage, timings, finishReason };
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
