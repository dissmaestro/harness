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
 * Gemma 4 argument syntax: {key:<|"|>text<|"|>,n:15,flag:true,obj:{a:1},list:[<|"|>x<|"|>]}.
 * Keys are bare (quoted keys and plain JSON strings are accepted too).
 */
export function parseGemmaArgs(src: string): Record<string, unknown> {
  let i = 0;
  const QUOTE = '<|"|>';
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const value = (): unknown => {
    ws();
    if (src.startsWith(QUOTE, i)) {
      const end = src.indexOf(QUOTE, i + QUOTE.length);
      const v = src.slice(i + QUOTE.length, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + QUOTE.length;
      return v;
    }
    const ch = src[i];
    if (ch === "{") return object();
    if (ch === "[") {
      i++;
      const arr: unknown[] = [];
      for (ws(); i < src.length && src[i] !== "]"; ws()) {
        arr.push(value());
        ws();
        if (src[i] === ",") i++;
      }
      i++;
      return arr;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      const raw = src.slice(i, j + 1);
      i = j + 1;
      try {
        return JSON.parse(raw);
      } catch {
        return raw.slice(1, -1);
      }
    }
    const m = /^[^,}\]]*/.exec(src.slice(i))![0];
    i += m.length;
    const t = m.trim();
    if (t === "true" || t === "false") return t === "true";
    if (t === "null" || t === "None") return null;
    return t !== "" && !Number.isNaN(Number(t)) ? Number(t) : t;
  };
  const object = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    i++; // {
    for (ws(); i < src.length && src[i] !== "}"; ws()) {
      const key = /^\s*(?:"([^"]*)"|<\|"\|>(.*?)<\|"\|>|([^:,}]+))\s*:/.exec(src.slice(i));
      if (!key) break;
      i += key[0].length;
      out[(key[1] ?? key[2] ?? key[3]).trim()] = value();
      ws();
      if (src[i] === ",") i++;
    }
    i++; // }
    return out;
  };
  const start = src.indexOf("{");
  if (start < 0) return {};
  i = start;
  return object();
}

/** Python call syntax (Gemma 3 tool_code): name(a="x", b=2) or print(default_api.name(...)) */
function parsePythonCall(body: string, knownNames: Set<string>): TextToolCall | undefined {
  const m = /(?:^|[\s(.])([A-Za-z_][\w.-]*)\(([\s\S]*)\)\s*\)?\s*$/.exec(body.trim().replace(/^print\(/, ""));
  if (!m) return undefined;
  const name = m[1].replace(/^default_api\./, "");
  if (!knownNames.has(name)) return undefined;
  const args: Record<string, unknown> = {};
  for (const a of m[2].matchAll(/(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,)]+)/g)) {
    const v = a[2].trim();
    if (/^["']/.test(v)) args[a[1]] = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\(["'\\])/g, "$1");
    else if (v === "True" || v === "False") args[a[1]] = v === "True";
    else if (v === "None") args[a[1]] = null;
    else args[a[1]] = Number.isNaN(Number(v)) ? v : Number(v);
  }
  return { name, arguments: args };
}

/** A JSON object or array of {"name", "arguments"|"parameters"} objects. */
function parseJsonCalls(body: string): TextToolCall[] {
  try {
    const v = parseJsonLenient(body);
    const list = Array.isArray(v) ? v : [v];
    return list.map((o) => parseJsonCall(JSON.stringify(o))).filter((c): c is TextToolCall => !!c);
  } catch {
    return [];
  }
}

/**
 * Extracts tool calls written as text, in the formats local models use when the server doesn't parse
 * them: Hermes/Qwen <tool_call> (JSON or XML), Qwen3-Coder <function=…>, Gemma 4 <|tool_call>call:…{…},
 * Gemma 3 ```tool_code```, Mistral [TOOL_CALLS], Llama <|python_tag|>, DeepSeek <｜tool▁call▁begin｜>,
 * and ```json fences or a bare JSON reply whose "name" is a known tool.
 * Returns the calls and the text with them removed.
 */
export function extractTextToolCalls(text: string, knownNames: Set<string>): { calls: TextToolCall[]; rest: string } {
  const calls: TextToolCall[] = [];
  let rest = text;

  // Gemma 4: <|tool_call>call:name{args}<tool_call|> (the closing token may be <turn|> or missing)
  rest = rest.replace(/<\|tool_call>\s*call:([\w.-]+)\s*(\{[\s\S]*?\})\s*(?:<tool_call\|>|<turn\|>|$)/g, (_w, name: string, args: string) => {
    calls.push({ name, arguments: parseGemmaArgs(args) });
    return "";
  });
  // Gemma 4 without its special tokens: call:name{…} for a known tool
  rest = rest.replace(/(?:^|\s)(?:<call>|call:)([\w.-]+)(\{[\s\S]*?\})(?=\s|$)/g, (whole, name: string, args: string) => {
    if (!knownNames.has(name)) return whole;
    calls.push({ name, arguments: parseGemmaArgs(args) });
    return "";
  });

  // DeepSeek: <｜tool▁call▁begin｜>[function<｜tool▁sep｜>]name\n```json\n{…}\n```<｜tool▁call▁end｜>
  rest = rest.replace(/<｜tool▁call▁begin｜>(?:function<｜tool▁sep｜>)?([\w.-]+)(?:<｜tool▁sep｜>)?\s*([\s\S]*?)<｜tool▁call▁end｜>/g, (whole, name: string, args: string) => {
    try {
      calls.push({ name, arguments: normalizeArgs(args.replace(/^```(?:json)?\s*|\s*```$/g, "")) });
      return "";
    } catch {
      return whole;
    }
  });
  rest = rest.replace(/<｜tool▁calls?▁(?:begin|end)｜>/g, "");

  // Mistral: [TOOL_CALLS][{"name": …, "arguments": …}] or [TOOL_CALLS]name[ARGS]{…}
  rest = rest.replace(/\[TOOL_CALLS\]\s*([\w.-]+)\[ARGS\](\{[\s\S]*?\})(?=\s*(?:\[TOOL_CALLS\]|$))/g, (whole, name: string, args: string) => {
    try {
      calls.push({ name, arguments: normalizeArgs(args) });
      return "";
    } catch {
      return whole;
    }
  });
  rest = rest.replace(/\[TOOL_CALLS\]\s*(\[[\s\S]*\])/g, (whole, body: string) => {
    const found = parseJsonCalls(body);
    if (!found.length) return whole;
    calls.push(...found);
    return "";
  });

  // Llama 3: <|python_tag|>{"name": …, "parameters": …}
  rest = rest.replace(/<\|python_tag\|>\s*([\s\S]*?)(?:<\|eom_id\|>|<\|eot_id\|>|$)/g, (whole, body: string) => {
    const found = parseJsonCalls(body);
    if (!found.length) return whole;
    calls.push(...found);
    return "";
  });

  // Gemma 3: ```tool_code\nname(a="x")\n```
  rest = rest.replace(/```tool_code\s*([\s\S]*?)```/g, (whole, body: string) => {
    const call = parsePythonCall(body, knownNames);
    if (!call) return whole;
    calls.push(call);
    return "";
  });

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
  // the whole reply is a JSON call (or a list of them) for known tools
  if (!calls.length && /^\s*[[{][\s\S]*[\]}]\s*$/.test(rest)) {
    const found = parseJsonCalls(rest).filter((c) => knownNames.has(c.name));
    if (found.length) {
      calls.push(...found);
      rest = "";
    }
  }

  return { calls, rest: rest.trim() };
}

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
