/**
 * Live streaming diffs for DSH file mutations.
 *
 * The shipped Tool view derives its diff with `JSON.parse(argsRaw)`, so while
 * the model is still emitting an `edit` / `write` call the arguments are a
 * truncated JSON document, the parse throws, and the card stays empty until the
 * very last token lands. This plugin keeps a tolerant reader over the same
 * `argsRaw`, so the diff is rendered from the first characters onward and grows
 * as the arguments arrive.
 *
 * Three mechanics, each borrowed from Cline's shipped diff view (they are what
 * make a streaming diff feel alive, and none of them is the visual styling):
 *
 *   1. Never bail on an incomplete block — degrade to what has arrived. Cline's
 *      parser returns the SEARCH side alone when the `=======` separator has not
 *      landed yet, and everything after it as additions when `+++++++ REPLACE`
 *      has not landed. Here the equivalent is a reader that returns a field
 *      whose value string is still open instead of refusing it.
 *   2. Infer "still streaming" from the text itself rather than a completion
 *      signal. Cline counts markers (`REPLACE` occurrences < `SEARCH`
 *      occurrences); here it is "the JSON document has not closed".
 *   3. Pin the viewport to the newest line while streaming, releasing the moment
 *      the reader scrolls away. Without this a long diff grows off-screen and
 *      the growth is invisible.
 *
 * Rendering is delegated to DSH's own `DiffBlock` primitive, so the card matches
 * the shell's diff chrome exactly and inherits its collapse, copy button, and
 * summary footer. Only the row derivation and the viewport pin are ours.
 *
 * Bundle form follows the client module system's contract: the served
 * `client.js` registers its own factory (`comboSource` passes bytes through
 * verbatim), and the factory receives the module table's synchronous `require`.
 * Nothing here is rewritten at build time.
 */

