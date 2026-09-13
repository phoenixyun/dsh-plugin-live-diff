/**
 * Proves the streaming reader before anything is mounted in the GUI.
 *
 * The interesting property is not "does it parse JSON" but "does a truncated
 * document still yield usable field text", because that is what the live diff
 * grows from. Every truncation point of a real edit call is exercised.
 *
 * Run: node test/parser.test.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

/** Stable memo so repeated `getSnapshot()` calls return one reference, per React's contract. */
function memoize(getSnapshot) {
	let cached = null;
	let seen = null;
	return () => {
		const next = getSnapshot();
		if (cached !== null && seen === next) return cached;
		seen = next;
		cached = next;
		return cached;
	};
}

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

// Minimal module table + loader facade, mirroring the browser contract.
let registration;
globalThis.window = {
	__ModuleLoader__: {
		load(value) {
			registration = value;
		}
	}
};

const jsxStub = (type, props, children) => ({ type, props, children });
const reactStub = {
	jsx: jsxStub,
	Fragment: Symbol("Fragment"),
	createElement: (type, props, ...children) => ({ type, props, children }),
	useEffect: () => {},
	useCallback: (fn) => fn,
	useRef: (value) => ({ current: value }),
	useMemo: (compute) => compute(),
	useSyncExternalStore: (subscribe, getSnapshot) => memoize(getSnapshot)()
};
const reactRuntimeStub = { jsx: jsxStub, Fragment: Symbol("Fragment") };
const requireStub = (specifier) => {
	if (specifier === "react/jsx-runtime") return reactRuntimeStub;
	if (specifier === "react") return reactStub;
	// The shell's module table exposes the primitives package as a singleton; the
	// card renders through its DiffBlock.
	if (specifier === "@deepseek-ai/dsh-client-ui-primitives") {
		return { DiffBlock: (props) => ({ type: "DiffBlock", props }) };
	}
	throw new Error(`unexpected require: ${specifier}`);
};

new Function(source)();
assert.equal(registration.id, "dsh-plugin-live-diff", "bundle registers its own id");
const plugin = registration.factory(requireStub);
assert.equal(typeof plugin.apply, "function", "factory exposes apply");
assert.deepEqual(
	plugin.inject,
	["slots", "sidebarRightTabs", "sessions"],
	"declares every service it reads — the context proxy throws on an undeclared read"
);

const { readJsonFields, liveDiffOf, diffRows, inFlightDiffs, pathOfRunningCall } = plugin;

// ── the reader tolerates every truncation of a real call ─────────────────────
const full = JSON.stringify({
	file_path: "D:/Vault/notes.md",
	old_string: "alpha\nbeta\ngamma",
	new_string: "alpha\nBETA\ngamma\ndelta",
	replace_all: false
});

const complete = readJsonFields(full);
assert.equal(complete.complete, true, "a closed document reports complete");
assert.equal(complete.fields.get("new_string").value, "alpha\nBETA\ngamma\ndelta", "escapes decode to real newlines");

let sawPartialNewString = 0;
for (let cut = 1; cut < full.length; cut += 1) {
	const partial = readJsonFields(full.slice(0, cut));
	const entry = partial.fields.get("new_string");
	if (entry !== void 0 && entry.value.length > 0 && !entry.complete) sawPartialNewString += 1;
	// The reader must never throw and must never invent a field the text lacks.
	assert.ok(!partial.fields.has("nope"), "no invented fields");
}
assert.ok(sawPartialNewString > 10, `expected many usable partial reads, saw ${sawPartialNewString}`);

// A field still inside its opening quote yields an empty value, not a crash.
const justOpened = readJsonFields('{"new_string":"');
assert.equal(justOpened.fields.get("new_string").value, "", "opened-but-empty string reads as empty");

// A document truncated mid-escape must not emit the backslash or the escape char.
const midEscape = readJsonFields('{"new_string":"abc\\');
assert.equal(midEscape.fields.get("new_string").value, "abc", "dangling escape is dropped, not rendered");

