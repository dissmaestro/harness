import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

/**
 * A compact map of the repository: the main symbols (classes, functions, methods, types) of the most
 * referenced files, so the model knows the structure before reading anything (like aider's repo map,
 * with regex extraction instead of tree-sitter to stay dependency-free).
 */

export interface RepoSymbol {
  name: string;
  /** how it is shown: "class Agent", "send(userText, ui, signal)" */
  text: string;
  line: number;
  /** nested under the previous top-level symbol (a method) */
  member: boolean;
}

interface Rule {
  re: RegExp;
  /** builds the shown text from the match; return undefined to skip */
  show: (m: RegExpExecArray) => string | undefined;
  member?: boolean;
}

/** "a: Record<string, number>, b = 1" → "a, b = 1" (names only, generics removed first so their commas don't split) */
const params = (p = "") => {
  let s = p.replace(/\s+/g, " ");
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/<[^<>]*>|\{[^{}]*\}|\[[^[\]]*\]/g, "");
  }
  return s.replace(/\??:\s*[^,=]+/g, "").replace(/\s*=\s*(?=,|$)/g, "").replace(/\s+,/g, ",").trim().slice(0, 60);
};
/** Go: "ctx context.Context, n int" → "ctx, n" (types follow the names without a colon) */
const goParams = (p = "") =>
  params(p)
    .split(",")
    .map((x) => x.trim().split(/\s+/)[0])
    .filter(Boolean)
    .join(", ");
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor", "super", "new", "else", "do", "try", "with"]);