window.__ModuleLoader__.load({
	id: "dsh-plugin-live-diff",
	factory: (require) => {
		const { jsx } = require("react/jsx-runtime");
		const { useEffect, useRef, useState, useSyncExternalStore } = require("react");
		const { DiffBlock } = require("@deepseek-ai/dsh-client-ui-primitives");

const EMPTY = "";

/** Viewport height of a streaming card, so a long diff scrolls inside itself. */
const LIVE_MAX_HEIGHT_PX = 320;
/** Rows fed to the primitive while streaming; it collapses to `maxLines` anyway. */
const LIVE_MAX_LINES = 16;
/** Distance from the bottom, in pixels, still counted as "following the stream". */
const FOLLOW_THRESHOLD_PX = 24;

// ─────────────────────────── partial-JSON reading ───────────────────────────

/** True for a character code that may appear unescaped inside a JSON string. */
function isPlainStringChar(code) {
	return code >= 0x20 && code !== 0x22 && code !== 0x5c;
}

/**
 * Decode one JSON string body from `raw` starting at the opening quote.
 * Tolerates a body that is not closed yet or ends mid-escape, which is exactly
 * the shape a streaming argument has.
 * @param raw - the JSON document text.
 * @param start - index of the opening quote.
 * @returns the decoded text plus where it ended, or null when no quote opens there.
 */
function readJsonString(raw, start) {
	if (raw.charCodeAt(start) !== 0x22) return null;
	let out = EMPTY;
	let index = start + 1;
	while (index < raw.length) {
		const code = raw.charCodeAt(index);
		if (code === 0x22) return { text: out, end: index + 1, complete: true };
		if (code !== 0x5c) {
			out += isPlainStringChar(code) ? raw[index] : EMPTY;
			index += 1;
			continue;
		}
		const escape = raw[index + 1];
		if (escape === void 0) return { text: out, end: raw.length, complete: false };
		if (escape === "u") {
			const hex = raw.slice(index + 2, index + 6);
			if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return { text: out, end: raw.length, complete: false };
			const point = Number.parseInt(hex, 16);
			out += point === 0 ? EMPTY : String.fromCharCode(point);
			index += 6;
			continue;
		}
		const decoded = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[escape];
		if (decoded === void 0) return { text: out, end: raw.length, complete: false };
		out += decoded;
		index += 2;
	}
	return { text: out, end: raw.length, complete: false };
}

/**
 * Read the string fields of a possibly truncated JSON object.
 * Walks the document instead of parsing it: a field whose value string is still
 * open comes back with `complete: false`, and fields whose text has not started
 * yet are simply absent. That is what makes a half-arrived `new_string`
 * renderable.
 * @param raw - raw argument text, complete or truncated.
 * @returns decoded field values plus whether the document closed.
 */
function readJsonFields(raw) {
	const fields = new Map();
	if (typeof raw !== "string" || raw === EMPTY) return { fields, complete: false };
	let index = 0;
	let complete = false;
	while (index < raw.length && /\s/.test(raw[index])) index += 1;
	// The document may still be nothing but its opening brace.
	if (raw[index] !== "{") return { fields, complete: false };
	index += 1;
	while (index < raw.length) {
		while (index < raw.length && /\s/.test(raw[index])) index += 1;
		if (index >= raw.length) break;
		if (raw[index] === "}") {
			complete = true;
			break;
		}
		if (raw[index] !== '"') break;
		const keyRead = readJsonString(raw, index);
		if (keyRead === null) break;
		index = keyRead.end;
		while (index < raw.length && /\s/.test(raw[index])) index += 1;
		if (raw[index] !== ":") break;
		index += 1;
		while (index < raw.length && /\s/.test(raw[index])) index += 1;
		if (raw.charCodeAt(index) === 0x22) {
			const valueRead = readJsonString(raw, index);
			if (valueRead === null) break;
			fields.set(keyRead.text, { value: valueRead.text, complete: valueRead.complete });
			index = valueRead.end;
			if (!valueRead.complete) break;
		} else {
			// A non-string value (number, boolean, null, nested object): skip it so
			// the reader stays aligned, without decoding anything we do not need.
			// Every branch must advance, or a truncated document would spin here.
			let depth = 0;
			while (index < raw.length) {
				const code = raw.charCodeAt(index);
				if (code === 0x22) {
					const skipped = readJsonString(raw, index);
					if (skipped === null) break;
					index = skipped.end;
					if (!skipped.complete) break;
					continue;
				}
				if (depth === 0 && (code === 0x7d || code === 0x5d || code === 0x2c)) break;
				if (code === 0x7b || code === 0x5b) depth += 1;
				else if (code === 0x7d || code === 0x5d) depth -= 1;
				index += 1;
			}
		}
		while (index < raw.length && /\s/.test(raw[index])) index += 1;
		if (raw[index] === ",") {
			index += 1;
			continue;
		}
		if (raw[index] === "}") {
			complete = true;
			break;
		}
		break;
	}
	return { fields, complete };
}

/** Collect a field's text, treating an absent field as empty. */
function fieldText(fields, name) {
	const entry = fields.get(name);
	return entry === void 0 ? EMPTY : entry.value;
}

/**
 * Derive the diff material of one running or settled file-mutation call.
 * @param block - Tool block; `kind` absent means the call is still running.
 * @param toolName - wire Tool name.
 * @returns diff material, or null when this call is not a file mutation.
 */
function liveDiffOf(block, toolName) {
	if (block === null || typeof block !== "object") return null;
	if (block.parentCallId !== void 0) return null;
	if (toolName !== "edit" && toolName !== "write") return null;

	// A settled block carries the authoritative hunks the host computed; prefer
	// them so the final picture never depends on our own reconstruction.
	if ("kind" in block) {
		if (block.isError) return null;
		const applied = appliedDiffs(block.meta);
		if (applied !== null) return { path: applied[0].path, oldText: applied[0].oldText, newText: applied[0].newText, streaming: false, replaceAll: false };
	}

	const call = "kind" in block ? block.call : block;
	if (call === null || call === void 0) return null;
	const { fields, complete } = readJsonFields(call.argsRaw);
	const path = fieldText(fields, "file_path") || fieldText(fields, "path");

	if (toolName === "write") {
		const content = fields.get("content");
		if (content === void 0) return path === EMPTY ? null : { path, oldText: null, newText: EMPTY, streaming: true, replaceAll: false };
		return { path, oldText: null, newText: content.value, streaming: !complete, replaceAll: false };
	}

	const oldEntry = fields.get("old_string");
	const newEntry = fields.get("new_string");
	if (oldEntry === void 0 && newEntry === void 0) {
		return path === EMPTY ? null : { path, oldText: EMPTY, newText: EMPTY, streaming: true, replaceAll: fieldText(fields, "replace_all") === "true" };
	}
	return {
		path,
		oldText: fieldText(fields, "old_string"),
		newText: fieldText(fields, "new_string"),
		streaming: !complete || (newEntry !== void 0 && !newEntry.complete) || (oldEntry !== void 0 && !oldEntry.complete),
		replaceAll: fieldText(fields, "replace_all") === "true"
	};
}

/** Narrow the host's applied `meta.diffs` to the first well-formed hunk. */
function appliedDiffs(meta) {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
	const diffs = meta.diffs;
	if (!Array.isArray(diffs) || diffs.length === 0) return null;
	const first = diffs[0];
	if (typeof first !== "object" || first === null) return null;
	const { path, oldText, newText } = first;
	if (typeof path !== "string") return null;
	if (oldText !== null && typeof oldText !== "string") return null;
	if (typeof newText !== "string") return null;
	return [{ path, oldText, newText }];
}

/** Split text into diff rows. */
function splitLines(text) {
	return String(text ?? EMPTY).split("\n");
}

/**
 * Diff rows for a targeted replacement.
 *
 * Matches the shell's own derivation (`dsh-client-ui-primitives`' row builder):
 * common leading and trailing lines are trimmed for context, and the remaining
 * middle is emitted as removals followed by additions. The primitive does no
 * line alignment of its own, so aligning here would only desynchronize the two
 * renderings; a middle that is too large to align is treated as a block anyway.
 * @param oldLines - lines being replaced.
 * @param newLines - replacement lines.
 * @returns diff rows in reading order.
 */
function alignDiff(oldLines, newLines) {
	const rows = [];
	let head = 0;
	while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1;
	let tail = 0;
	while (
		tail < oldLines.length - head &&
		tail < newLines.length - head &&
		oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
	) tail += 1;

	for (let index = 0; index < head; index += 1) rows.push({ kind: "context", text: oldLines[index] });
	for (let index = head; index < oldLines.length - tail; index += 1) rows.push({ kind: "remove", text: oldLines[index] });
	for (let index = head; index < newLines.length - tail; index += 1) rows.push({ kind: "add", text: newLines[index] });
	for (let index = oldLines.length - tail; index < oldLines.length; index += 1) rows.push({ kind: "context", text: oldLines[index] });
	return rows;
}

/**
 * Turn diff material into renderable rows.
 * The final added line is marked provisional while streaming, so the card can
 * draw its caret there.
 * @param diff - material from {@link liveDiffOf}.
 * @returns rows, counts, and whether the body was clipped.
 */
function diffRows(diff) {
	const oldSide = splitLines(diff.oldText ?? EMPTY);
	const newSide = splitLines(diff.newText);
	const rows = diff.oldText === null
		? newSide.map((text) => ({ kind: "add", text }))
		: alignDiff(oldSide, newSide);

	if (diff.streaming) {
		for (let index = rows.length - 1; index >= 0; index -= 1) {
			if (rows[index].kind === "add") {
				rows[index] = { ...rows[index], provisional: true };
				break;
			}
		}
	}

	let added = 0;
	let removed = 0;
	for (const row of rows) {
		if (row.kind === "add") added += 1;
		else if (row.kind === "remove") removed += 1;
	}
	return { rows, added, removed, streaming: diff.streaming };
}

// ─────────────────────────────── presentation ───────────────────────────────

const pluginTag = "dsh-plugin-live-diff";
// Fixed colours, not theme variables. This plugin rendered into a white sidebar
// with inherited (i.e. white-on-white) text once, which is indistinguishable from
// "nothing rendered" — so every surface it owns states its own colours.
const INK = "#c9d1d9";
const INK_DIM = "#8b949e";
const PANEL_BG = "#0d1117";
const PANEL_BORDER = "#30363d";
const ADD = "#3fb950";
const DEL = "#f85149";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const CSS = [
	`[data-plugin-css="${pluginTag}"] .dshld_root{display:flex;flex-direction:column;gap:4px;margin:6px 0;color:${INK}}`,
	`[data-plugin-css="${pluginTag}"] .dshld_bar{display:flex;align-items:center;gap:8px;padding:0 2px;font-size:12px;color:${INK_DIM}}`,
	`[data-plugin-css="${pluginTag}"] .dshld_path{font-family:${MONO};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${INK}}`,
	`[data-plugin-css="${pluginTag}"] .dshld_add{color:${ADD};flex:none}`,
	`[data-plugin-css="${pluginTag}"] .dshld_del{color:${DEL};flex:none}`,
	`[data-plugin-css="${pluginTag}"] .dshld_live{display:inline-flex;align-items:center;gap:5px;flex:none;margin-left:auto;font-size:11px;color:${ADD}}`,
	`[data-plugin-css="${pluginTag}"] .dshld_dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:dshld_pulse 1s ease-in-out infinite}`,
	"@keyframes dshld_pulse{0%,100%{opacity:.25}50%{opacity:1}}",
	`[data-plugin-css="${pluginTag}"] .dshld_caret{display:inline-block;width:6px;margin-left:1px;background:currentColor;animation:dshld_blink 1s steps(2,start) infinite;vertical-align:baseline}`,
	"@keyframes dshld_blink{0%,100%{opacity:1}50%{opacity:0}}",
	`[data-plugin-css="${pluginTag}"] .dshld_body{max-height:320px;overflow:auto;border:1px solid ${PANEL_BORDER};border-radius:6px;background:${PANEL_BG};padding:6px 8px;color:${INK};font-family:${MONO};font-size:12px}`,
	// The primitive's own diff rows are themed; this pane may not have those
	// variables bound, so state a readable colour here too.
	`[data-plugin-css="${pluginTag}"] .dshld_body *{color:${INK}}`
].join("");

/** Inject this plugin's stylesheet once, tagged so DSH can attribute it. */
function ensureStyles() {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${pluginTag}"]`) !== null) return;
	const style = document.createElement("style");
	style.dataset.plugin = pluginTag;
	style.dataset.pluginCss = pluginTag;
	style.textContent = CSS;
	document.head.appendChild(style);
}

/** Trim a path to something readable in a chat row. */
function shortPath(path, cwd) {
	if (typeof path !== "string" || path === EMPTY) return "(pending)";
	const normalized = path.replace(/\\/g, "/");
	if (typeof cwd === "string" && cwd !== EMPTY) {
		const root = cwd.replace(/\\/g, "/").replace(/\/$/, "");
		if (normalized === root) return normalized;
		if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
	}
	return normalized;
}

/** The `DiffBlock` label set: only the three strings the card chrome reads. */
const DIFF_LABELS = {
	copy: "copy",
	copied: "copied",
	files: (count) => `${String(count)} file${count === 1 ? EMPTY : "s"}`
};

/**
 * Read just the target path out of a running call's arguments.
 * Cheaper than {@link liveDiffOf} and available earlier: the path is the first
 * field the model emits, so a row can name its file before any content arrives.
 * @param argsRaw - the call's raw argument text, possibly truncated.
 * @returns the path, or empty when it has not arrived yet.
 */
function pathOfRunningCall(argsRaw) {
	const { fields } = readJsonFields(argsRaw);
	return fieldText(fields, "file_path") || fieldText(fields, "path");
}

/**
 * Live diff rows read from the raw Session event window.
 *
 * This is the only source that can show a file edit *growing*, and the three
 * wrong turns that led here are worth recording:
 *
 * - `snapshot.runningCalls` cannot. The host dispatches a call only after the
 *   model has finished streaming its arguments, so `argsRaw` is already complete
 *   on arrival, and the call then executes in milliseconds.
 * - `snapshot.partial.blocks` cannot. The Chat projection defines
 *   `blockIsVisible(block)` as `false` for `kind === "tool-call"`, so a step
 *   whose only block is a tool call is published with `visibility: "hidden"`,
 *   and `legacyContribution` then drops that hidden non-assistant node. The
 *   growing arguments are pruned by design.
 * - the raw event window can. `SessionBinding.eventSource` exposes a
 *   `SessionEventWindow` whose entries include client-only
 *   `AssistantLiveChunkEvent`s carrying the original `StreamChunk`s — including
 *   every `tool-call-delta`. The projection discards tool calls; the event log
 *   does not.
 *
 * @param window - `SessionBinding.eventSource.getSnapshot()`.
 * @returns one entry per in-flight file mutation, in call order.
 */
function inFlightDiffs(window) {
	const entries = [];
	if (window === null || window === void 0 || !Array.isArray(window.entries)) return entries;
	/** Streamed Tool calls keyed by their stream index; `raw` grows per delta. */
	const open = new Map();
	for (const entry of window.entries) {
		if (entry === null || typeof entry !== "object" || entry.type !== "transient") continue;
		const chunk = entry.event === null || entry.event === void 0 ? void 0 : entry.event.data?.chunk;
		if (chunk === null || chunk === void 0 || typeof chunk !== "object") continue;
		if (chunk.type === "tool-call-delta") {
			const index = chunk.index;
			const previous = open.get(index);
			const delta = typeof chunk.argumentsDelta === "string" ? chunk.argumentsDelta : EMPTY;
			open.set(index, {
				index,
				name: typeof chunk.name === "string" && chunk.name !== EMPTY
					? chunk.name
					: previous === void 0 ? EMPTY : previous.name,
				raw: (previous === void 0 ? EMPTY : previous.raw) + delta
			});
			continue;
		}
		// A block boundary replaces that stream index's task, so arguments
		// accumulated for it must not leak into the next one.
		if (chunk.type === "block-end" || chunk.type === "block-start") open.delete(chunk.index);
	}

	for (const state of [...open.values()].sort((left, right) => left.index - right.index)) {
		if (state.name !== "edit" && state.name !== "write") continue;
		// A flat `{ name, argsRaw }` is the shape `liveDiffOf` reads for a running
		// call; there is no settled `call` wrapper here.
		const diff = liveDiffOf({ name: state.name, argsRaw: state.raw }, state.name);
		if (diff === null) continue;
		entries.push({ callId: `stream:${String(state.index)}`, toolName: state.name, diff });
	}
	return entries;
}

/**
 * Count what the event window actually contains, without trusting any single
 * field name.
 *
 * Written to be the *only* way this plugin can learn anything at runtime: the
 * author cannot see the browser, so when the view is empty this tally is the
 * evidence. It therefore reports several independent readings of the same
 * window — entry `type` values, chunk `type` values, tool names, and progress —
 * so a wrong assumption about the wire shape shows up as a specific zero rather
 * than as a blank panel.
 * @param window - `SessionBinding.eventSource.getSnapshot()`, or anything else.
 * @returns counters safe to render, never throwing.
 */
function diagnoseWindow(window) {
	const report = {
		shape: typeof window,
		entryCount: 0,
		hasEntries: false,
		entryTypes: new Map(),
		chunkTypes: new Map(),
		toolNames: [],
		transientCount: 0,
		deltaCount: 0,
		accumulating: 0,
		sequence: EMPTY,
		reason: EMPTY
	};
	if (window === null || window === void 0) {
		report.reason = "event window is null/undefined";
		return report;
	}
	if (!Array.isArray(window.entries)) {
		report.reason = "window.entries is not an array";
		return report;
	}
	report.hasEntries = true;
	report.entryCount = window.entries.length;

	const open = new Set();
	/** Compressed chunk-type sequence: `b0×1, d1×30, e0×1`. See below for why. */
	const sequence = [];
	for (const entry of window.entries) {
		if (entry === null || typeof entry !== "object") continue;
		const entryType = typeof entry.type === "string" ? entry.type : "(no type)";
		report.entryTypes.set(entryType, (report.entryTypes.get(entryType) ?? 0) + 1);
		if (entryType === "transient") report.transientCount += 1;

		// Reach the chunk without assuming the entry wrapper: a transient entry
		// carries `event.data.chunk`, but report whatever is actually there.
		const event = entry.event;
		const chunk = event === null || event === void 0 ? void 0 : event.data?.chunk;
		if (chunk === null || chunk === void 0 || typeof chunk !== "object") {
			if (entryType === "transient") report.chunkTypes.set("(no chunk)", (report.chunkTypes.get("(no chunk)") ?? 0) + 1);
			continue;
		}
		const chunkType = typeof chunk.type === "string" ? chunk.type : "(no chunk.type)";
		report.chunkTypes.set(chunkType, (report.chunkTypes.get(chunkType) ?? 0) + 1);
		// Counts alone cannot show *order*, and order is the whole question here:
		// if `block-start` ever lands after that stream index's deltas, treating it
		// as a reset silently discards the arguments accumulated so far. Collapse
		// runs of the same (type, index) so the tail stays small on the wire.
		const mark = `${chunkType.charAt(0)}${String(chunk.index)})`;
		const last = sequence[sequence.length - 1];
		if (last !== void 0 && last.mark === mark) last.count += 1;
		else sequence.push({ mark, count: 1 });
		if (chunkType === "tool-call-delta") {
			report.deltaCount += 1;
			if (typeof chunk.name === "string" && !report.toolNames.includes(chunk.name)) report.toolNames.push(chunk.name);
			open.add(chunk.index);
		} else if (chunkType === "block-end" || chunkType === "block-start") {
			open.delete(chunk.index);
		}
	}
	report.sequence = sequence
		.slice(-12)
		.map((run) => `${run.mark}${run.count > 1 ? `x${String(run.count)}` : EMPTY}`)
		.join(" ");
	report.accumulating = open.size;
	if (report.reason === EMPTY) {
		// Order matters: each branch must name the *first* thing that is missing, so
		// a specific zero points at the actual layer that dropped the data.
		if (report.entryCount === 0) report.reason = "event window is empty";
		else if (report.transientCount === 0) report.reason = "no transient (live chunk) entries in the window";
		else if (report.deltaCount === 0) report.reason = "no tool-call-delta chunks arrived";
		else if (report.accumulating === 0) report.reason = `saw ${String(report.deltaCount)} delta(s), but every stream index was closed`;
		else report.reason = "deltas present — the view should be rendering";
	}
	return report;
}

/** Render a counter map as a stable, readable string. */
function formatCounts(counts) {
	if (counts === null || counts === void 0 || counts.size === 0) return "(none)";
	return [...counts.entries()].map(([key, value]) => `${key}×${String(value)}`).join(", ");
}

/** Host route the report is posted to; mirrors the host half's `DIAG_PATH`. */
const DIAG_ENDPOINT = "/live-diff-diag";

/**
 * Post one diagnostic report to the host, which appends it to a file.
 *
 * This exists because the plugin's author cannot read the browser: the Web
 * surface is gated by a per-process token that never reaches disk, so the page is
 * unreachable to local tooling. The browser already holds its own session, so the
 * page reports itself instead. Failures are swallowed — a diagnostic channel must
 * never break the surface it observes.
 * @param payload - the report to send.
 * @returns the host's reply text, or the failure reason.
 */
async function beacon(payload) {
	try {
		const response = await fetch(DIAG_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			keepalive: true
		});
		return await response.text();
	} catch (error) {
		return `beacon failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * Flatten a report for the wire: its counters are `Map`s, which do not survive
 * `JSON.stringify`.
 * @param report - the report from {@link diagnoseWindow}, or null.
 * @param entryCount - how many diff rows the view derived.
 * @returns a plain object.
 */
function reportPayload(report, entryCount) {
	if (report === null || report === void 0) return { entryCount, report: null };
	return {
		entryCount,
		windowEntries: report.entryCount,
		transientCount: report.transientCount,
		deltaCount: report.deltaCount,
		accumulating: report.accumulating,
		sequence: report.sequence,
		entryTypes: formatCounts(report.entryTypes),
		chunkTypes: formatCounts(report.chunkTypes),
		toolNames: report.toolNames,
		reason: report.reason
	};
}

// ───────────────────────────── the overlay panel ────────────────────────────

/** Element id of the fixed diff overlay. */
const OVERLAY_ID = "dsh-live-diff-overlay";
/** Whether the panel is collapsed, remembered across re-renders. */
let overlayCollapsed = false;
/** Storage key for the dragged panel width. */
const WIDTH_KEY = "dsh-live-diff:width";
/** Default / minimum / margin from the viewport's right edge, in px. */
const WIDTH_DEFAULT = 440;
const WIDTH_MIN = 280;
const WIDTH_MARGIN = 12;
/** How far from the left edge the resize strip is grabbable, in px. */
const RESIZE_GRIP = 6;

/**
 * The width to open with: the last dragged value if one was stored.
 *
 * `localStorage` can throw (disabled storage, a partitioned frame, a sandboxed
 * preview), and a preference is never worth breaking the panel over — so every
 * access is guarded and the default stands in on any failure.
 * @returns width in px.
 */
function storedWidth() {
	try {
		const raw = window.localStorage.getItem(WIDTH_KEY);
		const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
		if (Number.isFinite(value) && value >= WIDTH_MIN) return value;
	} catch {
		// fall through to the default
	}
	return WIDTH_DEFAULT;
}

/** Remember a dragged width. Failures are ignored (see {@link storedWidth}). */
function storeWidth(width) {
	try {
		window.localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
	} catch {
		// ignore
	}
}

/** The widest the panel may become: leave a margin so the resize stay grabbable. */
function maxWidth() {
	const viewport = document.documentElement === null ? 0 : document.documentElement.clientWidth;
	return Math.max(WIDTH_MIN, viewport - 2 * WIDTH_MARGIN);
}
/**
 * The last non-empty read's structural material, kept so a finished edit stays on
 * screen. `entries` empties the instant a call settles; blanking then would erase
 * the diff the reader was watching.
 *
 * This holds the diff objects, not markup: the incremental patcher needs the row
 * models to compare against what is already in the DOM. An empty array means
 * "nothing has ever been shown".
 */
let overlayLastDiffs = [];
/** How many diffs `overlayLastDiffs` holds, for the header chip. */
let overlayLastCount = 0;

/**
 * Escape text for insertion as markup.
 * Diff content is arbitrary file text, so it is never trusted as HTML.
 * @param text - raw text.
 * @returns escaped text.
 */
function escapeHtml(text) {
	return String(text ?? EMPTY)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// ───────────────────────────── syntax colouring ─────────────────────────────

/**
 * Tokenise source text for display colouring.
 *
 * Deliberately not a real highlighter: no grammar, no state across lines, no
 * nesting beyond strings and comments. The goal is a diff that reads at a glance
 * — keywords, strings and comments separated from prose — not an editor. A
 * wrong token is a cosmetic slip, never a security or correctness one, because
 * every token is escaped before it reaches the DOM.
 *
 * Regex alternation was avoided on purpose: it is easy to write a pattern set
 * that mis-colours unterminated strings, and a scan is easier to reason about.
 *
 * @param text - raw source line.
 * @param language - profile key from {@link LANGUAGE_PROFILES} ("text" disables).
 * @returns escaped HTML.
 */
function highlightLine(text, language) {
	const source = String(text ?? EMPTY);
	const profile = LANGUAGE_PROFILES[language];
	if (profile === void 0 || language === "text") return escapeHtml(source);

	const out = [];
	let plain = EMPTY;
	const flush = () => {
		if (plain === EMPTY) return;
		out.push(escapeHtml(plain));
		plain = EMPTY;
	};
	const emit = (cls, value) => {
		flush();
		out.push(`<span class="t-${cls}">${escapeHtml(value)}</span>`);
	};

	let index = 0;
	while (index < source.length) {
		const rest = source.slice(index);

		// Line-level markers first: in most languages a comment swallows
		// everything after it, including quotes.
		const marker = profile.lineComments.find((candidate) => rest.startsWith(candidate));
		if (marker !== void 0) {
			emit("cm", rest);
			break;
		}

		if (profile.tripleQuotes && rest.startsWith('"""')) {
			emit("st", rest);
			break;
		}

		const code = source.charCodeAt(index);
		const quoted = profile.quotes.includes(source[index]);
		if (quoted) {
			let cursor = index + 1;
			while (cursor < source.length) {
				const ch = source[cursor];
				if (ch === "\\") {
					cursor += 2;
					continue;
				}
				if (ch === source[index]) {
					cursor += 1;
					break;
				}
				cursor += 1;
			}
			emit("st", source.slice(index, cursor));
			index = cursor;
			continue;
		}

		if (code >= 0x30 && code <= 0x39) {
			let cursor = index;
			while (cursor < source.length && /[0-9a-fA-FxX_.]/.test(source[cursor])) cursor += 1;
			emit("nu", source.slice(index, cursor));
			index = cursor;
			continue;
		}

		const isWordStart = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code > 0x7f;
		if (isWordStart) {
			let cursor = index;
			while (cursor < source.length) {
				const ch = source.charCodeAt(cursor);
				if ((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) || (ch >= 0x30 && ch <= 0x39) || ch === 0x5f || ch > 0x7f) cursor += 1;
				else break;
			}
			const word = source.slice(index, cursor);
			index = cursor;
			if (profile.keywords.has(word)) {
				emit("kw", word);
				continue;
			}
			if (profile.types.has(word)) {
				emit("ty", word);
				continue;
			}
			plain += word;
			continue;
		}

		plain += source[index];
		index += 1;
	}

	flush();
	return out.join(EMPTY);
}

/** Keyword / comment / quote shape per language family. */
const LANGUAGE_PROFILES = (() => {
	const pyKeywords = new Set(("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self").split(" "));
	const jsKeywords = new Set(("async await break case catch class const continue default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield null true false undefined").split(" "));
	const shKeywords = new Set(("if then else elif fi for while do done case esac function return export local readonly set unset shift source alias echo cd exit trap in").split(" "));
	const commonTypes = new Set(("int float str bool bytes list dict set tuple Any Optional List Dict Set Tuple Union Callable Iterable Iterator Sequence Mapping Type TypeVar Final ClassVar").split(" "));
	return {
		python: { keywords: pyKeywords, types: commonTypes, lineComments: ["#"], quotes: ['"', "'"], tripleQuotes: true },
		shell: { keywords: shKeywords, types: new Set(), lineComments: ["#"], quotes: ['"', "'"], tripleQuotes: false },
		yaml: { keywords: new Set(("true false null yes no on off").split(" ")), types: new Set(), lineComments: ["#"], quotes: ['"', "'"], tripleQuotes: false },
		javascript: { keywords: jsKeywords, types: commonTypes, lineComments: ["//"], quotes: ['"', "'", "`"], tripleQuotes: false },
		typescript: { keywords: jsKeywords, types: commonTypes, lineComments: ["//"], quotes: ['"', "'", "`"], tripleQuotes: false },
		json: { keywords: new Set(["true", "false", "null"]), types: new Set(), lineComments: [], quotes: ['"'], tripleQuotes: false },
		markdown: { keywords: new Set(), types: new Set(), lineComments: [], quotes: [], tripleQuotes: false },
		text: { keywords: new Set(), types: new Set(), lineComments: [], quotes: [], tripleQuotes: false }
	};
})();

/** Map a path's extension to a profile key. */
function languageOf(path) {
	const name = String(path ?? EMPTY).toLowerCase().replace(/\\/g, "/").split("/").pop() ?? EMPTY;

	// Name-shaped detection runs before extension detection: `.env.local` has the
	// extension `local`, and a suffix-first check would classify it as plain text
	// even though its basename says exactly what it is. Same for Dockerfile.
	if (name === "dockerfile" || name === "makefile" || name.startsWith(".env")) return "shell";

	const dot = name.lastIndexOf(".");
	if (dot < 0) return "text";
	const ext = name.slice(dot + 1);
	if (ext === "py" || ext === "pyi") return "python";
	if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "javascript";
	if (ext === "ts" || ext === "tsx" || ext === "mts" || ext === "cts") return "typescript";
	if (ext === "json" || ext === "jsonc") return "json";
	if (ext === "yaml" || ext === "yml") return "yaml";
	if (ext === "md" || ext === "markdown") return "markdown";
	if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "ps1" || ext === "psm1") return "shell";
	return "text";
}

