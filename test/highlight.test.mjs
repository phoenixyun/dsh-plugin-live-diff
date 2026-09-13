/**
 * Exercise the display highlighter.
 *
 * The highlighter is cosmetic, but two of its properties are not: nothing may
 * reach the DOM unescaped, and plain prose must never be coloured like code.
 * Both are asserted here, plus the language mapping that decides which profile a
 * path gets.
 *
 * Run: node test/highlight.test.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let registration;
globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value; } } };

const jsx = (type, props, children) => ({ type, props, children });
const reactStub = {
	jsx,
	Fragment: Symbol("Fragment"),
	useEffect: () => {},
	useCallback: (fn) => fn,
	useRef: (value) => ({ current: value }),
	useMemo: (compute) => compute(),
	useState: (value) => [value, () => {}],
	useSyncExternalStore: () => null
};
const requireStub = (specifier) => {
	if (specifier === "react/jsx-runtime") return { jsx, Fragment: Symbol("Fragment") };
	if (specifier === "react") return reactStub;
	if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return { DiffBlock: () => null };
	throw new Error(`unexpected require: ${specifier}`);
};

new Function(source)();
const { highlightLine, languageOf } = registration.factory(requireStub);

// ── language mapping ────────────────────────────────────────────────────────
assert.equal(languageOf("solar/config.py"), "python", "python by extension");
assert.equal(languageOf("D:\\Vault\\a\\b.tsx"), "typescript", "windows paths and tsx");
assert.equal(languageOf("README.md"), "markdown", "markdown by extension");
assert.equal(languageOf("package.json"), "json", "json by extension");
assert.equal(languageOf("dockerfile"), "shell", "extension-less names still map");
assert.equal(languageOf(".env.local"), "shell", "dotfiles map by name");
assert.equal(languageOf("Makefile"), "shell", "case-insensitive name match");
assert.equal(languageOf("notes.txt"), "text", "unknown extensions fall back to text");
assert.equal(languageOf(""), "text", "an empty path is text, not a crash");
assert.equal(languageOf(void 0), "text", "an undefined path is text");

// ── python ─────────────────────────────────────────────────────────────────
const pyKw = highlightLine("def compute(x):", "python");
assert.match(pyKw, /<span class="t-kw">def<\/span>/, "def is a keyword");
assert.match(pyKw, /compute\(x\):/, "a plain identifier is left alone");
assert.doesNotMatch(pyKw, /t-kw">compute/, "a function name is not coloured as a keyword");

assert.match(highlightLine("x = 'a # not a comment'", "python"), /t-st">'a # not a comment'/, "a hash inside a string is not a comment");
assert.match(highlightLine("x = 1  # note", "python"), /t-cm"># note/, "a trailing comment is coloured");
assert.match(highlightLine('"""doc"""', "python"), /t-st">"""doc"""/, "triple quotes read as a string");
assert.match(highlightLine("n = 0xFF", "python"), /t-nu">0xFF/, "hex numbers are numbers");
assert.match(highlightLine("v: Final = 1", "python"), /t-ty">Final/, "known types are coloured");

// ── comments swallow the rest of the line ───────────────────────────────────
assert.match(highlightLine("# def not_a_keyword", "python"), /^<span class="t-cm"># def not_a_keyword<\/span>$/, "a line comment consumes the line");

// ── javascript ─────────────────────────────────────────────────────────────
assert.match(highlightLine("const a = 1;", "javascript"), /t-kw">const/, "const is a keyword");
assert.match(highlightLine("const a = `tpl`;", "javascript"), /t-st">`tpl`/, "template literals are strings");

// ── json ───────────────────────────────────────────────────────────────────
assert.match(highlightLine('{"a": true}', "json"), /t-kw">true/, "true is a keyword in json");
assert.match(highlightLine('{"a": "x"}', "json"), /t-st">"x"/, "json strings are strings");

// ── escaping is non-negotiable ─────────────────────────────────────────────
const nasty = highlightLine('<img src=x onerror="alert(1)">', "python");
assert.ok(!nasty.includes("<img"), "raw markup never survives");
assert.match(nasty, /&lt;img/, "markup is escaped");
// A quote that opens a string must not swallow the closing escape.
assert.match(highlightLine('x = "\\" <b>"', "python"), /&lt;b&gt;/, "escapes inside strings stay escaped");

// ── text profile is inert ──────────────────────────────────────────────────
assert.equal(highlightLine("def x", "text"), "def x", "the text profile adds no markup");
assert.equal(highlightLine("anything at all", "markdown"), "anything at all", "markdown adds no markup");
assert.equal(highlightLine("def x", "no-such-language"), "def x", "an unknown profile adds no markup");

// ── robustness: never throw on odd input ───────────────────────────────────
for (const value of [void 0, null, 0, "", "\n", "\\\\", "'unterminated", '"""open']) {
	for (const language of ["python", "javascript", "json", "text"]) {
		highlightLine(value, language);
	}
}

console.log("highlight: all assertions passed");
console.log(`  profiles: python, javascript, typescript, json, yaml, shell, markdown, text`);