const TS: Rule[] = [
  { re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)\s*(?:<[^>]*>)?\(([^)]*)\)/, show: (m) => `function ${m[1]}(${params(m[2])})` },
  { re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/, show: (m) => `class ${m[1]}` },
  { re: /^(?:export\s+)?(?:declare\s+)?(interface|type|enum)\s+(\w+)/, show: (m) => `${m[1]} ${m[2]}` },
  { re: /^(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(([^)]*)\)|\w+)\s*(?::[^=]+)?=>/, show: (m) => `const ${m[1]}(${params(m[2])})` },
  { re: /^export\s+(?:const|let)\s+(\w+)/, show: (m) => `const ${m[1]}` },
  {
    re: /^\s{2,4}((?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*)(#?\w+)\s*(?:<[^>]*>)?\(([^)]*)\)\s*(?::[^{;]+)?\{\s*$/,
    // private members are implementation details: not worth the map's space
    show: (m) => (KEYWORDS.has(m[2]) || m[2].startsWith("#") || /private|protected/.test(m[1]) ? undefined : `${m[2]}(${params(m[3])})`),
    member: true,
  },
];

const RULES: Record<string, Rule[]> = {
  ts: TS,
  py: [
    { re: /^class\s+(\w+)/, show: (m) => `class ${m[1]}` },
    { re: /^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/, show: (m) => `def ${m[1]}(${params(m[2])})` },
    { re: /^\s{4}(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/, show: (m) => (m[1].startsWith("_") && m[1] !== "__init__" ? undefined : `${m[1]}(${params(m[2]).replace(/^self,?\s*/, "")})`), member: true },
  ],
  go: [
    { re: /^func\s+\(\s*\w*\s*\*?(\w+)[^)]*\)\s*(\w+)\s*\(([^)]*)\)/, show: (m) => `func (${m[1]}) ${m[2]}(${goParams(m[3])})` },
    { re: /^func\s+(\w+)\s*(?:\[[^\]]*\])?\(([^)]*)\)/, show: (m) => `func ${m[1]}(${goParams(m[2])})` },
    { re: /^type\s+(\w+)\s+(struct|interface|func|\w+)/, show: (m) => `type ${m[1]} ${m[2]}` },
  ],
  rs: [
    { re: /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type)\s+(\w+)/, show: (m) => `${m[1]} ${m[2]}` },
    { re: /^impl(?:<[^>]*>)?\s+([\w:<>, ]+?)(?:\s+for\s+([\w:<>]+))?\s*\{/, show: (m) => (m[2] ? `impl ${m[1]} for ${m[2]}` : `impl ${m[1]}`) },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\(([^)]*)\)/, show: (m) => `fn ${m[1]}(${params(m[2])})` },
    { re: /^\s{4}(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\(([^)]*)\)/, show: (m) => `fn ${m[1]}(${params(m[2]).replace(/^&?(?:mut\s+)?self,?\s*/, "")})`, member: true },
  ],
  java: [
    { re: /^\s*(?:(?:public|private|protected|internal|abstract|final|static|sealed|data|open|partial)\s+)*(class|interface|enum|record|object|struct)\s+(\w+)/, show: (m) => `${m[1]} ${m[2]}` },
    { re: /^\s+(?:(?:public|private|protected|internal|static|final|override|suspend|virtual|async|abstract|synchronized)\s+)+(?:[\w<>[\],.?]+\s+)?(\w+)\s*\(([^)]*)\)\s*(?:throws [\w, ]+)?\s*[{=:]/, show: (m) => (KEYWORDS.has(m[1]) ? undefined : `${m[1]}(${params(m[2])})`), member: true },
    { re: /^\s*(?:(?:private|public|internal|override|suspend|inline)\s+)*fun\s+(?:<[^>]*>\s*)?([\w.]+)\s*\(([^)]*)\)/, show: (m) => `fun ${m[1]}(${params(m[2])})` },
  ],
  c: [
    { re: /^(?:typedef\s+)?(struct|class|enum|union)\s+(\w+)\s*[{:]/, show: (m) => `${m[1]} ${m[2]}` },
    { re: /^(?!static_assert|return|if|while|for|switch)[A-Za-z_][\w\s\*&:<>,]*?\b([A-Za-z_][\w:~]*)\s*\(([^;{)]*)\)\s*(?:const\s*)?(?:noexcept\s*)?\{?\s*$/, show: (m) => (KEYWORDS.has(m[1]) ? undefined : `${m[1]}(${params(m[2])})`) },
  ],
  rb: [
    { re: /^\s*(class|module)\s+([\w:]+)/, show: (m) => `${m[1]} ${m[2]}` },
    { re: /^\s*def\s+(self\.)?(\w+[?!=]?)\s*(?:\(([^)]*)\))?/, show: (m) => `def ${m[1] ?? ""}${m[2]}(${params(m[3])})`, member: true },
  ],
  php: [
    { re: /^\s*(?:abstract\s+|final\s+)?(class|interface|trait|enum)\s+(\w+)/, show: (m) => `${m[1]} ${m[2]}` },
    { re: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)\s*\(([^)]*)\)/, show: (m) => `function ${m[1]}(${params(m[2])})`, member: true },
  ],
  lua: [{ re: /^(?:local\s+)?function\s+([\w.:]+)\s*\(([^)]*)\)/, show: (m) => `function ${m[1]}(${params(m[2])})` }],
  sh: [{ re: /^(?:function\s+)?([\w-]+)\s*\(\)\s*\{/, show: (m) => `${m[1]}()` }],
};

const LANG_OF: Record<string, string> = {
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts", ".js": "ts", ".jsx": "ts", ".mjs": "ts", ".cjs": "ts", ".vue": "ts", ".svelte": "ts",
  ".py": "py", ".go": "go", ".rs": "rs",
  ".java": "java", ".kt": "java", ".kts": "java", ".cs": "java", ".scala": "java", ".swift": "java",
  ".c": "c", ".h": "c", ".cc": "c", ".cpp": "c", ".cxx": "c", ".hpp": "c", ".hh": "c",
  ".rb": "rb", ".php": "php", ".lua": "lua", ".sh": "sh", ".bash": "sh",
};

/** Symbols of one file. */
export function extractSymbols(path: string, text: string): RepoSymbol[] {
  const lang = LANG_OF[extname(path).toLowerCase()];
  if (!lang) return [];
  const rules = RULES[lang];
  const out: RepoSymbol[] = [];
  let inClass = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < 200; i++) {
    const l = lines[i];
    if (l.length > 300 || !l.trim()) continue;
    for (const r of rules) {
      if (r.member && !inClass) continue;
      const m = r.re.exec(l);
      if (!m) continue;
      const text = r.show(m);
      if (!text) break;
      const name = /(\w+)\s*\(|(?:class|interface|type|enum|struct|trait|module|record|object|impl|union)\s+([\w:]+)|const\s+(\w+)/.exec(text);
      out.push({ name: name?.[1] ?? name?.[2] ?? name?.[3] ?? text, text, line: i + 1, member: !!r.member });
      if (!r.member) inClass = /^(class|interface|impl|struct|trait|module|object|record|enum)\b/.test(text) || lang === "rb" || lang === "php";
      break;
    }
  }
  return out;
}