// ────────────────────── incremental list view (anti-flicker) ─────────────────
//
// Why not `innerHTML`
// -------------------
// The first version rebuilt the list with `list.innerHTML = markup` on every
// update. This panel is polled at 80 ms, so that is ~12 full teardowns *per
// second*, and it produced exactly the two symptoms a reader reported:
//
//   1. **Flicker.** Every rebuild recreated all `.r.add` elements, which restarted
//      the row fade-in animation from the top. A completed row therefore pulsed
//      forever instead of easing in once.
//   2. **Missing new content.** Since every frame replaced the whole subtree, a
//      line that gained a few characters looked identical to a line that did not:
//      the eye had no stable reference to see the change against, and the rebuild
//      also reset scroll position before the pin re-applied it.
//
// The fix is to keep a plain-object model of what is on screen and patch only the
// parts that actually differ. New lines are *appended*, so their animation runs
// exactly once, and the rows above them are never touched.

/**
 * Build the view model for one diff.
 *
 * Mirrors {@link diffToHtml} one-for-one, but as data rather than markup, so the
 * patcher can compare old and new rows.
 * @param diff - diff material from {@link liveDiffOf}.
 * @returns path, language and the row list.
 */
function buildDiffView(diff) {
	const { rows, added, removed } = diffRows(diff);
	const language = languageOf(diff.path);
	return {
		path: shortPath(diff.path, void 0),
		language,
		added,
		removed,
		streaming: diff.streaming,
		rows: rows.map((row, index) => {
			const kind = row.kind === "add" ? "add" : row.kind === "remove" ? "del" : "ctx";
			const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
			// The caret only ever rides the newest added line.
			const caret = diff.streaming && row.provisional === true;
			return {
				kind,
				sign,
				caret,
				// The row being written right now: same condition as the caret, but
				// also drives a background wash so the growing line is findable.
				current: caret,
				number: String(index + 1),
				text: row.text,
				// A "provisional" row is the line still being written. Its text can
				// change wholesale on the next chunk (it is one JSON string being
				// appended to), so the patcher updates it in place rather than
				// assuming append-only growth.
				provisional: row.provisional === true,
				highlighted: false
			};
		})
	};
}

