import type { WebSearchConfig } from "../core/settings.ts";
import type { Tool } from "../types.ts";
import { htmlTitle, htmlToText } from "../web/html.ts";
import { USER_AGENT, webSearch } from "../web/search.ts";

const MAX_DOWNLOAD = 3_000_000;
const DEFAULT_CHARS = 12_000;

export const WebFetch: Tool = {
  name: "WebFetch",
  kind: "read",
  tags: ["web", "internet", "url", "http", "documentation", "page", "download"],
  description:
    "Fetch a web page or file by URL and return it as readable text (HTML is converted to Markdown-like text). " +
    "Long pages are paginated: pass start to read further. For broad research prefer an Agent subagent to keep your context small.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) URL" },
      start: { type: "integer", description: "Character offset to start from (default 0)" },
      max_chars: { type: "integer", description: `Characters to return (default ${DEFAULT_CHARS})` },
    },
    required: ["url"],
  },
  async run(args, ctx) {
    let url = String(args.url).trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
    // GitHub file pages are mostly navigation chrome; the raw file is what the model needs.
    url = url.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/, "https://raw.githubusercontent.com/$1/$2");
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    const type = res.headers.get("content-type") ?? "";
    if (/image|video|audio|octet-stream|pdf|zip/.test(type)) throw new Error(`Unsupported content type ${type}`);

    let body = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      body += decoder.decode(chunk, { stream: true });
      if (body.length > MAX_DOWNLOAD) break;
    }
    const isHtml = /html/.test(type) || /^\s*<(!doctype|html)/i.test(body);
    const text = isHtml ? htmlToText(body, res.url) : body;
    const title = isHtml ? htmlTitle(body) : "";

    const start = Math.max(0, args.start ?? 0);
    const max = args.max_chars ?? DEFAULT_CHARS;
    const part = text.slice(start, start + max);
    const end = start + part.length;
    const header = `URL: ${res.url}${title ? `\nTitle: ${title}` : ""}\nShowing characters ${start}-${end} of ${text.length}.`;
    const more = end < text.length ? `\n\n[${text.length - end} more characters: call WebFetch again with start=${end}]` : "";
    return `${header}\n\n${part}${more}`;
  },
};

export function webSearchTool(cfg: WebSearchConfig): Tool {
  return {
    name: "WebSearch",
    kind: "read",
    tags: ["web", "internet", "search", "google", "documentation", "news", "latest"],
    description:
      "Search the web. Returns titles, URLs and snippets; then use WebFetch to read a page. " +
      "Use for documentation, error messages, library versions and anything newer than your training data.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", description: "Default 8" },
      },
      required: ["query"],
    },
    async run(args, ctx) {
      const results = await webSearch(cfg, String(args.query), args.max_results ?? 8, ctx.signal);
      if (!results.length) return `No results for "${args.query}".`;
      return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
    },
  };
}
