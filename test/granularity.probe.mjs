/**
 * Measure how granular the streamed diff actually is.
 *
 * "The diff appears in chunks, not character by character" is a question about
 * the data, and it has a numeric answer: the delta count between consecutive
 * reports, and the wall-clock gap between them. If the transport batches, no
 * amount of client-side tuning makes it finer — so measure before tuning.
 *
 * Run: node test/granularity.probe.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const logPath = process.env.DSH_LIVE_DIFF_LOG ?? join(here, "..", "diag.log");

let raw;
try {
	raw = readFileSync(logPath, "utf8");
} catch {
	console.log(`no log at ${logPath} — run an edit first`);
	process.exit(0);
}

const rows = raw.trim().split("\n")
	.map((line) => {
		try {
			return JSON.parse(line);
		} catch {
			return null;
		}
	})
	.filter((entry) => entry !== null)
	.filter((entry) => Array.isArray(entry.toolNames) && entry.toolNames.includes("write") && typeof entry.deltaCount === "number" && entry.deltaCount > 0);

console.log(`write reports with deltas: ${rows.length}`);
if (rows.length < 3) {
	console.log("not enough samples — run a longer write first");
	process.exit(0);
}

const steps = [];
for (let index = 1; index < rows.length; index += 1) {
	const dt = (new Date(rows[index].at) - new Date(rows[index - 1].at)) / 1000;
	const dd = rows[index].deltaCount - rows[index - 1].deltaCount;
	if (dd > 0 && dt >= 0) steps.push({ dt, dd });
}

const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
const avgDt = sum(steps, (s) => s.dt) / steps.length;
const avgDd = sum(steps, (s) => s.dd) / steps.length;
const minDd = Math.min(...steps.map((s) => s.dd));
const maxDd = Math.max(...steps.map((s) => s.dd));

// Deltas per second is what the transport actually delivers.
const rate = avgDd / Math.max(avgDt, 1e-6);

console.log(`  report interval : ${avgDt.toFixed(3)} s`);
console.log(`  deltas per step : avg ${avgDd.toFixed(1)}  min ${minDd}  max ${maxDd}`);
console.log(`  transport rate  : ~${rate.toFixed(0)} deltas/s`);
console.log("");
console.log("What a faster poll would buy, at the same transport rate:");
for (const interval of [250, 120, 60, 30]) {
	console.log(`  poll ${String(interval).padStart(3)} ms -> ~${(rate * interval / 1000).toFixed(1)} deltas shown per update`);
}
console.log("");
console.log("A step of 1 delta (true per-token rendering) would need the transport to");
console.log(`deliver ~${(1000 / Math.max(avgDt, 1e-6)).toFixed(0)} frames/s. It delivers ~${rate.toFixed(0)} deltas/s in ${steps.length} bursts.`);