/** Create one diff-row element. Only ever called for rows that do not exist yet. */
function createRowElement(row) {
	const element = document.createElement("div");
	element.className = `r ${row.kind}`;
	const number = document.createElement("span");
	number.className = "n";
	number.textContent = row.number;
	const sign = document.createElement("span");
	sign.className = "g";
	sign.textContent = row.sign;
	const text = document.createElement("span");
	text.className = "t";
	element.append(number, sign, text);
	return element;
}

/**
 * Write a row's text and caret into its element.
 * @param element - the `.r` element.
 * @param row - the row model.
 * @param language - language profile for colouring.
 * @param force - re-tokenise even if the text is unchanged.
 */
function paintRow(element, row, language, force) {
	// The `cur` marker moves from row to row as the diff grows, so it is synced
	// separately from the text (which is only rewritten when it actually changed).
	const wantedClass = `r ${row.kind}${row.current ? " cur" : ""}`;
	if (element.className !== wantedClass) element.className = wantedClass;
	// The sign column is repainted, not just written at creation.
	//
	// Rows are matched to elements by index, but a row's KIND is recomputed on every
	// tick: `alignDiff` re-derives the common head/tail as the streamed text grows,
	// so a row that was context can become an addition in place. Writing the sign
	// only in `createRowElement` therefore left a green addition row labelled with
	// the context blank (or worse, a stale `-`), contradicting both the row's own
	// background and the `+N/-M` chip.
	const sign = element.children[1];
	if (sign !== void 0 && sign.textContent !== row.sign) sign.textContent = row.sign;
	const text = element.lastChild;
	// Re-tokenising identical text would replace the child nodes and restart any
	// running animation, so skip when nothing about the text (or its language)
	// changed. The language is part of the key because the same element is reused
	// when a block is reassigned to a different file.
	if (force || text.__text !== row.text || text.__language !== language) {
		text.__text = row.text;
		text.__language = language;
		text.innerHTML = highlightLine(row.text, language);
	}
	const wanted = row.caret ? 1 : 0;
	const has = text.lastChild !== null && text.lastChild.className === "c" ? 1 : 0;
	if (wanted === 1 && has === 0) {
		const caret = document.createElement("span");
		caret.className = "c";
		text.appendChild(caret);
	} else if (wanted === 0 && has === 1) {
		text.removeChild(text.lastChild);
	}
}

/** Create one diff block (header + rows container). */
function createDiffElement() {
	const element = document.createElement("div");
	element.className = "diff";
	const head = document.createElement("div");
	head.className = "h";
	const path = document.createElement("span");
	path.className = "p";
	const lang = document.createElement("span");
	lang.className = "lang";
	const removed = document.createElement("span");
	removed.className = "d";
	const added = document.createElement("span");
	added.className = "a";
	const status = document.createElement("span");
	status.className = "s";
	head.append(path, lang, removed, added, status);
	// The rows live in their own container so the header stays index 0 and the
	// body index 1, which is what `paintDiffElement` relies on.
	const body = document.createElement("div");
	body.className = "b";
	element.append(head, body);
	return element;
}

/**
 * Paint a diff block's header, then patch its rows in place.
 *
 * Row identity is positional. For a live diff that is safe — rows are only ever
 * appended or have their last row rewritten — and when the shape does change
 * unexpectedly the row count differs and the extra rows are dropped.
 * @param element - the `.diff` element from {@link createDiffElement}.
 * @param view - the diff view model.
 */
function paintDiffElement(element, view) {
	const head = element.firstChild;
	const [path, lang, removed, added, status] = head.children;
	path.textContent = view.path;
	lang.textContent = view.language === "text" ? EMPTY : view.language;
	lang.style.display = view.language === "text" ? "none" : EMPTY;
	removed.textContent = view.removed > 0 ? `-${String(view.removed)}` : EMPTY;
	removed.style.display = view.removed > 0 ? EMPTY : "none";
	added.textContent = view.added > 0 ? `+${String(view.added)}` : EMPTY;
	added.style.display = view.added > 0 ? EMPTY : "none";
	// The finished state drops the "writing" chip; the caret is removed by
	// `paintRow` because `view.streaming` drives `row.caret`.
	status.textContent = view.streaming ? "writing" : EMPTY;

	const body = element.children[1];
	const existing = body === void 0 ? [] : [...body.children];
	for (let index = 0; index < view.rows.length; index += 1) {
		const row = view.rows[index];
		let rowElement = existing[index];
		if (rowElement === void 0) {
			rowElement = createRowElement(row);
			body.appendChild(rowElement);
		}
		paintRow(rowElement, row, view.language, false);
	}
	// Drop rows that no longer exist (a path change reuses the block).
	for (let index = view.rows.length; index < existing.length; index += 1) {
		body.removeChild(existing[index]);
	}
}

/**
 * Patch the whole list to match `views`.
 *
 * Blocks are matched positionally for the same reason rows are: this plugin shows
 * one in-flight file mutation at a time, so the list is almost always length 1.
 * @param list - the `.list` element.
 * @param views - one view model per in-flight diff.
 */
function patchOverlayList(list, views) {
	let blocks = list.__blocks;
	if (blocks === void 0) {
		list.__blocks = [];
		blocks = list.__blocks;
	}
	for (let index = 0; index < views.length; index += 1) {
		let element = blocks[index];
		if (element === void 0 || element.parentNode === null) {
			element = createDiffElement();
			blocks[index] = element;
			list.appendChild(element);
		}
		paintDiffElement(element, views[index]);
	}
	for (let index = views.length; index < blocks.length; index += 1) {
		const element = blocks[index];
		if (element !== void 0 && element.parentNode !== null) list.removeChild(element);
	}
	if (blocks.length !== views.length) blocks.length = views.length;
	// An empty list must lose the "nothing yet" placeholder before it can show
	// rows; `setPlaceholder` handles the reverse.
}

/**
 * Show or clear the "no edits yet" placeholder.
 *
 * Multi-line text is split into explicit `<br>` elements rather than assigned via
 * `textContent`. `textContent` is the right choice for safety (nothing here is
 * ever parsed as markup), but a newline inside it is subject to HTML whitespace
 * collapsing, so `"line one\nline two"` renders on one line. That is exactly how
 * the placeholder read after being converted from `innerHTML`: the old markup's
 * `<br/>` was dropped in the conversion, silently.
 * @param list - the `.list` element.
 * @param text - placeholder text (`\n` splits lines), or null/"" to clear.
 */
function setPlaceholder(list, text) {
	const existing = list.__placeholder;
	if (text === null || text === EMPTY) {
		if (existing !== void 0 && existing.parentNode !== null) list.removeChild(existing);
		list.__placeholder = void 0;
		return;
	}
	if (existing === void 0 || existing.parentNode === null) {
		const element = document.createElement("div");
		element.className = "empty";
		list.appendChild(element);
		list.__placeholder = element;
	}
	const target = list.__placeholder;
	// Rebuild the children rather than replacing the element, so its identity
	// (and therefore any animation state) is stable across calls.
	while (target.firstChild !== null && target.firstChild !== void 0) {
		target.removeChild(target.firstChild);
	}
	const lines = String(text).split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		if (index > 0) target.appendChild(document.createElement("br"));
		target.appendChild(document.createTextNode(lines[index]));
	}
}

