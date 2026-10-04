import type { WebSearchConfig } from "../core/settings.ts";
import { decodeEntities } from "./html.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const strip = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** Bing wraps result links as bing.com/ck/a?...&u=a1<base64url>; recover the real URL. */
export function unwrapBingUrl(href: string): string {
  const url = decodeEntities(href);
  const m = url.match(/[?&]u=a1([^&]+)/);
  if (!m) return url;
  try {
    return Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return url;
  }
}

export function parseBing(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const item of html.split(/<li class="b_algo"/).slice(1)) {
    const a = item.match(/<h2[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const snippet = item.match(/<div class="b_caption[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/) ?? item.match(/<p\b[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: strip(a[2]), url: unwrapBingUrl(a[1]), snippet: snippet ? strip(snippet[1]) : "" });
  }
  return out;
}

async function getText(url: string, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    headers: { "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.9", ...headers },
  });
  if (!res.ok) throw new Error(`search request failed: HTTP ${res.status}`);
  return res.text();
}

export async function webSearch(cfg: WebSearchConfig, query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const q = encodeURIComponent(query);
  switch (cfg.provider) {
    case "searxng": {
      if (!cfg.url) throw new Error('webSearch.provider "searxng" needs webSearch.url in settings.json');
      const data = JSON.parse(await getText(`${cfg.url.replace(/\/$/, "")}/search?q=${q}&format=json`, signal));
      return (data.results ?? []).slice(0, limit).map((r: any) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "" }));
    }
    case "brave": {
      if (!cfg.apiKey) throw new Error('webSearch.provider "brave" needs webSearch.apiKey in settings.json');
      const data = JSON.parse(
        await getText(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=${limit}`, signal, {
          accept: "application/json",
          "x-subscription-token": cfg.apiKey,
        }),
      );
      return (data.web?.results ?? []).slice(0, limit).map((r: any) => ({ title: strip(r.title ?? ""), url: r.url ?? "", snippet: strip(r.description ?? "") }));
    }
    default: {
      const html = await getText(`https://www.bing.com/search?q=${q}&setlang=en&cc=US&mkt=en-US&count=${Math.min(limit, 30)}`, signal);
      const results = parseBing(html);
      if (!results.length && /captcha|challenge/i.test(html)) throw new Error("Bing asked for a captcha. Configure searxng or brave in settings.json.");
      return results.slice(0, limit);
    }
  }
}
