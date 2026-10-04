import assert from "node:assert/strict";
import { test } from "node:test";
import { highlight, highlightLines, langFromPath } from "../src/ui/highlight.ts";
import { stripAnsi } from "../src/ui/render.ts";

const SAMPLES: [string, string][] = [
  ["ts", 'const x: number = 42; // hi\nfunction f(a) { return `t ${a}`; }\n/* block\n still */ if (x) f("s\\"q");\n@dec class A {}'],
  ["py", 'def f(x):\n    """doc\n    more"""\n    return None # c\n@app.get("/")'],
  ["sh", 'echo "$HOME" # c\nfor f in *.ts; do x=a#b; done\necho ${X:-1} $(pwd)'],
  ["json", '{"a": 1, "b": [true, null, "s\\"x"]}'],
  ["rs", "fn main<'a>() { let c = 'x'; println!(\"hi\"); }\n#[derive(Debug)]"],
  ["go", "func main() {\n\ts := `raw\nstring`\n\tfmt.Println(s, nil, 0x1f)\n}"],
  ["c", '#include <stdio.h>\nint main(void) { printf("%d\\n", 1); /* x */ }'],
  ["yaml", "key: value # c\nlist:\n  - a: 1\n[section]\nname = \"x\""],
  ["sql", "SELECT id, name FROM users WHERE id = 1 -- c"],
  ["html", '<div class="a">&amp; text <!-- c --></div>'],
  ["css", ".a #b { color: #fff; margin: 0 }"],
  ["diff", "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new"],
  ["md", "# Title\n- item `code` **bold**\n```ts\nconst x = 1;\n```"],
];

test("highlighting never changes the text, only adds colors", () => {
  for (const [lang, src] of SAMPLES) {
    const out = highlight(src, lang);
    assert.equal(stripAnsi(out), src, `round trip for ${lang}`);
  }
});

test("keywords, strings and comments get colored", () => {
  const out = highlight('const s = "x"; // note', "ts");
  assert.match(out, /\x1b\[35mconst\x1b\[39m/); // keyword
  assert.match(out, /\x1b\[32m"x"\x1b\[39m/); // string
  assert.match(out, /\x1b\[90m\/\/ note\x1b\[39m/); // comment
});

test("block comment state carries across lines", () => {
  const [a, b, d] = highlightLines(["/* start", "middle", "end */ let x"], "ts");
  assert.match(a, /\x1b\[90m/);
  assert.equal(b, "\x1b[90mmiddle\x1b[39m");
  assert.match(d, /\x1b\[35mlet\x1b\[39m/);
});

test("unknown languages are returned unchanged", () => {
  assert.equal(highlight("whatever 1 2", "brainfuck"), "whatever 1 2");
  assert.equal(highlight("x", undefined), "x");
});

test("language detection by extension, name and shebang", () => {
  assert.equal(langFromPath("src/a.tsx"), "ts");
  assert.equal(langFromPath("x/PKGBUILD"), "sh");
  assert.equal(langFromPath("Cargo.toml"), "yaml");
  assert.equal(langFromPath("script", "#!/usr/bin/env python3"), "py");
  assert.equal(langFromPath("data.bin"), undefined);
});
