import { EventEmitter } from "node:events";
import { truncateAnsi } from "./menu.ts";

/**
 * Draws `rows` on the lines under the cursor and puts the cursor back at column `col` of its line.
 * `shown` is how many rows were drawn last time (they are erased first). Returns the new count.
 */
export function paintBelow(out: NodeJS.WriteStream, rows: string[], col: number, shown: number, rowsAbove = 0): number {
  if (!rows.length && !shown) return 0;
  const cols = out.columns || 80;
  const lines = rows.map((r) => truncateAnsi(r, cols - 1));
  let s = rowsAbove ? `\x1b[${rowsAbove}B` : "";
  if (lines.length) s += "\r\n\x1b[J" + lines.join("\r\n") + `\x1b[${lines.length + rowsAbove}A`;
  else s += `\x1b[1B\r\x1b[J\x1b[${rowsAbove + 1}A`;
  const c = col % cols;
  s += "\r" + (c ? `\x1b[${c}C` : "");
  out.write(s);
  return lines.length;
}

/** Column where the cursor ends up after writing `s` starting at column `col`. */
export function columnAfter(s: string, col: number): number {
  const t = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const i = Math.max(t.lastIndexOf("\n"), t.lastIndexOf("\r"));
  return i >= 0 ? [...t.slice(i + 1)].length : col + [...t].length;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * The panel under the output while agents work: a status line and the line being typed.
 * The owner calls clear() before writing output and draw() after it.
 */
export class Footer {
  private out: NodeJS.WriteStream;
  private rows: (frame: string) => string[];
  private col: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private shown = 0;

  constructor(out: NodeJS.WriteStream, rows: (frame: string) => string[], col: () => number) {
    this.out = out;
    this.rows = rows;
    this.col = col;
  }

  get active() {
    return this.timer !== undefined;
  }

  start() {
    if (this.timer || !this.out.isTTY) return;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.draw();
    }, 100);
    this.draw();
  }

  stop() {
    this.clear();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  clear() {
    this.paint([]);
  }

  draw() {
    if (!this.timer) return;
    this.paint(this.rows(FRAMES[this.frame]));
  }

  private paint(rows: string[]) {
    const col = this.col();
    if (col) {
      this.shown = paintBelow(this.out, rows, col, this.shown);
      return;
    }
    // at the start of a line: draw on it (no empty gap above the panel); the next output overwrites it
    if (!rows.length && !this.shown) return;
    const cols = this.out.columns || 80;
    const lines = rows.map((r) => truncateAnsi(r, cols - 1));
    this.out.write("\r\x1b[J" + (lines.length ? lines.join("\r\n") + (lines.length > 1 ? `\x1b[${lines.length - 1}A` : "") + "\r" : ""));
    this.shown = lines.length;
  }
}

/**
 * readline's output, passed through to the terminal except while `muted()` is true: then the footer
 * draws the input line itself, so typing doesn't scribble over the agent's output.
 */
export class MutableOutput extends EventEmitter {
  readonly isTTY = true;
  private out: NodeJS.WriteStream;
  private muted: () => boolean;

  constructor(out: NodeJS.WriteStream, muted: () => boolean) {
    super();
    this.out = out;
    this.muted = muted;
    out.on("resize", () => this.emit("resize"));
  }

  get columns() {
    return this.out.columns;
  }

  get rows() {
    return this.out.rows;
  }

  write(data: string | Uint8Array, cb?: (() => void) | string, cb2?: () => void): boolean {
    if (!this.muted()) this.out.write(data);
    const done = typeof cb === "function" ? cb : cb2;
    done?.();
    return true;
  }
}