/** Build the panel's chrome once and return the element. */
function ensureOverlay() {
	if (typeof document === "undefined") return null;
	let node = document.getElementById(OVERLAY_ID);
	if (node !== null) return node;

	node = document.createElement("div");
	node.id = OVERLAY_ID;
	node.style.cssText = [
		"position:fixed", "right:12px", "bottom:12px", "z-index:2147483647",
		// Width is user-adjustable by dragging the left edge; height follows the
		// viewport so a long diff needs no separate scroll region inside a stubby
		// box. The initial width is the last dragged one.
		`width:${String(storedWidth())}px`,
		"height:calc(100vh - 24px)",
		"max-height:calc(100vh - 24px)",
		"display:flex", "flex-direction:column",
		"color:#e6edf3",
		"border-radius:10px", "overflow:hidden",
		// Fixed stack, no theme variable: the panel sits outside the shell's
		// theming, and `var()` with no binding would fall back to the page default
		// (a proportional face at an unknown size) — unreadable for a diff.
		"font:12px/1.6 ui-monospace,SFMono-Regular,'Cascadia Mono','Cascadia Code',Menlo,Consolas,'DejaVu Sans Mono',monospace",
		"text-align:left"
	].join(";");

	const style = document.createElement("style");
	style.textContent = [
		// Glass, with a legible fallback.
		//
		// Glass, with a legible fallback.
		//
		// A very translucent panel is only readable *because* the backdrop is
		// blurred. An engine that ignores `backdrop-filter` would paint the page
		// straight through the text, so the base rule stays nearly opaque and only
		// the `@supports` branch goes transparent.
		`#${OVERLAY_ID}{background:rgba(32,32,32,.96);border:1px solid rgba(255,255,255,.09);box-shadow:0 8px 24px rgba(0,0,0,.4)}`,
		"@supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){",
		// Windows 11 "Acrylic" rather than macOS glass.
		//
		// Acrylic is a *tinted* blur: a neutral grey base at moderate opacity, a
		// saturation boost to keep the backdrop's colour alive, and a faint noise
		// lift. It is deliberately less transparent than a macOS pane — Fluent
		// prioritises text legibility, so the tint carries more of the weight and
		// the backdrop shows through as texture rather than as colour.
		//
		// Grey was the earlier complaint. The cause was two neutral layers
		// stacking: `blur` averages this page's dark chrome with its light panes
		// into mid-grey, and a neutral tint averages it down again. The tints below
		// are therefore cool (blue-leaning), not neutral, and the alpha is high
		// enough that the tint — not the averaged backdrop — sets the tone.
		`#${OVERLAY_ID}{background:linear-gradient(155deg,rgba(44,54,68,.62) 0%,rgba(28,32,40,.58) 50%,rgba(34,40,52,.60) 100%);-webkit-backdrop-filter:blur(30px) saturate(125%);backdrop-filter:blur(30px) saturate(125%);border:1px solid rgba(255,255,255,.12);box-shadow:0 12px 40px rgba(0,0,0,.46),inset 0 1px 0 rgba(255,255,255,.09)}`,
		"}",
		`#${OVERLAY_ID} .bar{display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(255,255,255,.05);border-bottom:1px solid rgba(255,255,255,.08);flex:none}`,
		`#${OVERLAY_ID} .bar b{font-weight:600;color:#f3f3f3;letter-spacing:.01em}`,
		`#${OVERLAY_ID} .bar .sp{margin-left:auto}`,
		`#${OVERLAY_ID} button{background:rgba(255,255,255,.06);color:#f3f3f3;border:1px solid rgba(255,255,255,.10);border-radius:4px;padding:2px 8px;font:inherit;cursor:pointer;line-height:1.4;transition:background .12s ease}`,
		`#${OVERLAY_ID} button:hover{background:rgba(255,255,255,.14)}`,
		`#${OVERLAY_ID} button:active{background:rgba(255,255,255,.08)}`,
		`#${OVERLAY_ID} .list{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 8px;scroll-behavior:auto}`,
		`#${OVERLAY_ID} .diff{margin-bottom:8px;border:1px solid rgba(255,255,255,.08);border-radius:4px;overflow:hidden;background:rgba(0,0,0,.16)}`,
		`#${OVERLAY_ID} .h{display:flex;align-items:center;gap:8px;padding:4px 8px;background:rgba(255,255,255,.05);border-bottom:1px solid rgba(255,255,255,.07)}`,
		`#${OVERLAY_ID} .h .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f3f3f3}`,
		`#${OVERLAY_ID} .h .lang{flex:none;color:#9a9a9a;font-size:10px;text-transform:uppercase;letter-spacing:.06em}`,
		`#${OVERLAY_ID} .h .a{color:#6ccb5f;flex:none}`,
		`#${OVERLAY_ID} .h .d{color:#ff6b6b;flex:none}`,
		`#${OVERLAY_ID} .h .s{color:#6ccb5f;margin-left:auto;flex:none}`,
		// Token colours follow the Visual Studio dark palette, which is what a
		// Windows user reads every day: keywords pale blue-violet, strings
		// orange-brown, comments green, numbers pale green.
		`#${OVERLAY_ID} .t-kw{color:#569cd6}`,
		`#${OVERLAY_ID} .t-st{color:#ce9178}`,
		`#${OVERLAY_ID} .t-cm{color:#6a9955;font-style:italic}`,
		`#${OVERLAY_ID} .t-nu{color:#b5cea8}`,
		`#${OVERLAY_ID} .t-ty{color:#4ec9b0}`,
		`#${OVERLAY_ID} .r{display:flex;white-space:pre-wrap;word-break:break-all}`,
		// Newly written lines ease in. The transport delivers ~20 characters per
		// update at 80 ms, so a row can appear as a finished line with no other
		// motion; a short fade gives the eye something continuous to follow.
		//
		// This only reads as intended because the patcher appends rather than
		// rebuilds: a rebuilt row restarts the fade on every tick, which is what
		// turned a one-shot ease into a permanent flicker.
		"@keyframes dshld_rowin{from{opacity:.72}to{opacity:1}}",
		`#${OVERLAY_ID} .r.add{animation:dshld_rowin .2s ease-out}`,
		`#${OVERLAY_ID} .r .n{flex:none;width:38px;text-align:right;padding-right:8px;color:#8a8a8a;user-select:none;font-variant-numeric:tabular-nums}`,
		`#${OVERLAY_ID} .r .g{flex:none;width:14px;text-align:center;color:#8a8a8a}`,
		`#${OVERLAY_ID} .r .t{flex:1}`,
		// Windows dark diff tints are low-chroma washes rather than saturated
		// blocks: the row has to be identifiable at a glance while the code on top
		// stays the brightest thing in it. A left accent bar does the rest of the
		// signalling.
		`#${OVERLAY_ID} .r.add{background:rgba(78,201,176,.13);box-shadow:inset 3px 0 0 #4ec9b0}`,
		`#${OVERLAY_ID} .r.del{background:rgba(255,107,107,.13);box-shadow:inset 3px 0 0 #ff6b6b}`,
		`#${OVERLAY_ID} .r.ctx{color:#a0a0a0}`,
		`#${OVERLAY_ID} .r:hover{background:rgba(255,255,255,.06)}`,
		// The line currently being written gets its own faint wash. Without it the
		// growing line is indistinguishable from the dozens of settled lines around
		// it, which is exactly why newly arrived text was hard to find on screen.
		`#${OVERLAY_ID} .r.cur{background:rgba(120,200,255,.10);box-shadow:inset 3px 0 0 rgba(120,200,255,.55)}`,
		// The caret is an element with an explicit width and background. An empty
		// span has zero width and simply does not appear — which is how the
		// streaming indicator silently went missing before.
		//
		// The blink is a smooth ease rather than `steps(2,start)`: a hard square
		// wave at 1 Hz is the most tiring thing on a panel that streams for
		// minutes, and it reads as "flickering" next to a row fade.
		`#${OVERLAY_ID} .c{display:inline-block;width:7px;height:1.05em;margin-left:2px;background:#4ec9b0;vertical-align:text-bottom;border-radius:1px;animation:dshld_blink 1.1s ease-in-out infinite}`,
		"@keyframes dshld_blink{0%,100%{opacity:1}50%{opacity:.22}}",
		`#${OVERLAY_ID} .empty{padding:12px;color:#a0a0a0;text-align:center}`,
		`#${OVERLAY_ID} .diag{border-top:1px solid rgba(255,255,255,.08);padding:6px 9px;color:#8a8a8a;white-space:pre-wrap;flex:none;font-size:11px}`,
		// Scrollbar, Windows-style: a thin thumb that only shows its weight on hover.
		`#${OVERLAY_ID} .list::-webkit-scrollbar{width:10px}`,
		`#${OVERLAY_ID} .list::-webkit-scrollbar-track{background:transparent}`,
		`#${OVERLAY_ID} .list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:5px;border:3px solid transparent;background-clip:content-box}`,
		`#${OVERLAY_ID} .list::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.32);background-clip:content-box}`,
		// Resize strip on the left edge. It is `position:absolute` so it does not
		// participate in the column flex layout (a flex child would steal height
		// from the list). The visible line is an inner element, which keeps the
		// grab area wider than the line itself.
		`#${OVERLAY_ID} .rz{position:absolute;left:0;top:0;bottom:0;width:${String(RESIZE_GRIP)}px;cursor:ew-resize;z-index:2;display:flex;align-items:center;justify-content:center;touch-action:none}`,
		`#${OVERLAY_ID} .rz i{display:block;width:2px;height:36px;border-radius:1px;background:rgba(255,255,255,.18);transition:background .12s ease}`,
		`#${OVERLAY_ID} .rz:hover i,#${OVERLAY_ID} .rz.on i{background:rgba(120,200,255,.85)}`,
		`#${OVERLAY_ID} .w{flex:none;color:#9a9a9a;font-size:11px;font-variant-numeric:tabular-nums;display:none}`,
		`body.dshld-resizing,body.dshld-resizing *{cursor:ew-resize !important;user-select:none !important}`
	].join("\n");
	node.appendChild(style);

	const bar = document.createElement("div");
	bar.className = "bar";
	const title = document.createElement("b");
	title.textContent = "Live Diffs";
	const count = document.createElement("span");
	count.className = "count";
	// Live width readout. It only appears while dragging: a permanent number in
	// the bar is noise, but during a drag it is the only feedback that the width
	// is being snapped to a limit.
	const widthChip = document.createElement("span");
	widthChip.className = "w";
	const spacer = document.createElement("span");
	spacer.className = "sp";
	const toggle = document.createElement("button");
	toggle.textContent = overlayCollapsed ? "▸" : "▾";
	toggle.title = "折叠 / 展开";
	toggle.onclick = () => {
		overlayCollapsed = !overlayCollapsed;
		toggle.textContent = overlayCollapsed ? "▸" : "▾";
		list.style.display = overlayCollapsed ? "none" : "block";
		diag.style.display = overlayCollapsed ? "none" : "block";
	};
	const hide = document.createElement("button");
	hide.textContent = "×";
	hide.title = "隐藏（刷新后回来）";
	hide.onclick = () => {
		node.style.display = "none";
	};
	bar.append(title, count, widthChip, spacer, toggle, hide);

	const list = document.createElement("div");
	list.className = "list";
	// Follow the newest line while a write streams, releasing the moment the
	// reader scrolls away and resuming when they return to the bottom.
	//
	// Without this the panel stays pinned to the top of the first line: a growing
	// diff writes out of view, and the only visible motion is the caret blinking
	// on a line that never changes. That is exactly how this read before the
	// behaviour existed.
	list.__following = true;
	list.addEventListener("scroll", () => {
		const slack = list.scrollHeight - list.clientHeight - list.scrollTop;
		list.__following = slack < 24;
	});

	const diag = document.createElement("div");
	diag.className = "diag";

	node.append(bar, list, diag);
	// Keep the resize handler's disposer: its `window` listener outlives the
	// element, so `startOverlay`'s teardown has to remove it explicitly.
	node.__detachResize = attachResizeHandle(node, widthChip);
	document.body.appendChild(node);
	// Keep references for the update pass.
	node.__list = list;
	node.__diag = diag;
	node.__count = count;
	node.__widthChip = widthChip;
	return node;
}