// A non-string field ahead of the one we need must not desynchronize the reader.
const withNumber = readJsonFields('{"replace_all":false,"new_string":"x"}');
assert.equal(withNumber.fields.get("new_string").value, "x", "reader stays aligned across non-string values");

// ── the diff grows as the call arrives ──────────────────────────────────────
const runningBlock = (argsRaw) => ({ callId: "c1", name: "edit", argsRaw, turn: 1, step: 1, time: 0, subCalls: [] });

const grown = [];
for (let cut = 1; cut <= full.length; cut += 1) {
	const diff = liveDiffOf(runningBlock(full.slice(0, cut)), "edit");
	if (diff === null) continue;
	const rows = diffRows(diff);
	grown.push(rows.rows.filter((row) => row.kind === "add").length);
}
assert.ok(grown.length > 10, "the diff materializes well before the call finishes");
assert.ok(grown[grown.length - 1] >= grown[0], "added-line count never regresses across the stream");
assert.ok(Math.max(...grown) > grown[0], "the added side visibly grows while the call streams");
assert.ok(grown.indexOf(grown[grown.length - 1]) < grown.length - 1, "the final count is reached before the last token arrives");

// The final shape trims the common head/tail to context and replaces the middle
// wholesale — the same derivation the shell's own DiffBlock performs. In
// particular it must NOT align: the primitive does no alignment, so aligning
// here would desynchronize the two renderings of the same call.
const finalDiff = liveDiffOf(runningBlock(full), "edit");
const finalRows = diffRows(finalDiff);
assert.deepEqual(
	finalRows.rows.map((row) => `${row.kind[0]}:${row.text}`),
	["c:alpha", "r:beta", "r:gamma", "a:BETA", "a:gamma", "a:delta"],
	"common head stays context; the changed middle is removed then re-added"
);
assert.equal(finalRows.added, 3, "added count matches the added side");
assert.equal(finalRows.removed, 2, "removed count matches the removed side");
assert.equal(finalDiff.streaming, false, "a closed document is not streaming");

// ── write calls render a whole-file add ─────────────────────────────────────
const writeRaw = JSON.stringify({ file_path: "D:/Vault/new.md", content: "one\ntwo" });
const writeDiff = liveDiffOf(runningBlock(writeRaw), "write");
assert.equal(writeDiff.oldText, null, "write has no old side");
assert.deepEqual(diffRows(writeDiff).rows.map((row) => row.kind), ["add", "add"], "write rows are additions");

// An unrelated tool must not be claimed.
assert.equal(liveDiffOf(runningBlock(full), "read"), null, "non-mutation tools fall through");
assert.equal(liveDiffOf({ ...runningBlock(full), parentCallId: "p" }, "edit"), null, "child calls fall through");

// ── the settled block prefers the host's own hunks ──────────────────────────
const settled = {
	kind: "tool-result",
	callId: "c1",
	seq: 2,
	time: 0,
	call: { name: "edit", argsRaw: full },
	callTime: 0,
	content: [],
	isError: false,
	meta: { diffs: [{ path: "D:/Vault/notes.md", oldText: "x", newText: "y" }] },
	subCalls: []
};
const settledDiff = liveDiffOf(settled, "edit");
assert.equal(settledDiff.oldText, "x", "settled view trusts applied metadata");
assert.equal(settledDiff.streaming, false, "settled view never shows a caret");

// ── streaming marks the growing line ────────────────────────────────────────
const partialRaw = '{"file_path":"D:/Vault/notes.md","old_string":"a","new_string":"a\\nb';
const partialRows = diffRows(liveDiffOf(runningBlock(partialRaw), "edit"));
assert.equal(partialRows.streaming, true, "an open document is streaming");
assert.ok(partialRows.rows.some((row) => row.provisional === true), "the last added line is provisional");

