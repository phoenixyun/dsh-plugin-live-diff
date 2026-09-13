/**
 * Asks DSH's own resolution logic whether it can find the plugin package, so a
 * 404 can be attributed to the mount form rather than guessed at.
 *
 * Mirrors what `dsh-client-modules` does at boot: locate the package.json that
 * owns a loader row's specifier, read its `dsh.client` declaration, and derive
 * the client bundle path.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const DSH = "D:/Program/DSH/npm-global/node_modules/@deepseek-ai/dsh/node_modules";
const require = createRequire(`${DSH}/@deepseek-ai/dsh-client-modules/lib/index.js`);

const PROFILE_DIR = "D:/Program/DSH/home/profiles/web";

/** Candidate loader-row specifiers for the same package, in the forms a patch may use. */
const candidates = [
	"file:///D:/Vault/dsh-plugin-live-diff",
	"D:/Vault/dsh-plugin-live-diff",
	"D:\\Vault\\dsh-plugin-live-diff"
];

for (const specifier of candidates) {
	const report = { specifier };
	// 1. Can Node resolve it from the profile directory at all?
	try {
		const resolved = require.resolve(specifier, { paths: [PROFILE_DIR] });
		report.nodeResolve = resolved;
	} catch (error) {
		report.nodeResolve = `FAILED: ${error.code ?? error.message}`;
	}
	// 2. Does the package manifest declare the client half the boot graph needs?
	try {
		const url = specifier.startsWith("file:")
			? specifier
			: pathToFileURL(specifier).href;
		const manifest = join(new URL(url).pathname.replace(/^\//, ""), "package.json");
		if (existsSync(manifest)) {
			const pkg = JSON.parse(readFileSync(manifest, "utf8"));
			report.packageJson = manifest;
			report.dshClient = pkg.dsh?.client ?? null;
			report.clientExport = pkg.exports?.["./client"] ?? null;
			report.clientFileExists = pkg.exports?.["./client"]?.default
				? existsSync(join(dirname(manifest), pkg.exports["./client"].default))
				: false;
		} else {
			report.packageJson = `MISSING ${manifest}`;
		}
	} catch (error) {
		report.packageJson = `ERROR ${error.message}`;
	}
	console.log(JSON.stringify(report, null, 2));
}

// 3. Is the plugin actually reachable as a bare package name from the profile?
try {
	const resolved = require.resolve("dsh-plugin-live-diff/package.json", { paths: [PROFILE_DIR] });
	console.log(JSON.stringify({ bareName: "dsh-plugin-live-diff", nodeResolve: resolved }, null, 2));
} catch (error) {
	console.log(JSON.stringify({ bareName: "dsh-plugin-live-diff", nodeResolve: `FAILED: ${error.code ?? error.message}` }, null, 2));
}
