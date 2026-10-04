import { basename, extname } from "node:path";
import { c } from "./render.ts";

/** Zero-dependency syntax highlighting: one regex tokenizer per language, with block comment/string state carried across lines. */

type Paint = (s: string) => string;

interface LangDef {
  kw?: string[];
  types?: string[];
  consts?: string[];
  line?: string[];
  block?: [string, string];
  /** quote characters for one-line strings */
  str?: string[];
  /** multi-line string delimiters (`, """ …) */
  mstr?: string[];
  caseInsensitive?: boolean;
  /** `#` starts a comment only at line start or after whitespace (shell) */
  hashAfterSpace?: boolean;
  /** single quote is not a string (Rust lifetimes) */
  noSingleQuote?: boolean;
  /** extra sticky (/y) token rules tried before the generic ones; rules starting with ^ only match at column 0 */
  extra?: [RegExp, Paint][];
}

const P = {
  kw: c.magenta,
  type: c.cyan,
  const: c.yellow,
  str: c.green,
  num: c.yellow,
  comment: c.gray,
  fn: c.blue,
  meta: c.magenta,
  key: c.cyan,
};

const w = (s: string) => s.split(" ");

const C_KW = w("if else for while do switch case default break continue return goto sizeof typedef struct union enum static extern const volatile inline register");
const C_TYPES = w("void int char short long float double signed unsigned bool size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t FILE");
const JS_KW = w(
  "const let var function return if else for while do switch case default break continue new class extends implements interface type enum import export from as async await yield try catch finally throw typeof instanceof in of void delete this super static readonly public private protected declare namespace satisfies keyof abstract",
);

