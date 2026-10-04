/**
 * Local models often emit tool calls as plain text that the server doesn't recognise,
 * or produce slightly broken JSON. This module recovers both.
 */

export interface TextToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** JSON.parse that tolerates code fences, surrounding prose, trailing commas and unclosed brackets. */
export function parseJsonLenient(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {}
  let s = input.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.search(/[{[]/);
  if (start > 0) s = s.slice(start);
  s = s.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(s);
  } catch {}
  return JSON.parse(closeBrackets(s));
}

function scanBrackets(s: string): { stack: string[]; inString: boolean } {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  return { stack, inString };
}

function closeBrackets(s: string): string {
  const { stack, inString } = scanBrackets(s);
  let out = inString ? s + '"' : s;
  out = out.replace(/,\s*$/, "");
  return out + stack.reverse().join("");
}

/** true when the JSON text ends inside a string or with unclosed brackets, i.e. it was cut off rather than just sloppy */
export function looksTruncated(input: string): boolean {
  const s = input.trim();
  if (!s) return false;
  try {
    JSON.parse(s);
    return false;
  } catch {}
  const { stack, inString } = scanBrackets(s.slice(Math.max(0, s.search(/[{[]/))));
  return inString || stack.length > 0;
}

function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") raw = raw.trim() ? parseJsonLenient(raw) : {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

/** Qwen3-Coder style: <function=name><parameter=key>value</parameter></function> */
function parseXmlFunction(body: string): TextToolCall | undefined {
  const fn = body.match(/<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/);
  if (!fn) return undefined;
  const args: Record<string, unknown> = {};
  for (const p of fn[2].matchAll(/<parameter=([^>\s]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g)) {
    args[p[1]] = p[2].replace(/^\n/, "").replace(/\n$/, "");
  }
  return { name: fn[1], arguments: args };
}

/** Hermes / Qwen2.5 style JSON: {"name": ..., "arguments": {...}} */
function parseJsonCall(body: string): TextToolCall | undefined {
  try {
    const obj = parseJsonLenient(body) as Record<string, any>;
    const name = obj?.name ?? obj?.function?.name;
    if (typeof name !== "string") return undefined;
    return { name, arguments: normalizeArgs(obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? {}) };
  } catch {
    return undefined;
  }
}

/**
 * Extracts tool calls written as text. Recognises <tool_call>…</tool_call> (JSON or XML inside),
 * bare <function=…> blocks, and ```json fences whose "name" is a known tool.
 * Returns the calls and the text with them removed.
 */
export function extractTextToolCalls(text: string, knownNames: Set<string>): { calls: TextToolCall[]; rest: string } {
  const calls: TextToolCall[] = [];
  let rest = text;

  rest = rest.replace(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g, (whole, body: string) => {
    const call = body.includes("<function=") ? parseXmlFunction(body) : parseJsonCall(body);
    if (!call) return whole;
    calls.push(call);
    return "";
  });

  rest = rest.replace(/<function=[^>\s]+>[\s\S]*?(?:<\/function>|$)/g, (whole) => {
    const call = parseXmlFunction(whole);
    if (!call) return whole;
    calls.push(call);
    return "";
  });

  if (!calls.length) {
    rest = rest.replace(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g, (whole, body: string) => {
      const call = parseJsonCall(body);
      if (!call || !knownNames.has(call.name)) return whole;
      calls.push(call);
      return "";
    });
  }

  return { calls, rest: rest.trim() };
}

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