/**
 * Make the panel's left edge draggable.
 *
 * The panel is anchored by `right`, so dragging left must *increase* the width.
 * Pointer capture is used rather than document-level mousemove listeners: it
 * keeps events coming to the strip even when the pointer leaves it (which happens
 * immediately, since the strip is only a few pixels wide), and it needs no
 * add/remove bookkeeping.
 *
 * The width is clamped to [WIDTH_MIN, viewport - 2 * margin] and written to
 * storage on release only — writing on every move would touch `localStorage`
 * dozens of times per drag.
 * @param node - the overlay element (already carries `width`).
 * @param chip - the bar's width readout.
 */
function attachResizeHandle(node, chip) {
	const strip = document.createElement("div");
	strip.className = "rz";
	strip.title = "拖动调整宽度（双击恢复默认）";
	const grip = document.createElement("i");
	strip.appendChild(grip);
	// Appended last but positioned absolutely over the left edge, so it is not a
	// flex child and cannot take height from the list.
	node.appendChild(strip);

	let startX = 0;
	let startWidth = 0;

	/**
	 * The panel's current width in px.
	 *
	 * Reads `node.style.width`, which the creation path always sets, rather than
	 * `getBoundingClientRect().width`. The rect is 0 for an element that is not in
	 * the document — and this handler is built *before* the panel is appended, so
	 * the first read returned 0 and every later `resize` then clamped the panel down
	 * to `WIDTH_MIN`. That silently shrank a 440px panel to 280px the first time the
	 * window was resized, and `storeWidth` only runs on a drag, so a reload restored
	 * the old width and lost it again.
	 * @returns width in px.
	 */
	const measuredWidth = () => {
		const raw = node.style.width;
		const parsed = Number.parseFloat(raw);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : storedWidth();
	};

	let current = measuredWidth();

	const apply = (width) => {
		current = Math.min(maxWidth(), Math.max(WIDTH_MIN, width));
		node.style.width = `${String(Math.round(current))}px`;
		chip.textContent = `${String(Math.round(current))} px`;
	};

	const finish = () => {
		if (!strip.classList.contains("on")) return;
		strip.classList.remove("on");
		chip.style.display = "none";
		document.body.classList.remove("dshld-resizing");
		storeWidth(current);
		// The window-level safety net added by `onPointerDown` is done with.
		window.removeEventListener("pointerup", finish);
	};

	const onPointerDown = (event) => {
		startX = event.clientX;
		startWidth = measuredWidth();
		strip.classList.add("on");
		chip.style.display = "inline";
		chip.textContent = `${String(Math.round(startWidth))} px`;
		document.body.classList.add("dshld-resizing");
		// A safety net for the case where pointer capture is unavailable.
		//
		// The strip is only a few pixels wide, so without capture the pointer leaves
		// it immediately: `pointermove` stops arriving (the width freezes) and
		// `pointerup` lands somewhere else entirely, so `finish` never runs and the
		// page is left with `cursor: ew-resize !important` and `user-select: none`
		// stuck on every element until the user happens to click the strip again.
		// Listening on `window` for the release costs nothing and ends the drag
		// wherever it finishes. `finish` removes it, and it is idempotent.
		window.addEventListener("pointerup", finish);
		try {
			strip.setPointerCapture(event.pointerId);
		} catch {
			// Pointer capture is a nicety; the window listener above covers the rest.
		}
		event.preventDefault();
	};

	const onPointerMove = (event) => {
		if (!strip.classList.contains("on")) return;
		// Dragging left (negative delta) widens the panel: it is right-anchored.
		apply(startWidth - (event.clientX - startX));
	};

	// Double-click restores the default, which is the only way back if the panel
	// was dragged to its narrow limit.
	const onDoubleClick = () => {
		apply(WIDTH_DEFAULT);
		storeWidth(current);
	};

	// A viewport that shrinks below the stored width would leave the panel
	// overhanging; re-clamp on resize (cheap, and the handler is passive).
	const onWindowResize = () => {
		apply(current);
	};

	strip.addEventListener("pointerdown", onPointerDown);
	strip.addEventListener("pointermove", onPointerMove);
	strip.addEventListener("pointerup", finish);
	strip.addEventListener("pointercancel", finish);
	strip.addEventListener("dblclick", onDoubleClick);
	window.addEventListener("resize", onWindowResize);

	/**
	 * Undo the listeners.
	 *
	 * Worth returning rather than relying on garbage collection: the strip's own
	 * listeners die with the element when the panel is removed, but `window`
	 * outlives it, so a `resize` listener left behind accumulates one per plugin
	 * load — and the live-reload path loads this plugin on every source change.
	 * Each stale listener also keeps its whole closure (node, chip, strip) alive.
	 * @returns a disposer for `startOverlay`.
	 */
	return () => {
		strip.removeEventListener("pointerdown", onPointerDown);
		strip.removeEventListener("pointermove", onPointerMove);
		strip.removeEventListener("pointerup", finish);
		strip.removeEventListener("pointercancel", finish);
		strip.removeEventListener("dblclick", onDoubleClick);
		window.removeEventListener("resize", onWindowResize);
	};
}

/**
 * Draw the current reading into the overlay.
 *
 * A finished edit does not clear the panel. `entries` goes empty the moment a
 * call settles, and blanking the surface then would erase the very thing the
 * reader was looking at — the diff they just watched grow. The last non-empty
 * read is therefore kept and re-rendered, marked as the finished result, until a
 * new edit replaces it.
 * @param entries - diff rows from {@link inFlightDiffs}.
 * @param report - diagnostics from {@link diagnoseWindow}.
 * @param source - the resolved diff source, for the binding line.
 */
function renderOverlay(entries, report, source) {
	const node = ensureOverlay();
	if (node === null) return;
	const list = node.__list;
	const diag = node.__diag;
	const count = node.__count;

	if (entries.length > 0) {
		// Fresh read: remember its structure as the panel's content.
		overlayLastDiffs = entries.map((entry) => entry.diff);
		overlayLastCount = entries.length;
	}

	count.textContent = entries.length > 0
		? `${String(entries.length)} in flight`
		: overlayLastDiffs.length === 0 ? EMPTY : `${String(overlayLastCount)} done`;

	// Patch rather than rebuild. See the note above `buildDiffView`: replacing
	// `innerHTML` twelve times a second restarted every row's animation and made
	// the newly streamed characters impossible to follow.
	if (entries.length > 0) {
		setPlaceholder(list, null);
		patchOverlayList(list, entries.map((entry) => buildDiffView(entry.diff)));
	} else if (overlayLastDiffs.length === 0) {
		patchOverlayList(list, []);
		setPlaceholder(list, "No file edits yet.\nThe next edit will appear here.");
	} else {
		// Finished: keep the rows, drop the streaming affordances. The rows are
		// re-derived from the kept diffs so the caret disappears and the "writing"
		// chip goes, without a full rebuild.
		setPlaceholder(list, null);
		patchOverlayList(list, finishedViews());
	}

	// Keep the newest line in view while a call is streaming.
	//
	// Pinning is the whole point of a live diff: a diff that grows below the fold
	// shows nothing but the caret blinking on a frozen first line. The pin honours
	// `__following`, so a deliberate scroll up is never fought.
	if (entries.length > 0 && list.__following !== false) {
		list.scrollTop = list.scrollHeight;
	}

	diag.textContent = [
		`window ${report === null ? "-" : String(report.entryCount)}  transient ${report === null ? "-" : String(report.transientCount)}  deltas ${report === null ? "-" : String(report.deltaCount)}  acc ${report === null ? "-" : String(report.accumulating)}`,
		`chunks ${report === null ? "-" : formatCounts(report.chunkTypes)}`,
		`tools ${report === null || report.toolNames.length === 0 ? "(none)" : report.toolNames.join(", ")}`,
		`binding ${source === null ? "MISSING" : typeof source.broken === "string" ? `BROKEN (${source.broken})` : "ok"}`,
		report === null ? "no report" : report.reason
	].join("\n");
}

/**
 * The kept diff rendered in its settled form: no caret, no "writing" chip.
 *
 * Rebuilt from `overlayLastDiffs` (the structural material) rather than by
 * stripping markup out of the rendered DOM, because the incremental patcher
 * needs the row models, not a string.
 * @returns view models with streaming turned off.
 */
function finishedViews() {
	return overlayLastDiffs.map((diff) => {
		const view = buildDiffView(diff);
		view.streaming = false;
		for (const row of view.rows) {
			row.caret = false;
			// `current` drives the `.cur` wash as well, and `buildDiffView` sets it to
			// the same condition as the caret. Clearing only the caret left the last
			// row permanently highlighted as "being written right now" after the edit
			// finished — the panel claiming to still be writing while its own chip and
			// caret had correctly gone away.
			row.current = false;
		}
		return view;
	});
}

/**
 * Start the always-on overlay.
 *
 * Deliberately outside React and outside the sidebar, for two independent
 * reasons discovered in that order:
 *
 *   1. The host does not paint a sidebar tab's body — a component can mount,
 *      run its effects, and produce no DOM. A real element appended to
 *      `document.body` is immune to that.
 *   2. A React-rendered overlay only exists once its tab is opened, which makes
 *      the panel hostage to a click. Starting from `apply` means the overlay is
 *      there from the moment the plugin loads, with no tab involved.
 *
 * Data comes from polling the session's `eventSource` rather than from the chat
 * snapshot: this code has no React tree to re-render it, and the event window is
 * the source that actually carries the streaming `tool-call-delta` chunks.
 * @param ctx - the plugin context (reads `sessions`).
 * @returns a disposer that stops polling and drops the element.
 */