const LANGS: Record<string, LangDef> = {
  ts: {
    kw: JS_KW,
    types: w("string number boolean any unknown never object symbol bigint Promise Record Partial Array Map Set Date Error"),
    consts: w("true false null undefined NaN Infinity"),
    line: ["//"],
    block: ["/*", "*/"],
    str: ['"', "'"],
    mstr: ["`"],
    extra: [[/@\w+/y, P.meta]],
  },
  py: {
    kw: w("def class return if elif else for while in not and or is import from as with try except finally raise lambda yield async await pass break continue global nonlocal del assert match case"),
    types: w("int str float bool list dict set tuple bytes object type self cls"),
    consts: w("True False None"),
    line: ["#"],
    str: ['"', "'"],
    mstr: ['"""', "'''"],
    extra: [[/@[\w.]+/y, P.meta]],
  },
  sh: {
    kw: w("if then else elif fi for in do done while until case esac function return local export readonly declare set unset shift exit source alias"),
    consts: w("true false"),
    line: ["#"],
    hashAfterSpace: true,
    str: ['"', "'"],
    extra: [[/\$(\{[^}]*\}|\(|[\w@#?$!*-])/y, P.type]],
  },
  json: {
    consts: w("true false null"),
    str: ['"'],
    line: ["//"],
    extra: [[/"(?:\\.|[^"\\])*"(?=\s*:)/y, P.key]],
  },
  go: {
    kw: w("func package import var const type struct interface map chan go defer select range return if else for switch case default break continue fallthrough goto"),
    types: w("string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 bool byte rune error any"),
    consts: w("true false nil iota"),
    line: ["//"],
    block: ["/*", "*/"],
    str: ['"', "'"],
    mstr: ["`"],
  },
  rs: {
    kw: w("fn let mut pub impl trait struct enum match if else loop while for in return use mod crate self Self super where as ref move async await dyn unsafe const static type break continue"),
    types: w("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc HashMap"),
    consts: w("true false None Some Ok Err"),
    line: ["//"],
    block: ["/*", "*/"],
    str: ['"'],
    noSingleQuote: true,
    extra: [
      [/\w+!/y, P.fn],
      [/'\\?.'/y, P.str],
      [/'\w+/y, P.type],
      [/#!?\[[^\]]*\]/y, P.meta],
    ],
  },
  c: {
    kw: C_KW,
    types: C_TYPES,
    consts: w("NULL true false"),
    line: ["//"],
    block: ["/*", "*/"],
    str: ['"', "'"],
    extra: [[/^\s*#\s*\w+/y, P.meta]],
  },
  cpp: {
    kw: [...C_KW, ...w("class namespace template typename public private protected virtual override final new delete using try catch throw constexpr auto this operator friend explicit noexcept")],
    types: [...C_TYPES, ...w("std string vector map unique_ptr shared_ptr")],
    consts: w("nullptr NULL true false"),
    line: ["//"],
    block: ["/*", "*/"],
    str: ['"', "'"],
    extra: [[/^\s*#\s*\w+/y, P.meta]],
  },
  java: {
    kw: w(
      "class interface enum extends implements public private protected static final abstract new return if else for while do switch case default break continue try catch finally throw throws import package this super void var val fun record sealed permits yield when object",
    ),
    types: w("int long short byte char float double boolean String Object List Map Set Integer Long"),
    consts: w("true false null"),
    line: ["//"],
    block: ["/*", "*/"],
    str: ['"', "'"],
    mstr: ['"""'],
    extra: [[/@\w+/y, P.meta]],
  },
  css: {
    block: ["/*", "*/"],
    str: ['"', "'"],
    extra: [
      [/[\w-]+(?=\s*:[^:])/y, P.key],
      [/#[\da-fA-F]{3,8}\b/y, P.num],
      [/[.#][\w-]+/y, P.fn],
      [/@[\w-]+/y, P.meta],
    ],
  },
  html: {
    block: ["<!--", "-->"],
    str: ['"', "'"],
    extra: [
      [/<\/?[\w:-]+|\/?>/y, P.kw],
      [/[\w:-]+(?==)/y, P.key],
      [/&\w+;/y, P.const],
    ],
  },
  yaml: {
    consts: w("true false null yes no on off"),
    line: ["#"],
    hashAfterSpace: true,
    str: ['"', "'"],
    extra: [
      [/^\s*-?\s*[\w.\/-]+(?=\s*:(\s|$))/y, P.key],
      [/^\s*\[[^\]]+\]/y, P.kw],
      [/^\s*[\w.-]+(?=\s*=)/y, P.key],
      [/[&*][\w-]+/y, P.meta],
    ],
  },
  sql: {
    kw: w(
      "select from where and or not insert into values update set delete create table drop alter add column index primary key foreign references join left right inner outer on group by order having limit offset as distinct union all exists in is like between case when then else end begin commit rollback default unique constraint if returning with",
    ),
    types: w("int integer bigint smallint text varchar char boolean bool date timestamp timestamptz serial float real numeric decimal json jsonb uuid"),
    consts: w("null true false NULL TRUE FALSE"),
    caseInsensitive: true,
    line: ["--"],
    block: ["/*", "*/"],
    str: ["'", '"'],
  },
  lua: {
    kw: w("and break do else elseif end for function goto if in local not or repeat return then until while"),
    consts: w("true false nil"),
    line: ["--"],
    str: ['"', "'"],
  },
};

const ALIASES: Record<string, string> = {
  typescript: "ts", tsx: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts", mts: "ts", cts: "ts", javascript: "ts",
  python: "py", pyi: "py",
  bash: "sh", zsh: "sh", shell: "sh", fish: "sh", console: "sh",
  jsonc: "json", json5: "json",
  golang: "go", rust: "rs",
  h: "c", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", "c++": "cpp",
  kt: "java", kotlin: "java", scala: "java", cs: "java", csharp: "java", swift: "java", dart: "java",
  scss: "css", less: "css",
  htm: "html", xml: "html", svg: "html", vue: "html", svelte: "html",
  yml: "yaml", toml: "yaml", ini: "yaml", cfg: "yaml", conf: "yaml", env: "yaml",
  pgsql: "sql", mysql: "sql", sqlite: "sql",
  patch: "diff",
  markdown: "md",
};

const FILE_NAMES: Record<string, string> = {
  Makefile: "sh", Dockerfile: "sh", PKGBUILD: "sh", ".bashrc": "sh", ".zshrc": "sh", ".profile": "sh",
  "Cargo.lock": "yaml", ".gitconfig": "yaml", ".editorconfig": "yaml",
};

export function normalizeLang(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const l = lang.toLowerCase();
  const n = ALIASES[l] ?? l;
  return LANGS[n] || n === "diff" || n === "md" ? n : undefined;
}

/** Language from file name, extension or shebang (first line). */
export function langFromPath(path: string, firstLine = ""): string | undefined {
  const base = basename(path);
  if (FILE_NAMES[base]) return FILE_NAMES[base];
  if (base.startsWith(".env")) return "yaml";
  const byExt = normalizeLang(extname(base).slice(1));
  if (byExt) return byExt;
  const shebang = firstLine.match(/^#!.*\b(bash|sh|zsh|python3?|node|deno|bun)\b/);
  if (shebang) return ({ bash: "sh", sh: "sh", zsh: "sh", python: "py", python3: "py", node: "ts", deno: "ts", bun: "ts" } as Record<string, string>)[shebang[1]];
  return undefined;
}

const NUM = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/y;
const WORD = /[A-Za-z_$][\w$]*/y;

interface State {
  /** closing delimiter we are inside of (block comment or multi-line string) */
  until?: string;
  paint?: Paint;
}

function makeHighlighter(def: LangDef) {
  const fold = (xs?: string[]) => new Set(def.caseInsensitive ? xs?.map((k) => k.toLowerCase()) : xs);
  const kw = fold(def.kw);
  const types = fold(def.types);
  const consts = new Set(def.consts);
  const mstr = [...(def.mstr ?? [])].sort((a, b) => b.length - a.length);

  return (line: string, st: State): string => {
    let out = "";
    let i = 0;
    // continue an open block comment / multi-line string
    if (st.until) {
      const end = line.indexOf(st.until);
      if (end < 0) return st.paint!(line);
      out += st.paint!(line.slice(0, end + st.until.length));
      i = end + st.until.length;
      st.until = st.paint = undefined;
    }
    let plain = "";
    const emit = (text: string, paint: Paint) => {
      out += plain + paint(text);
      plain = "";
      i += text.length;
    };
    const open = (text: string, until: string, paint: Paint) => {
      emit(text, paint);
      st.until = until;
      st.paint = paint;
    };
    outer: while (i < line.length) {
      const rest = line.slice(i);
      for (const [re, paint] of def.extra ?? []) {
        const anchored = re.source.startsWith("^");
        if (anchored && i > 0) continue;
        re.lastIndex = anchored ? 0 : i;
        const m = re.exec(line);
        if (m && m[0]) {
          emit(m[0], paint);
          continue outer;
        }
      }
      if (def.block && rest.startsWith(def.block[0])) {
        const end = line.indexOf(def.block[1], i + def.block[0].length);
        if (end < 0) {
          open(rest, def.block[1], P.comment);
          break;
        }
        emit(line.slice(i, end + def.block[1].length), P.comment);
        continue;
      }
      if (def.line?.some((p) => rest.startsWith(p)) && !(def.hashAfterSpace && i > 0 && !/\s/.test(line[i - 1]))) {
        emit(rest, P.comment);
        break;
      }
      const ms = mstr.find((q) => rest.startsWith(q));
      if (ms) {
        const end = line.indexOf(ms, i + ms.length);
        if (end < 0) {
          open(rest, ms, P.str);
          break;
        }
        emit(line.slice(i, end + ms.length), P.str);
        continue;
      }
      const q = def.str?.find((s) => rest.startsWith(s));
      if (q && !(q === "'" && def.noSingleQuote)) {
        let j = i + 1;
        while (j < line.length && line[j] !== q) j += line[j] === "\\" && !def.hashAfterSpace ? 2 : 1;
        emit(line.slice(i, Math.min(j + 1, line.length)), P.str);
        continue;
      }
      if (/\d/.test(line[i]) && !/[\w$]/.test(line[i - 1] ?? "")) {
        NUM.lastIndex = i;
        const m = NUM.exec(line);
        if (m) {
          emit(m[0], P.num);
          continue;
        }
      }
      if (/[A-Za-z_$]/.test(line[i])) {
        WORD.lastIndex = i;
        const word = WORD.exec(line)![0];
        const key = def.caseInsensitive ? word.toLowerCase() : word;
        const paint = kw.has(key)
          ? P.kw
          : consts.has(word)
            ? P.const
            : types.has(key)
              ? P.type
              : !def.hashAfterSpace && /^\s*\(/.test(line.slice(i + word.length))
                ? P.fn
                : undefined;
        if (paint) emit(word, paint);
        else {
          plain += word;
          i += word.length;
        }
        continue;
      }
      plain += line[i++];
    }
    return out + plain;
  };
}

const highlighters = new Map<string, ReturnType<typeof makeHighlighter>>();

function diffLine(l: string): string {
  if (/^(\+\+\+|---)\s/.test(l)) return c.bold(l);
  if (l.startsWith("@@")) return c.cyan(l);
  if (l.startsWith("+")) return c.green(l);
  if (l.startsWith("-")) return c.red(l);
  if (/^(diff|index) /.test(l)) return c.bold(l);
  return l;
}

function mdLine(l: string): string {
  if (/^#{1,6}\s/.test(l)) return c.bold(c.magenta(l));
  return l
    .replace(/`[^`]+`/g, (m) => c.cyan(m))
    .replace(/\*\*[^*]+\*\*/g, (m) => c.bold(m))
    .replace(/^(\s*)([-*+]|\d+\.)(\s)/, (_m, a: string, b: string, d: string) => a + c.gray(b) + d);
}

/** Stateful per-line highlighter: feed it consecutive lines of one file or code block. */
export function lineHighlighter(lang?: string): (line: string) => string {
  const l = normalizeLang(lang);
  if (!l || process.env.NO_COLOR) return (x) => x;
  if (l === "diff") return diffLine;
  if (l === "md") {
    let inCode = false;
    return (x) => {
      if (/^\s*```/.test(x)) {
        inCode = !inCode;
        return c.gray(x);
      }
      return inCode ? x : mdLine(x);
    };
  }
  let hl = highlighters.get(l);
  if (!hl) highlighters.set(l, (hl = makeHighlighter(LANGS[l])));
  const st: State = {};
  return (x) => hl!(x, st);
}

/**
 * Highlights consecutive lines of one file/code block. Stripping the colors gives back the input exactly.
 * Unknown languages are returned unchanged.
 */
export function highlightLines(lines: string[], lang?: string): string[] {
  const hl = lineHighlighter(lang);
  return lines.map(hl);
}

export const highlight = (code: string, lang?: string) => highlightLines(code.split("\n"), lang).join("\n");