export interface RepoMapOptions {
  /** budget in tokens (~3.5 characters each) */
  tokens: number;
  /** give up after this long (huge repositories) */
  timeoutMs?: number;
  /** files to map (relative to cwd); default: every source file `rg --files` lists */
  files?: string[];
}

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 300_000;

function listFiles(cwd: string): string[] {
  try {
    return execFileSync("rg", ["--files", "--sort", "path"], { cwd, encoding: "utf8", maxBuffer: 64 << 20, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter((f) => f && LANG_OF[extname(f).toLowerCase()]);
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? "").split("\n").filter((f) => f && LANG_OF[extname(f).toLowerCase()]);
  }
}

const isTest = (f: string) => /(^|\/)(tests?|__tests__|spec|testdata|fixtures?)\/|[._-](test|spec)\.\w+$|_test\.go$/.test(f);
const isEntry = (f: string) => /^(index|main|cli|app|server|lib|mod)\.\w+$/.test(basename(f));

/**
 * The map as text, most important files first, cut to the token budget. Importance = in how many other
 * files the file's symbol names appear (a cheap stand-in for aider's PageRank), entry points first.
 */
export function buildRepoMap(cwd: string, opts: RepoMapOptions): string {
  const t0 = Date.now();
  const deadline = t0 + (opts.timeoutMs ?? 4000);
  const files = (opts.files ?? listFiles(cwd)).slice(0, MAX_FILES);
  if (!files.length) return "";
  const symbols = new Map<string, RepoSymbol[]>();
  const words = new Map<string, Set<string>>();
  for (const f of files) {
    if (Date.now() > deadline) break;
    try {
      if (statSync(join(cwd, f)).size > MAX_FILE_BYTES) continue;
      const text = readFileSync(join(cwd, f), "utf8");
      symbols.set(f, extractSymbols(f, text));
      words.set(f, new Set(text.match(/[A-Za-z_]\w{3,}/g) ?? []));
    } catch {}
  }
  // symbol name → files that define it (names defined in many files say little)
  const definedIn = new Map<string, string[]>();
  for (const [f, syms] of symbols) {
    for (const s of syms) {
      if (s.name.length < 4) continue;
      const list = definedIn.get(s.name) ?? [];
      if (!list.includes(f)) list.push(f);
      definedIn.set(s.name, list);
    }
  }
  const score = new Map<string, number>();
  for (const [f, ws] of words) {
    for (const w of ws) {
      const defs = definedIn.get(w);
      if (!defs || defs.length > 3) continue;
      for (const d of defs) if (d !== f) score.set(d, (score.get(d) ?? 0) + 1 / defs.length);
    }
  }
  const ranked = [...symbols.keys()]
    .filter((f) => symbols.get(f)!.length)
    .map((f) => ({ f, s: (score.get(f) ?? 0) * (isTest(f) ? 0.2 : 1) + (isEntry(f) ? 3 : 0) }))
    .sort((a, b) => b.s - a.s || a.f.localeCompare(b.f));

  const budget = opts.tokens * 3.5;
  const out: string[] = [];
  let used = 0;
  for (const { f } of ranked) {
    const lines = [`${f}:`];
    for (const s of symbols.get(f)!.slice(0, 25)) lines.push(`${s.member ? "    " : "  "}${s.line}: ${s.text}`);
    const block = lines.join("\n");
    if (used + block.length > budget) {
      // a file that doesn't fit whole still gets its top-level symbols if they fit
      const top = [lines[0], ...symbols.get(f)!.filter((s) => !s.member).slice(0, 10).map((s) => `  ${s.line}: ${s.text}`)].join("\n");
      if (used + top.length <= budget) {
        out.push(top);
        used += top.length + 1;
      }
      continue;
    }
    out.push(block);
    used += block.length + 1;
  }
  const omitted = ranked.length - out.length;
  return out.join("\n") + (omitted > 0 ? `\n… ${omitted} more files with symbols not shown` : "");
}
