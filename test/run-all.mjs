/**
 * Run every check in this project and report one line per suite.
 *
 * Why this exists: the suites do not share a filename convention — the five
 * behaviour tests are `<name>.test.mjs` while the static audit is `audit.mjs` — and
 * a shell loop that assumes one pattern reports a missing file as a *test failure*.
 * That happened during development and cost a round of debugging a bug that did not
 * exist. Listing the files in one place removes the assumption.
 *
 * Run: node test/run-all.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const suites = [
	["parser.test.mjs", "tolerant partial-JSON reader over every truncation point"],
	["apply.test.mjs", "plugin registration, layout and manifest guards"],
	["host.test.mjs", "host diagnostics route end to end"],
	["highlight.test.mjs", "language detection and tokenising"],
	["overlay.test.mjs", "incremental DOM patching and the resize handle"],
	["audit.mjs", "static audit of the bundle"]
];

let failed = 0;
for (const [file, description] of suites) {
	const result = spawnSync(process.execPath, [join(here, file)], { encoding: "utf8" });
	const ok = result.status === 0;
	if (!ok) failed += 1;
	// The last non-empty line of stdout is each suite's own summary.
	const lines = (result.stdout ?? "").trim().split("\n").filter((line) => line.trim() !== "");
	const summary = lines.length > 0 ? lines[lines.length - 1].trim() : "(no output)";
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${file.padEnd(20)} ${summary}`);
	if (!ok) {
		const detail = (result.stderr ?? "").trim().split("\n").slice(-6).join("\n         ");
		if (detail !== "") console.log(`         ${detail}`);
	}
	console.log(`         ${description}`);
}

console.log(`\n${failed === 0 ? `全部通过（${String(suites.length)} 个套件）。` : `失败 ${String(failed)} 个套件（共 ${String(suites.length)} 个）。`}`);
process.exit(failed === 0 ? 0 : 1);
