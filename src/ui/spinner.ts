import { c } from "./render.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** One-line spinner with elapsed seconds. stop() erases it so normal output can continue. */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = 0;
  private frame = 0;
  label = "thinking";
  /** extra text shown after the elapsed time, re-read on every frame (e.g. context usage) */
  detail: (() => string) | undefined;
  private out: NodeJS.WriteStream;
  private prefix: string;

  constructor(out: NodeJS.WriteStream = process.stdout, prefix = "") {
    this.out = out;
    this.prefix = prefix;
  }

  get active() {
    return this.timer !== undefined;
  }

  start(label = "thinking") {
    this.label = label;
    if (this.timer || !this.out.isTTY) return;
    this.started = Date.now();
    this.timer = setInterval(() => this.draw(), 100);
    this.draw();
  }

  private draw() {
    const secs = Math.floor((Date.now() - this.started) / 1000);
    this.frame = (this.frame + 1) % FRAMES.length;
    const detail = this.detail?.();
    this.out.write(`\r\x1b[2K${this.prefix}${c.magenta(FRAMES[this.frame])} ${c.dim(`${this.label}… ${secs}s${detail ? ` · ${detail}` : ""} · ctrl+c to interrupt`)}`);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.out.write("\r\x1b[2K");
  }
}
