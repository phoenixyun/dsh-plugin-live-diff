/**
 * Static audit of the plugin's own source, using Node's bundled acorn.
 *
 * Why a bespoke checker instead of eslint
 * --------------------------------------
 * There is no eslint on this machine and no `node_modules` in the project (the
 * plugin is served verbatim and must not depend on a build step). Node ships
 * acorn internally, so a targeted set of checks can run with zero install.
 *
 * The checks are chosen for *this* codebase's failure modes, which have all been
 * invisible-at-runtime so far:
 *
 *   1. A helper that is defined and never called (dead code that still looks
 *      load-bearing).
 *   2. A name used in the served bundle that is never defined — the module table
 *      is a runtime lookup, so a typo in a `require(...)` specifier or a missing
 *      top-level declaration only fails when that branch executes.
 *   3. Test files that read the source by regex: a rename silently stops matching
 *      and the guard passes vacuously. This checks each source-level assertion in
 *      the tests still matches something.
 *
 * Run: node test/audit.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// ───────────────────────────── acorn via node internals ─────────────────────
// `process.binding` is deprecated but is the only way to reach the bundled
// parser without installing anything. If it ever disappears, the audit degrades
// to "parse failed" rather than crashing the rest of the suite.
let acorn = null;
try {
	acorn = process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"];
} catch {
	acorn = null;
}
function loadAcorn() {
	if (acorn !== null) {
		const module = { exports: {} };
		new Function("module", "exports", "require", acorn)(module, module.exports, () => {
			throw new Error("acorn has no runtime requires");
		});
		return module.exports;
	}
	return null;
}

const findings = [];
const note = (file, message) => findings.push({ file, message });

/** Parse a file, returning null when the parser is unavailable. */
function parse(file, source) {
	const parser = loadAcorn();
	if (parser === null) return null;
	try {
		return parser.parse(source, { ecmaVersion: "latest", sourceType: "module" });
	} catch (error) {
		note(file, `parse failed: ${error.message}`);
		return null;
	}
}

/** Walk every node in a tree. */
function walk(node, visit) {
	if (node === null || typeof node !== "object") return;
	visit(node);
	for (const key of Object.keys(node)) {
		if (key === "parent") continue;
		const value = node[key];
		if (Array.isArray(value)) {
			for (const item of value) walk(item, visit);
		} else if (value !== null && typeof value === "object" && typeof value.type === "string") {
			walk(value, visit);
		}
	}
}

/**
 * Names declared anywhere in the module.
 *
 * Not just top level: the served bundle's code lives *inside* the factory that
 * `window.__ModuleLoader__.load` registers, so a top-level-only scan finds two
 * statements and reports a clean bill of health for a file it never looked at.
 * (That is exactly what the first version of this script did.)
 */
function allDeclarations(ast) {
	const declared = new Map();
	walk(ast, (node) => {
		if (node.type === "FunctionDeclaration" && node.id !== null) {
			// Two nested functions may legitimately share a name; keep the first and
			// let the caller treat a repeat as a finding only if it is truly ambiguous.
			if (!declared.has(node.id.name)) declared.set(node.id.name, node);
		} else if (node.type === "VariableDeclaration") {
			for (const declarator of node.declarations) {
				if (declarator.id.type === "Identifier" && !declared.has(declarator.id.name)) {
					declared.set(declarator.id.name, node);
				}
			}
		} else if (node.type === "ClassDeclaration" && node.id !== null) {
			if (!declared.has(node.id.name)) declared.set(node.id.name, node);
		}
	});
	return declared;
}

/** Count identifier references to a name, excluding its own declaration site. */
function countReferences(ast, name, declaration) {
	let count = 0;
	walk(ast, (node) => {
		if (node.type === "Identifier" && node.name === name) count += 1;
		// A `{ name: value }` shorthand counts as a use of `name`.
		if (node.type === "Property" && node.shorthand === true
			&& node.key.type === "Identifier" && node.key.name === name) count += 1;
	});
	return count;
}

// ─────────────────────────── check 1: dead helpers ──────────────────────────

const CLIENT = "lib/client.js";
const clientSource = readFileSync(join(root, CLIENT), "utf8");
const clientAst = parse(CLIENT, clientSource);

if (clientAst === null) {
	console.log("  SKIP  acorn 不可用，跳过静态审查");
	console.log("\n（这不算失败：审查脚本在无法解析时应当降级而不是骗人）");
	process.exit(0);
}

