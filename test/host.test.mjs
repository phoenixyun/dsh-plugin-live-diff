/**
 * Exercise the host half's diagnostic route end to end, without a server.
 *
 * The route is the whole reason the plugin is debuggable: it is how a browser
 * that the author cannot open reports what it sees. A route that registers but
 * never writes would look identical to "nothing is wrong", so this drives the
 * handler with fake request/response objects and then reads the file back.
 *
 * Run: node test/host.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";

// Point the route at a scratch file before importing the module that reads it.
const scratch = mkdtempSync(join(tmpdir(), "live-diff-host-"));
const logFile = join(scratch, "diag.log");
process.env.DSH_LIVE_DIFF_LOG = logFile;

const host = await import("../lib/index.js");

/** A request stub: the handler reads `method`, `url`, and the stream events. */
function fakeRequest(method, body, url) {
	const req = new EventEmitter();
	req.method = method;
	req.url = url ?? "/live-diff-diag";
	// The handler calls `destroy()` when the body exceeds its cap, so the stub needs
	// it: without this the over-cap branch threw instead of being exercised, which
	// is why that path had no coverage.
	req.destroyed = false;
	req.destroy = () => {
		req.destroyed = true;
	};
	// Emit after the handler has attached its listeners.
	setImmediate(() => {
		if (req.destroyed) return;
		if (body !== void 0) req.emit("data", Buffer.from(body, "utf8"));
		req.emit("end");
	});
	return req;
}

/** A response stub capturing status and body. */
function fakeResponse() {
	const res = { status: null, headers: null, body: "" };
	res.writeHead = (status, headers) => {
		res.status = status;
		res.headers = headers;
	};
	res.end = (value) => {
		res.body = value === void 0 ? "" : String(value);
	};
	return res;
}

/** Capture the route the plugin registers. */
let route;
const ctx = {
	effect: (fn, label) => {
		assert.equal(label, "live-diff: diagnostic route", "the effect is labelled");
		fn();
		return () => {};
	},
	webServer: {
		register: (value) => {
			route = value;
			return () => {};
		}
	},
	// Stands in for the composed browser roster. The plugin reports it rather than
	// inferring from the page, which is gated behind a token this plugin cannot read.
	clientModules: {
		graph: () => ({
			rev: "testrev",
			entries: [
				{ id: "@deepseek-ai/dsh-client-ui-tool", url: "/plugins/??x&rev=1", rev: "1", inject: [], external: [] },
				{ id: "dsh-plugin-live-diff", url: "/plugins/??live&rev=2", rev: "2", inject: ["@deepseek-ai/dsh-client-ui-tool"], external: [] }
			],
			batches: [{ phase: "application", entries: ["dsh-plugin-live-diff"], url: "/plugins/??live&rev=2", rev: "2" }]
		}),
		fetchBundle: () => ({ status: 200, headers: { get: () => "text/javascript; charset=utf-8" } })
	}
};

assert.deepEqual(host.inject, ["webServer", "clientModules"], "the host half declares the services it reads, statically");
host.apply(ctx);

assert.ok(route !== void 0, "apply() registers a route");
assert.equal(route.kind, "prefix", "a prefix route, so any sub-path reaches the handler");
assert.equal(route.path, host.DIAG_PATH, "the path is the exported constant the browser half mirrors");
assert.equal(route.path, "/live-diff-diag", "the path stays distinct from every shipped route");
assert.equal(typeof route.handler, "function", "the handler owns the response");

// A POST carrying a report is written to the log.
const first = fakeResponse();
await route.handler(fakeRequest("POST", JSON.stringify({ reset: true, entryCount: 0, reason: "event window is empty" })), first);
assert.equal(first.status, 200, "a report is accepted");
assert.match(first.body, /ok ->/, "the reply names the log file it wrote");
assert.ok(existsSync(logFile), "the log file exists after the first report");

const lines = () => readFileSync(logFile, "utf8").trim().split("\n");
assert.equal(lines().length, 1, "one report is one line");
const record = JSON.parse(lines()[0]);
assert.equal(record.reason, "event window is empty", "the report body is preserved");
assert.equal(typeof record.at, "string", "each line is timestamped");

// A later report without `reset` appends rather than truncating.
const second = fakeResponse();
await route.handler(fakeRequest("POST", JSON.stringify({ reason: "second" })), second);
assert.equal(lines().length, 2, "a non-reset report appends");
assert.equal(JSON.parse(lines()[1]).reason, "second", "the appended report is the new one");

// A reset report truncates: the panel re-sends on every mount, and an
// append-only log would grow without bound across page reloads.
const third = fakeResponse();
await route.handler(fakeRequest("POST", JSON.stringify({ reset: true, reason: "third" })), third);
assert.equal(lines().length, 1, "a reset report clears earlier lines");
assert.equal(JSON.parse(lines()[0]).reason, "third", "only the newest mount survives");

