import { c } from "./render.ts";

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, code: string) => c.cyan(code))
    .replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => c.bold(t))
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, (_m, pre: string, t: string) => pre + c.italic(t))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_m, t: string, url: string) => `${c.blue(t)} ${c.dim(`(${url})`)}`);
}

/** Renders Markdown line by line as it streams in (a line is printed once its newline arrives). */
export class MarkdownStream {
  private buf = "";
  private inCode = false;
  private write: (s: string) => void;

  constructor(write: (s: string) => void) {
    this.write = write;
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
  }

  renderLine(line: string): string {
    const fence = line.match(/^\s*```(\S*)/);
    if (fence) {
      this.inCode = !this.inCode;
      return c.gray(this.inCode ? `┌─ ${fence[1] || "code"}` : "└─");
    }
    if (this.inCode) return c.gray("│ ") + line;
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) return h[1].length <= 2 ? c.bold(c.magenta(inline(h[2]))) : c.bold(inline(h[2]));
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return c.gray("─".repeat(40));
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (bullet) return `${bullet[1]}${c.gray("•")} ${inline(bullet[2])}`;
    const quote = line.match(/^\s*>\s?(.*)/);
    if (quote) return c.gray("│ ") + c.italic(inline(quote[1]));
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return c.gray(line);
      return line.replace(/\|/g, c.gray("│")).replace(/[^│]+/g, (cell) => inline(cell));
    }
    return inline(line);
  }
}