function startOverlay(ctx) {
	if (typeof document === "undefined") return () => {};
	let disposed = false;
	let timer = null;
	let lastKey = EMPTY;

	const unsubscribe = typeof ctx.sessions?.list?.subscribe === "function"
		? ctx.sessions.list.subscribe(() => {
			lastKey = EMPTY;
		})
		: null;

	const tick = () => {
		if (disposed) return;
		try {
			const sessionId = ctx.sessions?.list?.getSnapshot()?.current;
			const binding = sessionId === void 0 ? void 0 : ctx.sessions.binding(sessionId);
			if (binding === void 0 || binding.eventSource === void 0) {
				renderOverlay([], null, { broken: "no session binding" });
				return;
			}
			const window = binding.eventSource.getSnapshot();
			const entries = inFlightDiffs(window);
			const report = diagnoseWindow(window);
			// Skip the DOM work when nothing changed: this runs four times a second
			// for the life of the page.
			const key = `${String(entries.length)}|${report.entryCount}|${report.transientCount}|${report.deltaCount}|${report.accumulating}|${report.reason}`;
			if (key === lastKey) return;
			lastKey = key;
			renderOverlay(entries, report, { broken: void 0 });
			// Beacon from here too.
			//
			// Moving the panel out of the view also moved it away from the only code
			// that reported anything, which silently cost the log its feed: after a
			// refresh with no tab open, nothing wrote to `diag.log` at all. Every
			// visible surface reports for itself.
			//
			// This beacon is also what made `document.title` redundant. The title was
			// a readout for the case where the beacon could not be read back, and it
			// had two problems: it only became visible when the tab was inactive
			// (which is exactly when nobody is watching the diff), and it renamed the
			// host application's own tab. The log is the evidence channel now.
			void beacon({ surface: "overlay", ...reportPayload(report, entries.length) });
		} catch (error) {
			// The panel is the plugin's only visible surface here: if the read
			// fails, say so on screen instead of vanishing.
			renderOverlay([], null, { broken: error instanceof Error ? error.message : String(error) });
			void beacon({ surface: "overlay", failed: error instanceof Error ? error.message : String(error) });
		}
	};

	// An immediate first paint, then the steady poll.
	//
	// 80 ms, not 250 ms. The transport delivers ~262 deltas/s in bursts, so a
	// slower poll shows bigger jumps for no saving: measured, 250 ms folded ~65
	// deltas into each update while 80 ms shows ~20. It cannot reach one delta per
	// update — the transport is the ceiling — but it removes the coarseness this
	// plugin was adding on top of it.
	tick();
	timer = setInterval(tick, 80);

	return () => {
		disposed = true;
		if (timer !== null) clearInterval(timer);
		if (unsubscribe !== null) unsubscribe();
		const node = document.getElementById(OVERLAY_ID);
		if (node !== null) {
			// Remove the `window` listener before dropping the element: removing an
			// element collects the listeners bound to it, but not one bound to a
			// longer-lived target.
			if (typeof node.__detachResize === "function") node.__detachResize();
			node.remove();
		}
	};
}

/**
 * Scroll state for one diff body.
 * Split from the renderer so a caller with several diffs can own a single
 * scroller and still call the hook exactly once (hooks may not run in a loop).
 * @param diff - diff material, or null.
 * @returns the scroller ref, its onScroll handler, and the row count.
 */
function useFollowScroll(diff) {
	const scrollerRef = useRef(null);
	const followingRef = useRef(true);
	const programmaticRef = useRef(false);
	const streaming = diff !== null && diff.streaming;
	const rowCount = diff === null ? 0 : splitLines(diff.newText).length + (diff.oldText === null ? 0 : splitLines(diff.oldText).length);

	useEffect(() => {
		const element = scrollerRef.current;
		if (element === null || !streaming || !followingRef.current) return;
		programmaticRef.current = true;
		element.scrollTop = element.scrollHeight - element.clientHeight;
		requestAnimationFrame(() => {
			programmaticRef.current = false;
		});
	}, [rowCount, streaming]);

	return {
		rowCount,
		scrollerRef,
		onScroll: () => {
			const element = scrollerRef.current;
			if (element === null || programmaticRef.current) return;
			const { scrollTop, scrollHeight, clientHeight } = element;
			followingRef.current = Math.abs(scrollHeight - clientHeight - scrollTop) < FOLLOW_THRESHOLD_PX;
		}
	};
}

/**
 * The scrollable container for one diff body, with its own follow-scroll wiring.
 *
 * Extracted and made self-contained because the wiring is easy to get wrong from
 * outside. `.dshld_body` is the element that carries `max-height` and `overflow`,
 * so it is the only element that can actually scroll — but the ref used to be a
 * prop, and one caller attached it to an outer, non-scrolling wrapper. The pin then
 * set `scrollTop` on a box that could not scroll and the real body was never
 * followed, silently: nothing throws, the diff simply grows out of view.
 *
 * Owning the hook here removes the possibility. A caller cannot mis-attach a ref it
 * does not supply.
 * @param diff - diff material.
 * @param children - the diff rows.
 * @returns the body element.
 */
function DiffBodyScroller({ diff, children }) {
	const scroll = useFollowScroll(diff);
	return jsx("div", {
		className: "dshld_body",
		key: "body",
		ref: scroll.scrollerRef,
		onScroll: scroll.onScroll
	}, children);
}

/**
 * Render one diff body.
 *
 * `DiffBlock` does **not** diff its inputs. Its row builder pushes every line of
 * `oldText` as a removal and every line of `newText` as an addition:
 *
 *     if (a.oldText !== null) for (const c of lines(a.oldText)) rows.push({kind:"del", text:c});
 *     for (const c of lines(a.newText)) rows.push({kind:"add", text:c});
 *
 * So the two strings passed in must already be the *changed* sides. Passing the
 * full row list as `newText` therefore renders every unchanged line as an
 * addition — the bug this function previously had: an edit of one line inside a
 * five-line block showed the untouched context lines as added, and the same lines
 * appeared on both the removal and the addition side at once. (The shell's own
 * `FileMutationRow` is not counter-evidence: it forwards the raw `old_string` /
 * `new_string` arguments, so it renders the untouched context on *both* sides on
 * purpose. This card deliberately shows the changed region only.)
 *
 * The row model from {@link diffRows} is the single source of truth for all three
 * readers: the `+N/-M` chip, the strings below, and the primitive's own footer —
 * which is why they now agree instead of disagreeing by the context-line count.
 * @param props - the diff material and the working directory for path shortening.
 * @returns the body element.
 */
function DiffBody({ diff, cwd }) {
	const { rows, added, removed } = diffRows(diff);
	// Both sides are filtered to the changed rows. `=== null` on the old side means
	// "a new file" (a `write`), which `DiffBlock` renders as additions only.
	const liveText = rows
		.filter((row) => row.kind === "add")
		.map((row, index, added2) => {
			// `added2` is the filtered array; the caret belongs on its last entry,
			// which is the same row `caretIndex` identified before filtering.
			const isCaretRow = diff.streaming && index === added2.length - 1;
			return isCaretRow ? `${row.text}\u258f` : row.text;
		})
		.join("\n");
	const liveOldText = rows
		.filter((row) => row.kind === "remove")
		.map((row) => row.text)
		.join("\n");

	return jsx("div", { className: "dshld_root" }, [
		jsx("div", { className: "dshld_bar", key: "bar" }, [
			jsx("span", { className: "dshld_path", key: "path", title: diff.path || undefined }, shortPath(diff.path, cwd)),
			removed > 0 ? jsx("span", { className: "dshld_del", key: "del" }, `-${removed}`) : null,
			added > 0 ? jsx("span", { className: "dshld_add", key: "add" }, `+${added}`) : null,
			diff.replaceAll ? jsx("span", { key: "all" }, "all") : null,
			diff.streaming ? jsx("span", { className: "dshld_live", key: "live" }, [
				jsx("span", { className: "dshld_dot", key: "dot" }),
				jsx("span", { key: "label" }, "streaming")
			]) : null
		]),
		jsx(DiffBodyScroller, { diff, key: "scroller" }, jsx(DiffBlock, {
			diffs: [{
				path: diff.path || "(pending)",
				oldText: diff.oldText === null ? null : liveOldText,
				newText: liveText
			}],
			labels: DIFF_LABELS,
			maxLines: diff.streaming ? LIVE_MAX_LINES : 10000
		}))
	]);
}

/**
 * The live diff card. While streaming it keeps itself pinned to the newest line
 * so the growth stays visible, releasing the pin as soon as the reader scrolls
 * away from the bottom.
 */
function LiveDiffCard({ block, toolName, cwd }) {
	const diff = liveDiffOf(block, toolName);
	if (diff === null) return null;
	// No scroller wiring: `DiffBody` owns it (see `DiffBodyScroller`).
	return jsx(DiffBody, { diff, cwd });
}

/** The Tool view the slot dispatches for `edit` and `write`. */
function LiveDiffToolView(props) {
	ensureStyles();
	return jsx(LiveDiffCard, { block: props.block, toolName: props.toolName, cwd: props.cwd });
}

/**
 * Subscribe to the raw Session event window of the session this view is bound to.
 *
 * Deliberately NOT the Chat projection: that projection hides tool-call blocks,
 * so a streaming edit never reaches it (see {@link inFlightDiffs}). The event
 * window is the raw feed the projection itself is built from.
 * @param ctx - the plugin context.
 * @param sessionId - the bound session.
 * @returns the resolved source, or null when the binding is unavailable.
 */
function diffSourceFor(ctx, sessionId) {
	// The whole point of the always-on diagnostic panel is to survive a failure,
	// so the evaluation-time read must not throw: a binding that is missing, or a
	// service that is absent, becomes a source that reports why.
	try {
		const binding = ctx.sessions.binding(sessionId);
		if (binding === void 0) return null;
		const eventSource = binding.eventSource;
		if (eventSource === void 0) return { broken: "binding has no eventSource", getSnapshot: () => null, subscribe: () => () => {}, cwd: () => void 0 };
		return {
			getSnapshot: () => eventSource.getSnapshot(),
			subscribe: (listener) => eventSource.subscribe(listener),
			cwd: () => ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
		};
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		return { broken: `diffSourceFor threw: ${message}`, getSnapshot: () => null, subscribe: () => () => {}, cwd: () => void 0 };
	}
}

/**
 * The Diffs view: every file mutation in flight, rendered as a growing diff.
 *
 * This exists because the chat transcript has no place for a running tool call,
 * and the Chat projection prunes one outright, so a live diff needs its own
 * surface. The data comes from the raw Session event window; see
 * {@link inFlightDiffs}.
 *
 * The empty state is deliberately a diagnostic panel rather than a shrug: the
 * plugin's author cannot observe the browser, so the panel reports what the
 * event window actually contained (counts per entry type, per chunk type, and
 * what is still accumulating). A wrong assumption about the wire shape then
 * shows up as a specific number instead of a blank tab.
 */