// ── the Diffs view's derivation ─────────────────────────────────────────────
// The view reads the raw Session event window, NOT the Chat projection: the
// projection defines blockIsVisible(tool-call) as false, so a streaming edit is
// published hidden and then dropped. These tests pin the event-window shape.
assert.equal(pathOfRunningCall('{"file_path":"D:/Vault/notes.md"'), "D:/Vault/notes.md", "path arrives before content");
assert.equal(pathOfRunningCall('{"file_pa'), "", "an unlanded key yields no path");

/** One client-only live chunk, as `SessionEventWindow.entries` carries it. */
const liveChunk = (index, name, argumentsDelta) => ({
	type: "transient",
	event: { type: "assistant/live-chunk", seq: 1, time: 0, data: { attemptId: "a", turn: 1, step: 1, chunk: { type: "tool-call-delta", index, name, argumentsDelta } } }
});
/** A durable entry, which the reader must ignore. */
const durable = { type: "event", event: { type: "tool/call", seq: 9, time: 0, data: { callId: "c9" } } };

const windowOf = (entries) => ({ entries, hasMore: false, revision: 1, change: { kind: "replace", entries } });

// Growth: the same call split across deltas accumulates into one row.
const splitAt = 70;
const grownWindow = windowOf([
	durable,
	liveChunk(0, "edit", full.slice(0, splitAt)),
	liveChunk(0, undefined, full.slice(splitAt))
]);
const grownEntries = inFlightDiffs(grownWindow);
assert.equal(grownEntries.length, 1, "a streamed tool call produces one row");
assert.equal(grownEntries[0].toolName, "edit", "the row names its tool");
assert.equal(grownEntries[0].diff.path, "D:/Vault/notes.md", "the path is read from the accumulated arguments");
assert.equal(grownEntries[0].diff.streaming, false, "the joined document is complete and not streaming");

// The same call at two points in its stream must differ — that is the growth
// the view renders, and it is the whole point of reading the event log.
const early = inFlightDiffs(windowOf([liveChunk(0, "edit", full.slice(0, full.indexOf('"new_string"') + 38))]));
const late = inFlightDiffs(grownWindow);
assert.equal(early.length, 1, "a partial argument document already produces a row");
assert.equal(early[0].diff.streaming, true, "a truncated document is streaming");
assert.ok(late[0].diff.newText.length > early[0].diff.newText.length, "newText grows across the stream");

// Only the path has arrived: the row exists but carries no content yet.
const pending = inFlightDiffs(windowOf([liveChunk(0, "edit", full.slice(0, 40))]));
assert.equal(pending.length, 1, "the row appears once the path has arrived");
assert.equal(pending[0].diff.newText, "", "no content yet");
assert.equal(pending[0].diff.streaming, true, "still streaming");

// A block boundary ends that stream index's task; stale arguments must not leak.
const afterBlockEnd = inFlightDiffs(windowOf([
	liveChunk(0, "edit", full),
	{ type: "transient", event: { type: "assistant/live-chunk", seq: 2, time: 0, data: { attemptId: "a", turn: 1, step: 1, chunk: { type: "block-end", index: 0, block: {} } } } }
]));
assert.deepEqual(afterBlockEnd, [], "a block end clears the accumulated arguments");

// A write streams its whole payload, so it is the clearest live case.
const writeStream = inFlightDiffs(windowOf([
	liveChunk(0, "write", '{"file_path":"D:/Vault/new.md","content":"a\\nb')
]));
assert.equal(writeStream.length, 1, "a streaming write produces a row");
assert.equal(writeStream[0].diff.oldText, null, "write has no old side");

// Two concurrent calls keep their own indices and order.
const twoCalls = inFlightDiffs(windowOf([
	liveChunk(1, "write", writeRaw),
	liveChunk(0, "edit", full)
]));
assert.deepEqual(twoCalls.map((entry) => entry.callId), ["stream:0", "stream:1"], "rows are ordered by stream index");

// Non-mutation tools are not claimed.
assert.deepEqual(inFlightDiffs(windowOf([liveChunk(0, "read", full)])), [], "non-mutation tools fall through");