// A malformed body must still be recorded rather than dropping the evidence.
const bad = fakeResponse();
await route.handler(fakeRequest("POST", "{not json"), bad);
assert.equal(bad.status, 200, "a malformed body is still accepted");
assert.equal(lines().length, 2, "the malformed body is kept");
assert.ok("unparsed" in JSON.parse(lines()[1]), "a malformed body is recorded as unparsed");

// A JSON scalar spreads to nothing; it must not masquerade as a real report.
const scalar = fakeResponse();
await route.handler(fakeRequest("POST", "42"), scalar);
assert.ok("malformed" in JSON.parse(lines()[2]), "a scalar body is recorded as malformed");

// The body must not be able to forge the timestamp.
//
// `at` is written after the spread precisely because `test/granularity.probe.mjs`
// derives its delta-t from that field: a report carrying its own `at` produced
// garbage intervals while looking like a legitimate line.
const forged = fakeResponse();
await route.handler(fakeRequest("POST", JSON.stringify({ at: "1999-01-01T00:00:00.000Z", reason: "forged" })), forged);
const forgedRecord = JSON.parse(lines()[3]);
assert.equal(forgedRecord.reason, "forged", "the report body still lands");
assert.notEqual(forgedRecord.at, "1999-01-01T00:00:00.000Z", "a forged `at` does not survive");
assert.ok(Date.now() - Date.parse(forgedRecord.at) < 60_000, "the timestamp is the host's own clock");

// The log is capped by size, not only by age.
//
// The TTL compares against the file's mtime, and every append refreshes it — so a
// session that reports continuously keeps the file "fresh" forever and the TTL
// never fires. Before this cap the real log reached several MB.
//
// Each report is deliberately kept **under** `readBody`'s 64 KiB cap: an oversized
// body is rejected before it reaches the recorder (asserted separately below), so
// using one here would test the cap by accident.
const pad = "x".repeat(48 * 1024);
let truncated = false;
let previousSize = statSync(logFile).size;
for (let index = 0; index < 60; index += 1) {
	const big = fakeResponse();
	await route.handler(fakeRequest("POST", JSON.stringify({ reason: `bulk ${String(index)}`, pad })), big);
	const size = statSync(logFile).size;
	if (size < previousSize) truncated = true;
	previousSize = size;
}
const cappedSize = statSync(logFile).size;
// The host caps at 2 MiB; allow one oversized append plus slack, since the cap is
// checked before the write.
const LOG_CAP_BYTES = 2 * 1024 * 1024;
assert.ok(truncated, "the size cap truncated the log at least once");
assert.ok(cappedSize < LOG_CAP_BYTES * 1.2,
	`log stayed near the cap (${String(cappedSize)} bytes)`);

// A body over the cap is rejected explicitly, not recorded as an empty report.
const oversized = fakeResponse();
await route.handler(fakeRequest("POST", JSON.stringify({ reason: "huge", pad: "z".repeat(80 * 1024) })), oversized);
const lastRecord = JSON.parse(lines().at(-1));
assert.equal(lastRecord.rejected, "body exceeded the size cap",
	"an over-cap body is recorded as rejected, not as an empty report");

// A GET is the host's own report of the browser roster. This is the reading that
// answers "is my client half in the boot graph?" without needing the GUI token.
const introspect = fakeResponse();
await route.handler(fakeRequest("GET"), introspect);
assert.equal(introspect.status, 200, "a GET is answered");
assert.match(introspect.headers["content-type"], /application\/json/, "the reading is JSON");
const graph = JSON.parse(introspect.body).graph;
assert.equal(graph.available, true, "the graph is available");
assert.equal(graph.entryCount, 2, "every composed entry is counted");
assert.equal(graph.liveDiff.length, 1, "the plugin finds itself in the roster");
assert.equal(graph.liveDiff[0].id, "dsh-plugin-live-diff", "and names itself");
assert.equal(graph.liveDiff[0].rev, "2", "with the revision its URL carries");
assert.ok(graph.batches.some((batch) => batch.entries.includes("dsh-plugin-live-diff")), "it names the batch that ships it");

// The fetch probe reports the status a bundle URL answers — the decisive reading
// for "did the bundle ever reach the browser".
const probed = fakeResponse();
await route.handler(fakeRequest("GET", void 0, "/live-diff-diag?fetch=/plugins/%3F%3Flive%26rev%3D2"), probed);
assert.equal(JSON.parse(probed.body).fetch.status, 200, "the probe reports the bundle status");

// Anything other than GET/POST is refused, so the route stays a diagnostic.
const wrongMethod = fakeResponse();
await route.handler(fakeRequest("DELETE"), wrongMethod);
assert.equal(wrongMethod.status, 405, "another method is refused");
assert.match(wrongMethod.body, /GET or POST only/, "the refusal says why");

rmSync(scratch, { recursive: true, force: true });

console.log("host diagnostics: all assertions passed");
console.log(`  route: ${route.kind} ${route.path}`);
console.log("  behaviour: reset truncates, later reports append, malformed bodies are kept");
