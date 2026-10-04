/** Dependency-free HTML → Markdown-ish text, good enough for docs pages, READMEs and articles. */

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function absolutize(href: string, base?: string): string {
  if (!base) return href;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

export function htmlTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

export function htmlToText(html: string, baseUrl?: string): string {
  let s = html;
  // Prefer the main content when the page marks it.
  const main = s.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (main && main[2].length > 500) s = main[2];
  s = s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|iframe|template|head|nav|footer|form|button)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Code blocks: keep their text verbatim (tags inside stripped later), protect from whitespace collapsing.
  const blocks: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => {
    const code = decodeEntities(body.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
    blocks.push("\n```\n" + code.replace(/\n+$/, "") + "\n```\n");
    return `\u0000${blocks.length - 1}\u0000`;
  });

  s = s
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${t}\n\n`)
    .replace(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) => {
      const text = t.replace(/<[^>]+>/g, "").trim();
      if (!text) return "";
      const url = absolutize(decodeEntities(href), baseUrl);
      return /^(javascript|mailto):/i.test(url) ? text : `[${text}](${url})`;
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<tr\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|ul|ol|table|blockquote|dd|dt|figure)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");

  s = decodeEntities(s)
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]);
}
