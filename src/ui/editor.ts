import { EventEmitter } from "node:events";
import { stripAnsi } from "./render.ts";

/**
 * A multi-line input editor for the terminal, used instead of node's readline (which edits one line only):
 * - Enter sends; "\" right before the cursor + Enter, Alt+Enter, Ctrl+J or Shift+Enter insert a new line;
 * - ↑/↓ move between the lines of the message, and through the history from its first/last line;
 * - pasted text (bracketed paste) is inserted as is, newlines included.
 * It mimics the part of readline.Interface the REPL uses (line, cursor, prompt, history, events).
 */

export type Key = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string } | undefined;

/** prefix of the second and following lines of a message */
const CONT = "  ";
const TAB = "    ";

/** Display width of one character (CJK and emoji take two columns). */
export function charWidth(ch: string): number {
  if (ch === "\t") return TAB.length;
  const cp = ch.codePointAt(0)!;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0; // combining marks
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export const strWidth = (s: string) => [...s].reduce((n, ch) => n + charWidth(ch), 0);

/** Where each character of `text` lands on screen, starting after a prompt of width `promptWidth`. */
export function layout(text: string, promptWidth: number, cols: number, cursor: number): { cursorRow: number; cursorCol: number; endRow: number; endCol: number } {
  let row = 0;
  let col = promptWidth;
  let cursorRow = 0;
  let cursorCol = col;
  let i = 0;
  const place = () => {
    if (i === cursor) [cursorRow, cursorCol] = col >= cols ? [row + 1, 0] : [row, col];
  };
  for (const ch of text) {
    place();
    if (ch === "\n") {
      row++;
      col = CONT.length;
    } else {
      const w = charWidth(ch);
      if (col + w > cols) {
        row++;
        col = 0;
      }
      col += w;
    }
    i += ch.length;
  }
  place();
  return { cursorRow, cursorCol, endRow: row, endCol: col };
}

export interface EditorOptions {
  output: { write(s: string): unknown; columns?: number };
  /** newest first, like readline */
  history?: string[];
  historySize?: number;
}

export class LineEditor extends EventEmitter {
  line = "";
  cursor = 0;
  /** newest first (readline's order) */
  history: string[];
  private out: EditorOptions["output"];
  private promptText = "> ";
  private historySize: number;
  /** -1 = editing the draft; otherwise an index into history */
  private historyIndex = -1;
  private draft = "";
  private pasting = false;
  private drawn = false;
  private cursorRow = 0;
  private cursorCol = 0;
  private endRow = 0;
  private closed = false;

  constructor(opts: EditorOptions) {
    super();
    this.out = opts.output;
    this.history = opts.history ?? [];
    this.historySize = opts.historySize ?? 1000;
  }

  // ----- the readline-like surface -----

  setPrompt(p: string) {
    this.promptText = p;
  }

  getPrompt(): string {
    return this.promptText;
  }

  /** Draws the prompt and the current text: in place when already shown and `preserveCursor`, else fresh. */
  prompt(preserveCursor = false) {
    if (this.closed) return;
    if (!preserveCursor || !this.drawn) this.drawn = false;
    this.cursor = Math.min(this.cursor, this.line.length);
    this.render();
  }

  /** Rows/columns of the cursor relative to the start of the prompt (like readline.getCursorPos). */
  getCursorPos(): { rows: number; cols: number } {
    return { rows: this.cursorRow, cols: this.cursorCol };
  }

  /** How many rows below the prompt's first row the input ends on. */
  endRows(): number {
    return this.endRow;
  }

  pause() {}
  resume() {}

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  /** Empties the input (Ctrl+C on a non-empty line). */
  clear() {
    this.setLine("");
  }

  // ----- editing -----

  private setLine(text: string, cursor = text.length) {
    this.line = text;
    this.cursor = Math.max(0, Math.min(cursor, text.length));
    this.render();
  }

  private insert(s: string) {
    this.historyIndex = -1;
    this.setLine(this.line.slice(0, this.cursor) + s + this.line.slice(this.cursor), this.cursor + s.length);
  }

  private lineStart(at = this.cursor) {
    return this.line.lastIndexOf("\n", at - 1) + 1;
  }

  private lineEnd(at = this.cursor) {
    const i = this.line.indexOf("\n", at);
    return i < 0 ? this.line.length : i;
  }

  private wordLeft() {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.line[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.line[i - 1])) i--;
    return i;
  }

  private wordRight() {
    let i = this.cursor;
    while (i < this.line.length && /\s/.test(this.line[i])) i++;
    while (i < this.line.length && !/\s/.test(this.line[i])) i++;
    return i;
  }

  /** ↑/↓: to the same column of the neighbouring line, or through the history at the first/last line. */
  private vertical(dir: -1 | 1) {
    const start = this.lineStart();
    const col = this.cursor - start;
    if (dir < 0 && start > 0) {
      const prevStart = this.lineStart(start - 1);
      this.setLine(this.line, Math.min(prevStart + col, start - 1));
      return;
    }
    const end = this.lineEnd();
    if (dir > 0 && end < this.line.length) {
      const nextEnd = this.lineEnd(end + 1);
      this.setLine(this.line, Math.min(end + 1 + col, nextEnd));
      return;
    }
    this.historyStep(dir);
  }

  private historyStep(dir: -1 | 1) {
    if (dir < 0) {
      if (this.historyIndex + 1 >= this.history.length) return;
      if (this.historyIndex === -1) this.draft = this.line;
      this.historyIndex++;
      const h = this.history[this.historyIndex];
      // going up lands on the last line of a multi-line entry, going down on its first
      this.setLine(h, h.length);
    } else {
      if (this.historyIndex < 0) return;
      this.historyIndex--;
      const h = this.historyIndex < 0 ? this.draft : this.history[this.historyIndex];
      this.setLine(h, h.indexOf("\n") < 0 ? h.length : h.indexOf("\n"));
    }
  }

  private submit() {
    const text = this.line;
    // leave the cursor below the input
    const down = this.endRow - this.cursorRow;
    this.out.write((down > 0 ? `\x1b[${down}B` : "") + "\r\n");
    this.drawn = false;
    this.line = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.draft = "";
    if (text.trim() && text !== this.history[0]) {
      this.history.unshift(text);
      if (this.history.length > this.historySize) this.history.pop();
    }
    this.emit("line", text);
  }

  /** Handles one key (from emitKeypressEvents). */
  feed(s: string | undefined, key: Key) {
    if (this.closed) return;
    const name = key?.name;
    const seq = key?.sequence ?? s ?? "";
    if (name === "paste-start") {
      this.pasting = true;
      return;
    }
    if (name === "paste-end") {
      this.pasting = false;
      return;
    }
    if (this.pasting) {
      // pasted text goes in as is: newlines stay newlines, nothing is sent
      const text = name === "return" || name === "enter" ? "\n" : (s ?? seq);
      if (text && !/^\x1b/.test(text)) this.insert(text.replace(/\r\n?/g, "\n"));
      return;
    }
    // Shift+Enter in terminals that report it (kitty keyboard protocol, xterm modifyOtherKeys)
    if (seq === "\x1b[13;2u" || seq === "\x1b[27;2;13~" || seq === "\x1b\r" || (name === "return" && (key?.meta || key?.shift))) {
      this.insert("\n");
      return;
    }
    if (key?.ctrl) {
      switch (name) {
        case "c":
          this.emit("SIGINT");
          return;
        case "d":
          if (!this.line) this.close();
          else if (this.cursor < this.line.length) this.setLine(this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1), this.cursor);
          return;
        case "j":
          this.insert("\n");
          return;
        case "a":
          this.setLine(this.line, this.lineStart());
          return;
        case "e":
          this.setLine(this.line, this.lineEnd());
          return;
        case "b":
          this.setLine(this.line, this.cursor - 1);
          return;
        case "f":
          this.setLine(this.line, this.cursor + 1);
          return;
        case "p":
          this.vertical(-1);
          return;
        case "n":
          this.vertical(1);
          return;
        case "u":
          this.setLine(this.line.slice(0, this.lineStart()) + this.line.slice(this.cursor), this.lineStart());
          return;
        case "k": {
          const end = this.lineEnd();
          // at the end of a line Ctrl+K joins it with the next one
          const to = end === this.cursor && end < this.line.length ? end + 1 : end;
          this.setLine(this.line.slice(0, this.cursor) + this.line.slice(to), this.cursor);
          return;
        }
        case "w":
        case "backspace": {
          const from = this.wordLeft();
          this.setLine(this.line.slice(0, from) + this.line.slice(this.cursor), from);
          return;
        }
        case "h":
          this.feed(undefined, { name: "backspace" });
          return;
        case "l":
          this.out.write("\x1b[2J\x1b[H");
          this.drawn = false;
          this.render();
          return;
        case "left":
          this.setLine(this.line, this.wordLeft());
          return;
        case "right":
          this.setLine(this.line, this.wordRight());
          return;
      }
      return;
    }
    if (key?.meta) {
      if (name === "b" || name === "left") return this.setLine(this.line, this.wordLeft());
      if (name === "f" || name === "right") return this.setLine(this.line, this.wordRight());
      if (name === "backspace") {
        const from = this.wordLeft();
        return this.setLine(this.line.slice(0, from) + this.line.slice(this.cursor), from);
      }
      if (name === "d") {
        const to = this.wordRight();
        return this.setLine(this.line.slice(0, this.cursor) + this.line.slice(to), this.cursor);
      }
      return;
    }
    switch (name) {
      case "return":
        // "\" right before the cursor + Enter = a new line, anywhere in the text
        if (this.cursor > 0 && this.line[this.cursor - 1] === "\\") {
          this.setLine(this.line.slice(0, this.cursor - 1) + "\n" + this.line.slice(this.cursor), this.cursor);
          return;
        }
        this.submit();
        return;
      case "enter": // Ctrl+J / a bare \n
        this.insert("\n");
        return;
      case "backspace":
        if (this.cursor > 0) this.setLine(this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor), this.cursor - 1);
        return;
      case "delete":
        if (this.cursor < this.line.length) this.setLine(this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1), this.cursor);
        return;
      case "left":
        this.setLine(this.line, this.cursor - 1);
        return;
      case "right":
        this.setLine(this.line, this.cursor + 1);
        return;
      case "home":
        this.setLine(this.line, this.lineStart());
        return;
      case "end":
        this.setLine(this.line, this.lineEnd());
        return;
      case "up":
        this.vertical(-1);
        return;
      case "down":
        this.vertical(1);
        return;
      case "tab":
      case "escape":
        return; // tab completes in the menu; shift+tab switches modes (handled by the REPL)
    }
    const text = s ?? "";
    if (text && !/[\x00-\x1f\x7f]/.test(text)) this.insert(text);
  }

  // ----- drawing -----

  private render() {
    if (this.closed) return;
    const cols = this.out.columns || 80;
    const promptWidth = strWidth(stripAnsi(this.promptText));
    let s = this.drawn ? (this.cursorRow ? `\x1b[${this.cursorRow}A` : "") + "\r" : "";
    s += "\x1b[J" + this.promptText;
    s += this.line.replace(/\t/g, TAB).split("\n").join("\r\n" + CONT);
    // layout() counts a tab as TAB.length wide, so the original text gives the same positions
    const pos = layout(this.line, promptWidth, cols, this.cursor);
    let { endRow, endCol } = pos;
    if (endCol >= cols) {
      // the last row is exactly full: step onto the next one so the cursor arithmetic holds
      s += "\r\n";
      endRow++;
      endCol = 0;
    }
    const up = endRow - pos.cursorRow;
    s += (up > 0 ? `\x1b[${up}A` : "") + "\r" + (pos.cursorCol ? `\x1b[${pos.cursorCol}C` : "");
    this.out.write(s);
    this.cursorRow = pos.cursorRow;
    this.cursorCol = pos.cursorCol;
    this.endRow = endRow;
    this.drawn = true;
  }
}
