/** Minimal YAML frontmatter: "key: value" lines, quoted values, and folded/indented continuations. */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  let lastKey = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      lastKey = kv[1];
      const value = kv[2].trim();
      data[lastKey] = /^[>|][+-]?$/.test(value) ? "" : unquote(value);
    } else if (lastKey && /^\s+\S/.test(line)) {
      data[lastKey] = `${data[lastKey]} ${line.trim()}`.trim();
    }
  }
  return { data, body: text.slice(m[0].length) };
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

export function firstParagraph(body: string): string {
  return body.split(/\n\s*\n/).map((p) => p.replace(/^#+\s*/gm, "").trim()).find(Boolean) ?? "";
}
