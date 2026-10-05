import { lineHighlighter } from "./highlight.ts";
import { c, linkPaths, urlLink } from "./render.ts";

function inline(s: string, cwd?: string): string {
  return (cwd ? linkPaths(s, cwd) : s)
    .replace(/`([^`]+)`/g, (_m, code: string) => c.cyan(code))
    .replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => c.bold(t))
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, (_m, pre: string, t: string) => pre + c.italic(t))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_m, t: string, url: string) => `${c.blue(urlLink(t, url))} ${c.dim(`(${url})`)}`);
}

/** Renders Markdown line by line as it streams in (a line is printed once its newline arrives). */
export class MarkdownStream {
  private buf = "";
  private inCode = false;
  /** highlighter for the current fenced block (its language from the fence) */
  private hl: (line: string) => string = (x) => x;
  private write: (s: string) => void;
  /** paths of existing files under this directory become clickable */
  private cwd: string | undefined;

  constructor(write: (s: string) => void, cwd?: string) {
    this.write = write;
    this.cwd = cwd;
  }

  push(text: string) {
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      this.write(this.renderLine(this.buf.slice(0, nl)) + "\n");
      this.buf = this.buf.slice(nl + 1);
    }
  }

  /** Prints a trailing partial line; returns true if anything was printed. */
  flush(): boolean {
    if (!this.buf) return false;
    this.write(this.renderLine(this.buf));
    this.buf = "";
    return true;
  }

  reset() {
    this.buf = "";
    this.inCode = false;
    this.hl = (x) => x;
  }

  renderLine(line: string): string {
    const fence = line.match(/^\s*```(\S*)/);
    if (fence) {
      this.inCode = !this.inCode;
      this.hl = this.inCode ? lineHighlighter(fence[1]) : (x) => x;
      return c.gray(this.inCode ? `┌─ ${fence[1] || "code"}` : "└─");
    }
    if (this.inCode) return c.gray("│ ") + this.hl(line);
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) return h[1].length <= 2 ? c.bold(c.magenta(inline(h[2], this.cwd))) : c.bold(inline(h[2], this.cwd));
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return c.gray("─".repeat(40));
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (bullet) return `${bullet[1]}${c.gray("•")} ${inline(bullet[2], this.cwd)}`;
    const quote = line.match(/^\s*>\s?(.*)/);
    if (quote) return c.gray("│ ") + c.italic(inline(quote[1], this.cwd));
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return c.gray(line);
      return line.replace(/\|/g, c.gray("│")).replace(/[^│]+/g, (cell) => inline(cell, this.cwd));
    }
    return inline(line, this.cwd);
  }
}
