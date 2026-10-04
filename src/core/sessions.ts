import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Message } from "../types.ts";

/**
 * Append-only JSONL journal of a conversation, so a crash, a killed terminal or an OOM never loses it.
 * Lines: {"type":"meta",…} once, {"type":"msg","m":Message} per message, {"type":"reset","messages":[…]} after compaction.
 * Stored in ~/.agent/sessions/<cwd as a dir name>/<id>.jsonl.
 */

export interface SessionMeta {
  id: string;
  cwd: string;
  model: string;
  started: string;
}

export interface SessionInfo {
  id: string;
  file: string;
  updated: Date;
  /** first user request, for listings */
  title: string;
  messages: number;
}

export function sessionsDir(cwd: string, home = homedir()): string {
  return join(home, ".agent", "sessions", cwd.replace(/[\\/:]+/g, "-").replace(/^-+/, "") || "root");
}

const newId = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + Math.random().toString(36).slice(2, 6);

export class SessionJournal {
  readonly id: string;
  readonly file: string;
  private broken = false;
  /** the file is created with the first message, so sessions that never got one leave nothing behind */
  private meta: SessionMeta | undefined;

  constructor(cwd: string, model: string, home = homedir(), id = newId()) {
    this.id = id;
    this.file = join(sessionsDir(cwd, home), `${id}.jsonl`);
    if (!existsSync(this.file)) this.meta = { id, cwd, model, started: new Date().toISOString() };
  }

  private write(record: object) {
    if (this.broken) return;
    try {
      if (this.meta) {
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, JSON.stringify({ type: "meta", ...this.meta }) + "\n");
        this.meta = undefined;
      }
      appendFileSync(this.file, JSON.stringify(record) + "\n");
    } catch {
      this.broken = true; // a full disk must never take the agent down
    }
  }

  append(m: Message) {
    this.write({ type: "msg", m });
  }

  reset(messages: Message[]) {
    this.write({ type: "reset", messages });
  }
}

/** Rebuilds the message list from a journal file (tolerates a half-written last line). */
export function readSession(file: string): Message[] {
  let messages: Message[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === "msg" && rec.m) messages.push(rec.m);
    else if (rec.type === "reset" && Array.isArray(rec.messages)) messages = rec.messages;
  }
  return messages;
}

export function listSessions(cwd: string, home = homedir()): SessionInfo[] {
  const dir = sessionsDir(cwd, home);
  if (!existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    try {
      const messages = readSession(file);
      const firstUser = messages.find((m) => m.role === "user");
      if (!firstUser) continue;
      const title = String(firstUser.content).split("<system-reminder>")[0].replace(/\s+/g, " ").trim().slice(0, 80);
      out.push({ id: name.slice(0, -6), file, updated: statSync(file).mtime, title, messages: messages.length });
    } catch {}
  }
  return out.sort((a, b) => b.updated.getTime() - a.updated.getTime());
}

/** "latest", a full id, or a unique id prefix → the session */
export function findSession(cwd: string, which: string, home = homedir()): SessionInfo | undefined {
  const all = listSessions(cwd, home);
  if (which === "latest" || !which) return all[0];
  return all.find((s) => s.id === which) ?? (all.filter((s) => s.id.startsWith(which)).length === 1 ? all.find((s) => s.id.startsWith(which)) : undefined);
}

/**
 * Makes a history valid for strict chat templates after a crash or interrupt: every tool call gets a result,
 * orphan tool results are dropped, consecutive user messages are merged, and the history does not end in an
 * empty assistant message.
 */
export function sanitizeHistory(messages: Message[]): Message[] {
  const out: Message[] = [];
  let open: string[] = [];
  const closeOpen = () => {
    for (const id of open) out.push({ role: "tool", tool_call_id: id, content: "Tool call interrupted: no result was recorded." });
    open = [];
  };
  for (const m of messages) {
    if (m.role === "tool") {
      if (!open.includes(m.tool_call_id)) continue;
      open = open.filter((id) => id !== m.tool_call_id);
      out.push(m);
      continue;
    }
    closeOpen();
    const prev = out[out.length - 1];
    if (m.role === "user" && prev?.role === "user") {
      out[out.length - 1] = { role: "user", content: `${prev.content}\n\n${m.content}` };
      continue;
    }
    if (m.role === "assistant" && !m.content && !m.tool_calls?.length) continue;
    out.push(m);
    if (m.role === "assistant" && m.tool_calls?.length) open = m.tool_calls.map((c) => c.id);
  }
  closeOpen();
  return out;
}