function DiffsView(props) {
	ensureStyles();
	const source = props.__diffSource;
	// The store must be referentially stable: a fresh `subscribe`/`getSnapshot`
	// pair on every render would re-subscribe on every stream chunk.
	const store = useRef(null);
	if (store.current === null || store.current.source !== source) {
		const cache = { current: null };
		store.current = {
			source,
			subscribe: (listener) => {
				if (source === null) return () => {};
				return source.subscribe(() => {
					// The framework republishes a fresh snapshot object per chunk; drop
					// the memo so the next read returns it.
					cache.current = null;
					listener();
				});
			},
			getSnapshot: () => {
				if (source === null) return { entries: [], report: { reason: "no session binding", entryCount: 0, transientCount: 0, accumulating: 0, entryTypes: new Map(), chunkTypes: new Map(), toolNames: [] } };
				if (cache.current === null) {
					let window = null;
					let caught = typeof source.broken === "string" ? source.broken : EMPTY;
					try {
						window = source.getSnapshot();
					} catch (error) {
						// A missing target must not throw out of a render: report it
						// instead, because the report is the only evidence available.
						caught = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
					}
					// Both calls are total: any throw here would blank the whole view.
					let entries = [];
					let report;
					try {
						entries = inFlightDiffs(window);
						report = diagnoseWindow(window);
					} catch (error) {
						report = diagnoseWindow(null);
						report.reason = `reader threw: ${error instanceof Error ? error.message : String(error)}`;
					}
					if (caught !== EMPTY) report.reason = `source failed: ${caught}`;
					cache.current = { entries, report };
				}
				return cache.current;
			}
		};
	}
	const { subscribe, getSnapshot } = store.current;
	const state = useSyncExternalStore(subscribe, getSnapshot, () => null);
	const entries = state === null ? [] : state.entries;
	const report = state === null ? null : state.report;

	// Report on mount and again whenever the reading changes.
	//
	// A mount-only report cannot answer the question this channel exists for: the
	// panel mounts while nothing is streaming, so it would always read "no
	// transient entries" and hide the very frames it is meant to observe. That
	// mistake was made once and produced a confidently wrong conclusion.
	//
	// The ticker is what makes the effect re-run while a call streams — a plain
	// dependency array would miss the interesting frames, because the values it
	// closes over only change when the component re-renders, which during a quiet
	// stream it may never do. State is only set when the key actually moves, so
	// this costs one timer and no re-renders in the steady state.
	const [, forceTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => forceTick((value) => value + 1), 250);
		return () => clearInterval(timer);
	}, []);
	const sentRef = useRef(EMPTY);
	useEffect(() => {
		const idleNow = entries.length === 0 && (report === null || (report.deltaCount === 0 && report.reason.startsWith("no transient")));
		const key = idleNow
			? "idle"
			: JSON.stringify([
				entries.length,
				report === null ? -1 : report.entryCount,
				report === null ? -1 : report.deltaCount,
				report === null ? -1 : report.transientCount,
				report === null ? -1 : report.accumulating,
				report === null ? "" : report.reason
			]);
		if (sentRef.current === key) return;
		sentRef.current = key;
		void beacon({ surface: "diffs-view", ...(idleNow ? { idle: true } : {}), ...reportPayload(report, entries.length) });

		// `document.title` used to carry the same reading here, on the theory that a
		// title bar sits outside every theme, layout and stacking rule and so stays
		// legible even when the surface does not paint. It was removed: it renames
		// the host application's own tab, and it is only actually visible when the
		// tab is inactive — the one moment nobody is watching a live diff. The
		// beacon above is the channel that survived, because it is a file.

		// The visible diff panel.
		//
		// The overlay is NOT rendered from here.
		//
		// This component only mounts when its sidebar tab is open, so anything it
		// renders is hostage to that click — and the tab body is not painted by the
		// host anyway. The overlay is started from `apply` instead, where it exists
		// for the whole session with no tab open at all.
	});

	// The panel is rendered unconditionally, not just for the empty state: its
	// presence is the plugin's proof that this view is mounted at all. "The tab is
	// blank" and "the view never rendered" are different faults, and only an
	// always-on marker tells them apart.
	//
	// Colours are inline and fixed, not theme variables. A diagnostic that can be
	// invisible is not a diagnostic: this panel was once rendered into a white
	// sidebar with inherited (i.e. white-on-white) text, which reads exactly like
	// "the view never rendered" — the very ambiguity it exists to remove.
	const monospace = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
	const panelStyle = {
		flex: "0 0 auto",
		background: "#0d1117",
		color: "#c9d1d9",
		border: "1px solid #30363d",
		borderRadius: "6px",
		padding: "8px 10px",
		fontFamily: monospace,
		fontSize: "11px",
		lineHeight: "1.75",
		wordBreak: "break-word",
		textAlign: "left"
	};
	const line = (key, text) => jsx("div", { key, style: { whiteSpace: "pre-wrap" } }, text);
	const panel = jsx("div", { style: panelStyle, key: "diag" }, [
		line("mount", `live-diff mounted · entries ${String(entries.length)}`),
		line("a", `window.entries: ${report === null ? "(no report)" : String(report.entryCount)}`),
		line("c", `entry types: ${report === null ? "-" : formatCounts(report.entryTypes)}`),
		line("e", `chunk types: ${report === null ? "-" : formatCounts(report.chunkTypes)}`),
		line("g", `tool names: ${report === null || report.toolNames.length === 0 ? "(none)" : report.toolNames.join(", ")}`),
		line("i", `transient: ${report === null ? "-" : String(report.transientCount)}  ·  accumulating: ${report === null ? "-" : String(report.accumulating)}`),
		line("k", `session binding: ${source === null ? "MISSING" : typeof source.broken === "string" ? `BROKEN (${source.broken})` : "ok"}`),
		line("m", `reason: ${report === null ? "(no report)" : report.reason}`)
	]);

	// Layout notes, all learned the hard way:
	//
	//   * No percentage heights, and no `overflow` on the root. `height: 100%`
	//     *and* `maxHeight: 100%` resolve against the parent's height; inside a
	//     sidebar pane with no definite height they resolve to zero, and an
	//     `overflow: auto` box of zero height clips its whole contents. The
	//     component then renders perfectly, beacons faithfully, and paints
	//     nothing, which is indistinguishable from "no data". The fix is to state
	//     no height at all and let the block lay itself out from its content.
	//   * No `margin: auto` in the flex column: an auto margin consumes all free
	//     cross-axis space and can collapse siblings.
	//   * Colours are stated, never inherited: theme variables are not guaranteed
	//     to be bound here, and inherited text on a white pane is white-on-white.
	const pageStyle = {
		display: "flex",
		flexDirection: "column",
		gap: "10px",
		padding: "10px 12px",
		boxSizing: "border-box",
		fontFamily: monospace,
		fontSize: "12px",
		color: "#c9d1d9"
	};
	const emptyStyle = {
		margin: "12px 0 0",
		textAlign: "center",
		fontSize: "12px",
		lineHeight: "1.7",
		color: "#8b949e"
	};

	if (source === null || state === null) {
		return jsx("div", { style: pageStyle }, [
			panel,
			jsx("div", { style: emptyStyle, key: "empty" }, "This session is not available.")
		]);
	}
	if (entries.length === 0) {
		return jsx("div", { style: pageStyle }, [
			panel,
			jsx("div", { style: emptyStyle, key: "empty" }, [
				jsx("strong", { key: "title", style: { display: "block", marginBottom: "4px", color: "#c9d1d9" } }, "No file edits in flight"),
				jsx("span", { key: "hint" }, "Diffs appear here while the agent is writing. Keep this tab open when you send the edit — the write itself takes milliseconds.")
			])
		]);
	}
	const cwd = source.cwd?.();
	return jsx("div", { style: pageStyle }, [
		panel,
		// No ref and no onScroll here. This wrapper has no `overflow` and cannot
		// scroll, so wiring the follow-scroll to it did nothing visible: the pin set
		// `scrollTop` on a box that could not scroll while the element that actually
		// scrolls (`.dshld_body`, inside each `DiffBody`) was never followed. Each
		// diff body now owns its own scroller, which is where the scrollable element
		// actually is.
		jsx("div", {
			key: "rows",
			style: { display: "flex", flexDirection: "column", gap: "8px", minHeight: "0" }
		}, entries.map((entry) => jsx(DiffBody, { diff: entry.diff, cwd, key: entry.callId })))
	]);
}

/** The chip text of the right-sidebar tab. */
function SidebarDiffsTitle() {
	return "Live Diffs";
}

/**
 * Services this half needs before it can register anything.
 *
 * `sessions` is the easy one to miss. The Cordis context is a proxy that
 * **throws** on an undeclared read (`cannot get property "sessions" without
 * inject`) instead of returning undefined, so forgetting it does not degrade
 * quietly — it makes every snapshot read fail, which surfaces only as a blank tab
 * with an empty diagnostic panel.
 */
const inject = ["slots", "sidebarRightTabs", "sessions"];

/** Identity of the right-sidebar tab type this plugin contributes. */
const SIDEBAR_ID = "dsh-plugin-live-diff";
/** Kind other code may name when opening the tab programmatically. */
const SIDEBAR_KIND = "live-diffs";

function apply(ctx) {
	ctx.slots.inject("tool.call.toolview", function* () {
		yield ctx.slots.register({ name: "tool.call.toolview", key: "edit" }, LiveDiffToolView);
		yield ctx.slots.register({ name: "tool.call.toolview", key: "write" }, LiveDiffToolView);
	});

	// The live diff panel, started here so it exists with no tab open.
	//
	// It used to be rendered by the sidebar view, which meant the panel only
	// appeared after the user clicked the tab — and the host does not paint that
	// tab body anyway. Starting it from `apply` makes it independent of both.
	ctx.effect(() => startOverlay(ctx), "live-diff: overlay panel");

	// The sidebar tab stays registered (it is harmless and may become the home of
	// this view once the host's tab-body rendering is understood), but nothing
	// depends on the user opening it any more.
	//
	// No `conversation.view` registration: a Diffs tab in the transcript area was
	// tried and removed. The live diff belongs beside the files it describes.
	//
	// The `guide` entry is not optional in practice. The sidebar's add control
	// opens the *guide page*, which lists one capsule per registered `guide`
	// entry — "Omit to stay off it". Without one, the type registers, `apply` runs,
	// and the user still has no way to open the tab.
	ctx.effect(() => ctx.sidebarRightTabs.register({
		id: SIDEBAR_ID,
		kind: SIDEBAR_KIND,
		priority: "extension",
		title: () => "Live Diffs",
		guide: [{
			order: 20,
			title: () => "Live Diffs",
			description: () => "File edits as they are written, one growing diff at a time"
		}]
	}), "live-diff: sidebar tab type");
	ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
		name: "sidebar.right.pane.tab",
		key: SIDEBAR_ID,
		inject: (sessionId) => ({ __diffSource: diffSourceFor(ctx, sessionId) })
	}, DiffsView));
	ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
		name: "sidebar.right.pane.tab.title",
		key: SIDEBAR_ID
	}, SidebarDiffsTitle));
}

		return { apply, inject, LiveDiffCard, DiffBody, DiffBodyScroller, DiffsView, inFlightDiffs, diagnoseWindow, formatCounts, highlightLine, languageOf, pathOfRunningCall, diffRows, liveDiffOf, readJsonFields, alignDiff, jsx, buildDiffView, patchOverlayList, paintDiffElement, setPlaceholder, ensureOverlay, renderOverlay, attachResizeHandle, storedWidth, maxWidth, WIDTH_DEFAULT, WIDTH_MIN, OVERLAY_ID };
	}
});