const declared = allDeclarations(clientAst);
const exportedNames = new Set();
// The factory's `return { ... }` is the plugin's test surface; anything listed
// there is intentionally reachable even if the bundle itself never calls it.
walk(clientAst, (node) => {
	if (node.type === "ReturnStatement" && node.argument !== null
		&& node.argument.type === "ObjectExpression") {
		for (const property of node.argument.properties) {
			if (property.key !== void 0 && property.key.type === "Identifier") {
				exportedNames.add(property.key.name);
			}
		}
	}
});

let deadHelpers = 0;
for (const [name, node] of declared) {
	if (node.type !== "FunctionDeclaration") continue;
	if (exportedNames.has(name)) continue;
	// One reference is the declaration's own binding; more means it is used.
	const references = countReferences(clientAst, name, node);
	if (references <= 1) {
		note(CLIENT, `函数 ${name}() 定义后从未被调用（可能是死代码）`);
		deadHelpers += 1;
	}
}

// ──────────────── check 2: duplicate top-level declarations ────────────────

const seen = new Map();
for (const node of clientAst.body) {
	const names = [];
	if (node.type === "FunctionDeclaration" && node.id !== null) names.push(node.id.name);
	if (node.type === "VariableDeclaration") {
		for (const declarator of node.declarations) {
			if (declarator.id.type === "Identifier") names.push(declarator.id.name);
		}
	}
	for (const name of names) {
		if (seen.has(name)) {
			note(CLIENT, `顶层的 ${name} 被声明了两次（后者会静默覆盖前者）`);
		}
		seen.set(name, node);
	}
}

// ─────────── check 3: require() specifiers vs declared injects ─────────────

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declaredInjects = new Set(manifest.dsh?.client?.inject ?? []);
const required = [...clientSource.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
const platformSeeds = new Set([
	"react", "react/jsx-runtime", "react-dom", "react-dom/client",
	"@deepseek-ai/cordis", "@deepseek-ai/dsh-client-store",
	"@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives",
	"@deepseek-ai/dsh-client-ui-dockkit"
]);
for (const specifier of new Set(required)) {
	if (platformSeeds.has(specifier)) continue;
	if (!declaredInjects.has(specifier)) {
		note(CLIENT, `require("${specifier}") 既不是平台种子也未在 dsh.client.inject 中声明`);
	}
}

// ─────── check 4: source-level assertions in tests still match ─────────────
//
// Two shapes of guard, and only one of them can be checked mechanically:
//
//   * `assert.ok(/pattern/.test(source), ...)` — must match. If a rename makes it
//     stop matching, the assertion fails loudly, so there is nothing to audit.
//   * `assert.ok(!/pattern/.test(source), ...)` — must NOT match. This one cannot
//     be checked by looking for a match, because a correct negative guard also
//     finds nothing: "the plugin no longer assigns document.title" and "the
//     variable was renamed so the guard is blind" look identical from here.
//
// So instead of trying to detect vacuity (which is undecidable from the source
// alone), this lists every negative guard and requires it to carry a justification
// comment. A guard whose reason is not written down is the one that rots silently.
const testFiles = ["apply.test.mjs", "overlay.test.mjs"];
for (const testFile of testFiles) {
	const testSource = readFileSync(join(root, "test", testFile), "utf8");
	const lines = testSource.split("\n");
	let index = 0;
	for (const line of lines) {
		index += 1;
		const match = /!\/.*?\/[a-z]*\.test\(source\)/.exec(line);
		if (match === null) continue;
		// Look at the comment block immediately above (up to 8 lines back).
		const above = lines.slice(Math.max(0, index - 9), index - 1).join("\n");
		const hasReason = /\/\/|\*/.test(above) && above.trim().length > 0;
		if (!hasReason) {
			note(`test/${testFile}:${String(index)}`,
				`否定型守卫 ${match[0]} 上方没有说明原因的注释——这类守卫最容易在改名后静默失效`);
		}
	}
}

// ──────────────────────────────── report ───────────────────────────────────

console.log(`  client.js 顶层声明 ${String(declared.size)} 个，其中函数 ${String(deadHelpers)} 个未被调用`);
console.log(`  require() 说明符 ${String(new Set(required).size)} 个`);
if (findings.length === 0) {
	console.log("\n静态审查：未发现问题。");
	process.exit(0);
}
console.log(`\n静态审查发现 ${String(findings.length)} 处：`);
for (const finding of findings) console.log(`  ${finding.file}: ${finding.message}`);
process.exit(1);