// Malformed input must never throw out of a render path.
assert.deepEqual(inFlightDiffs(null), [], "a null window yields no rows");
assert.deepEqual(inFlightDiffs(undefined), [], "an undefined window yields no rows");
assert.deepEqual(inFlightDiffs({}), [], "a window without entries yields no rows");
assert.deepEqual(inFlightDiffs(windowOf([null, durable, { type: "transient" }])), [], "non-chunk entries are skipped");
assert.deepEqual(inFlightDiffs(windowOf([liveChunk(0, "edit", "")])), [], "an empty argument document yields no row");

// ── the diagnostic report ───────────────────────────────────────────────────
// This panel is the plugin's only runtime evidence: the author cannot see the
// browser, so each cause of an empty view must be distinguishable from the text.
const { diagnoseWindow, formatCounts } = plugin;

const healthy = diagnoseWindow(grownWindow);
assert.equal(healthy.entryCount, 3, "counts every entry");
assert.equal(healthy.transientCount, 2, "counts live chunk entries");
assert.equal(healthy.accumulating, 1, "one stream index is still open");
assert.deepEqual(healthy.toolNames, ["edit"], "names the tools seen");
assert.match(healthy.reason, /should be rendering/, "a healthy window says so");
assert.match(formatCounts(healthy.chunkTypes), /tool-call-delta×2/, "chunk types are reported with counts");

const nullWindow = diagnoseWindow(null);
assert.match(nullWindow.reason, /null\/undefined/, "a missing window names itself");
assert.equal(nullWindow.entryCount, 0, "a missing window has no entries");

assert.match(diagnoseWindow({}).reason, /not an array/, "a non-window object names the shape problem");
assert.match(diagnoseWindow(windowOf([])).reason, /empty/, "an empty window names itself");
assert.match(
	diagnoseWindow(windowOf([durable])).reason,
	/no transient/,
	"a window with only durable entries says so — this is the projection-vs-log distinction"
);
// A live chunk of some other kind: transient entries exist, but no tool-call
// delta ever arrives.
const otherChunk = (type) => ({
	type: "transient",
	event: { type: "assistant/live-chunk", seq: 1, time: 0, data: { attemptId: "a", turn: 1, step: 1, chunk: { type, index: 0, text: "hi" } } }
});
const textOnly = diagnoseWindow(windowOf([otherChunk("text-delta")]));
assert.equal(textOnly.transientCount, 1, "a text delta is still a transient entry");
assert.equal(textOnly.deltaCount, 0, "but it is not a tool-call delta");
assert.match(textOnly.reason, /no tool-call-delta/, "chunks arriving without tool-call deltas says so");
assert.match(
	diagnoseWindow(windowOf([liveChunk(0, "edit", full), { type: "transient", event: { type: "assistant/live-chunk", seq: 2, time: 0, data: { attemptId: "a", turn: 1, step: 1, chunk: { type: "block-end", index: 0, block: {} } } } }])).reason,
	/every stream index was closed/,
	"closed deltas are distinguished from absent ones"
);
// Structural surprises must be reported, not thrown.
const oddShapes = diagnoseWindow(windowOf([null, { type: "transient" }, { type: "transient", event: null }]));
assert.equal(oddShapes.entryCount, 3, "odd entries are still counted");
assert.equal(oddShapes.transientCount, 2, "transient entries without a chunk are still counted");
assert.match(formatCounts(oddShapes.chunkTypes), /no chunk/, "a missing chunk is reported as such");

console.log("parser + diff: all assertions passed");
console.log(`  truncation points yielding a partial new_string: ${sawPartialNewString}`);
console.log(`  added-line growth: ${grown[0]} -> ${grown[grown.length - 1]}`);
console.log(`  event window -> diff rows: ${grownWindow.entries.length} entries -> ${grownEntries.length} row`);
console.log(`  diagnostics: ${healthy.reason}`);
