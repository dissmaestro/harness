import type { Interface } from "node:readline";
import type { Completion, Item } from "./complete.ts";
import { paintBelow } from "./footer.ts";
import { c, stripAnsi } from "./render.ts";

const VISIBLE = 8;

type Key = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string } | undefined;

/** Cut a string with ANSI colors to `width` visible characters. */
export function truncateAnsi(s: string, width: number): string {
  let out = "";
  let n = 0;
  for (let i = 0; i < s.length; ) {
    const esc = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (n >= width) {
      out += s.includes("\x1b[") ? "\x1b[0m" : "";
      return out;
    }
    out += ch;
    n++;
    i += ch.length;
  }
  return out;
}

/** The menu rows for a completion with `sel` selected (scrolled so it is visible). */
export function menuRows(comp: Completion, sel: number, cols: number): string[] {
  const top = Math.min(Math.max(0, sel - VISIBLE + 1), Math.max(0, comp.items.length - VISIBLE));
  const shown = comp.items.slice(top, top + VISIBLE);
  const w = Math.min(comp.kind === "path" ? Math.max(20, cols - 20) : 32, Math.max(...shown.map((i) => i.label.length)));
  const rows = shown.map((item, k) => {
    const on = top + k === sel;
    // long paths lose their start (the file name matters most), long commands their end
    const cut = comp.kind === "path" ? "…" + item.label.slice(item.label.length - w + 1) : item.label.slice(0, w - 1) + "…";
    const label = item.label.length > w ? cut : item.label.padEnd(w);
    const paint = on ? (s: string) => c.bold(c.cyan(s)) : item.dir ? c.blue : (s: string) => s;
    const hint = item.hint ? "  " + c.dim(item.hint) : "";
    return truncateAnsi(`${on ? c.cyan(" ❯ ") : "   "}${paint(label)}${hint}`, cols - 1);
  });
  const action = comp.kind === "command" ? "enter run" : "enter insert";
  const count = comp.items.length > VISIBLE ? `  ${sel + 1}/${comp.items.length}` : "";
  rows.push(truncateAnsi(c.dim(`   ↑↓ select · tab complete · ${action} · esc close${count}`), cols - 1));
  return rows;
}

export interface MenuOptions {
  rl: Interface;
  out: NodeJS.WriteStream;
  /** true only while the main prompt waits for input */
  active: () => boolean;
  complete: (line: string, cursor: number) => Completion | undefined;
  /** rows shown under an empty prompt or for "?" (no selection) */
  panel: (line: string) => string[] | undefined;
}

/**
 * A completion menu drawn under the readline prompt. Keys reach `key()` before readline does;
 * it returns true for keys it used (arrows, tab, enter, esc while the menu is open).
 */
export class InputMenu {
  private comp: Completion | undefined;
  private sel = 0;
  private shown = 0;
  /** the menu stays closed while the line equals this (after esc or a history recall) */
  private suppressed: string | undefined;
  /** enter was pressed: stay hidden until the next prompt (the line may still be in flight to readline) */
  private submitted = false;
  private o: MenuOptions;

  constructor(o: MenuOptions) {
    this.o = o;
  }

  private get r() {
    return this.o.rl as unknown as { line: string; cursor: number };
  }

  /** Handle a key before readline sees it. `forward` sends a key sequence on to readline. */
  key(key: Key, forward: (seq: string) => void): boolean {
    if (!this.o.active()) return false;
    const open = this.comp && this.comp.items.length > 0;
    const name = key?.name;
    // node reports a lone esc with meta set, so check it before the modifier filter
    if (open && name === "escape") {
      this.suppressed = this.r.line;
      this.comp = undefined;
      this.draw();
      return true;
    }
    if (open && !key?.ctrl && !key?.meta) {
      const n = this.comp!.items.length;
      if (name === "up" || name === "down") {
        this.sel = (this.sel + (name === "up" ? n - 1 : 1)) % n;
        this.draw();
        return true;
      }
      if (name === "tab" && !key?.shift) {
        this.accept(this.comp!.items[this.sel]);
        return true;
      }
      if (name === "return" || name === "enter") {
        const item = this.comp!.items[this.sel];
        if (this.comp!.kind === "command" && !/ </.test(item.label)) {
          this.r.line = item.insert;
          this.r.cursor = item.insert.length;
          this.clear();
          this.o.rl.prompt(true);
          this.submitted = true;
          forward("\r");
        } else this.accept(item);
        return true;
      }
    }
    if (name === "return" || name === "enter") {
      this.clear();
      this.submitted = true;
    }
    if (!open && (name === "up" || name === "down")) {
      // history recall: don't pop the menu up for a recalled "/help"
      forward(key!.sequence!);
      this.suppressed = this.r.line;
      this.update();
      return true;
    }
    return false;
  }

  private accept(item: Item) {
    const comp = this.comp!;
    const { line } = this.r;
    const before = line.slice(0, comp.start);
    let after = line.slice(comp.end);
    const ins = item.insert + (item.dir ? "" : " ");
    if (ins.endsWith(" ") && after.startsWith(" ")) after = after.slice(1);
    this.r.line = before + ins + after;
    this.r.cursor = before.length + ins.length;
    this.suppressed = undefined;
    this.o.rl.prompt(true);
    this.update();
  }

  /** Recompute the menu for the current line and redraw it. `prompt`: a new prompt was just shown. */
  update(prompt = false) {
    if (prompt) this.submitted = false;
    if (this.submitted || !this.o.active()) return this.clear();
    const { line, cursor } = this.r;
    if (this.suppressed !== undefined && line !== this.suppressed) this.suppressed = undefined;
    const prev = this.comp;
    this.comp = this.suppressed === undefined ? this.o.complete(line, cursor) : undefined;
    if (!prev || !this.comp || prev.kind !== this.comp.kind || prev.start !== this.comp.start) this.sel = 0;
    else this.sel = Math.min(this.sel, this.comp.items.length - 1);
    this.draw();
  }

  /** Erase the menu (before readline submits the line or other output is printed). */
  clear() {
    this.comp = undefined;
    this.paint([]);
  }

  private draw() {
    const cols = this.o.out.columns || 80;
    if (this.comp?.items.length) return this.paint(menuRows(this.comp, this.sel, cols));
    const panel = this.suppressed === undefined ? this.o.panel(this.r.line) : undefined;
    this.paint((panel ?? []).map((r) => truncateAnsi(r, cols - 1)));
  }

  /** Draw rows under the input line and put the cursor back where readline left it. */
  private paint(rows: string[]) {
    if (!rows.length && !this.shown) return;
    const cols = this.o.out.columns || 80;
    const pos = this.o.rl.getCursorPos();
    const endRow = Math.floor((stripAnsi(this.o.rl.getPrompt()).length + this.r.line.length) / cols);
    this.shown = paintBelow(this.o.out, rows, pos.cols, this.shown, Math.max(0, endRow - pos.rows));
  }
}
