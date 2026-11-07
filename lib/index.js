/**
 * Host-half of the live-diff plugin.
 *
 * The plugin's real work happens in the browser, and its author cannot see a
 * browser: the Web surface is gated behind a per-process token that is never
 * written to disk, so fetching `http://127.0.0.1:3080/` answers 401 and no local
 * tooling changes that. A blank panel therefore has no observable cause.
 *
 * This half closes that loop. It registers one unauthenticated POST route on the
 * host web server; the browser half beacons its diagnostic report there and the
 * report is appended to a file on disk, where the author can read it. The browser
 * needs no credential to reach it — it already has its own session, and the route
 * is registered outside the authenticated index handler (the web server's routing
 * tables apply no authorization of their own).
 *
 * The route carries diagnostics only. It never reads or writes wiki content.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** Route the browser half posts its report to; distinct from every shipped path. */
export const DIAG_PATH = "/live-diff-diag";

/**
 * Route the browser half re-fetches the backdrop stylesheet from.
 *
 * The stylesheet is served, not bundled, on purpose: the whole point of the
 * window backdrop is visual, and this plugin's author cannot see a browser to
 * tune it. Serving the file means the look can be edited and picked up in the
 * running app within ~1.5 s, with no restart and no rebuild — the browser half
 * already polls this route.
 */
export const STYLE_PATH = "/live-diff-style.css";

/**
 * The stylesheet file this half serves.
 *
 * Resolved relative to the package root, so a linked checkout and an installed
 * copy both work without configuration; `DSH_LIVE_DIFF_STYLE` overrides it for
 * experiments that must not touch the package.
 */
function styleFile() {
	const override = process.env.DSH_LIVE_DIFF_STYLE;
	if (typeof override === "string" && override.trim() !== "") return override;
	try {
		return join(dirname(fileURLToPath(import.meta.url)), "..", "style.css");
	} catch {
		return join(process.cwd(), "style.css");
	}
}

/** Read the served stylesheet, or null when it is missing/unreadable. */
function readStyle() {
	try {
		return readFileSync(styleFile(), "utf8");
	} catch {
		return null;
	}
}

/**
 * Where reports land when `DSH_LIVE_DIFF_LOG` is not set.
 *
 * Derived from the OS temp directory rather than hardcoded to one machine: this
 * file is published, and a literal path would make every other install fail to
 * write anything (or, worse, silently append into an unrelated directory that
 * happens to exist). A diagnostics file has no business outliving a reboot, so
 * the temp directory is also the honest place for it.
 */
const DEFAULT_LOG = join(tmpdir(), "dsh-plugin-live-diff", "diag.log");

/** Resolve the log path, honouring the environment override. */
function logPath() {
	const override = process.env.DSH_LIVE_DIFF_LOG;
	return typeof override === "string" && override.trim() !== "" ? override : DEFAULT_LOG;
}

/** Read a request body with a hard cap, so a runaway poster cannot exhaust memory. */
function readBody(req, limit = 65536) {
	return new Promise((resolve) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				req.destroy();
				resolve(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", () => resolve(null));
	});
}

/**
 * Append one report to the log.
 *
 * A `reset: true` report truncates first: the panel re-sends on every render, and
 * an append-only log would be unreadable after a few seconds of streaming.
 * @param body - the raw POST body, or null when it exceeded the cap.
 * @returns a short result description for the response body.
 */
function record(body) {
	let payload;
	if (body === null) {
		// The body exceeded `readBody`'s cap and the request was destroyed. Record
		// that explicitly rather than as `{}`: an over-cap report used to land as a
		// bare `{"at":…}` line, identical to a report that genuinely carried no
		// fields, which is indistinguishable from a broken client. (This is how the
		// cap first showed up in testing — as an empty log line that looked like a
		// bug in the recorder.)
		payload = { rejected: "body exceeded the size cap" };
	} else {
		try {
			payload = JSON.parse(body);
		} catch {
			payload = { unparsed: String(body).slice(0, 2000) };
		}
	}
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
		// A JSON scalar (`42`, `"x"`, `null`) spreads to nothing, which would write a
		// bare `{"at":…}` line indistinguishable from a real report.
		payload = { malformed: String(body).slice(0, 200) };
	}
	const file = logPath();
	try {
		mkdirSync(dirname(file), { recursive: true });
		if (shouldTruncate(file, payload)) {
			try {
				unlinkSync(file);
			} catch {
				// A missing file is the normal first case.
			}
		}
		// `at` is written LAST so the body cannot override it. With the spread first
		// a report carrying `"at":"1999-01-01T00:00:00.000Z"` landed verbatim, and
		// `test/granularity.probe.mjs` derives its delta-t from that field — so a
		// forged timestamp silently produced garbage intervals.
		const line = JSON.stringify({ ...payload, at: new Date().toISOString() });
		appendFileSync(file, `${line}\n`, "utf8");
		return `ok -> ${file}`;
	} catch (error) {
		return `log write failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/** Reports older than this are discarded rather than appended to. */
const LOG_TTL_MS = 15 * 60 * 1000;

/**
 * Hard ceiling on the log's size.
 *
 * The TTL alone does not bound this file. `shouldTruncate` looks at the *mtime*,
 * and every append refreshes it — so a session that reports continuously (the panel
 * beacons on every state change, i.e. many times a second while a file streams)
 * keeps the file permanently "fresh" and the TTL never fires. Measured before this
 * cap existed: 300 ordinary reports grew the file past 600 KB with no truncation,
 * and the real log reached 4 MB.
 *
 * 2 MiB is chosen to be safely readable: at roughly 300 bytes per report that is
 * some 7000 lines, far more than any diagnosis needs, while keeping the file small
 * enough to open and grep.
 */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Whether this report should start the log over.
 *
 * The browser sends a report per change, so the file must not grow without bound;
 * but truncating on every report would erase the history the moment one arrives,
 * leaving a single line and no context. The rule is: an explicit `reset`, a file
 * that has gone stale, or a file that has hit the size ceiling.
 * @param file - the log path.
 * @param payload - the parsed report.
 * @returns whether to delete the file first.
 */
function shouldTruncate(file, payload) {
	if (payload !== null && typeof payload === "object" && payload.reset === true) return true;
	try {
		const stats = statSync(file);
		if (Date.now() - stats.mtimeMs > LOG_TTL_MS) return true;
		return stats.size >= LOG_MAX_BYTES;
	} catch {
		// No file yet: nothing to truncate.
		return false;
	}
}

/**
 * Summarize the host's composed browser roster.
 *
 * This is the server's own answer to "is my client half in the boot graph?", which
 * is otherwise unanswerable from outside: the index page is behind a per-process
 * token, and `dsh web` writes no startup log. Reading the module service directly
 * beats inferring from the page.
 * @param modules - the `clientModules` service, when mounted.
 * @returns a JSON-serializable summary.
 */
function describeGraph(modules) {
	if (modules === null || modules === void 0) return { available: false, note: "clientModules service is not mounted" };
	try {
		const graph = modules.graph();
		const entries = Array.isArray(graph?.entries) ? graph.entries : [];
		return {
			available: true,
			entryCount: entries.length,
			ids: entries.map((entry) => entry.id),
			liveDiff: entries.filter((entry) => typeof entry.id === "string" && entry.id.includes("live-diff")).map((entry) => ({
				id: entry.id,
				url: entry.url,
				rev: entry.rev,
				inject: entry.inject ?? [],
				external: entry.external ?? []
			})),
			batches: Array.isArray(graph?.batches)
				? graph.batches.map((batch) => ({ phase: batch.phase, entries: batch.entries, url: batch.url, rev: batch.rev }))
				: []
		};
	} catch (error) {
		return { available: false, note: `graph() threw: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Fetch one of the host's own bundle URLs and report what it answered.
 *
 * A 404 here is the decisive reading: if the batch combo containing this plugin
 * 404s, the bundle never reaches the browser and every downstream symptom follows.
 * @param modules - the `clientModules` service.
 * @param path - the combo path to request.
 * @returns a JSON-serializable summary.
 */
function describeFetch(modules, path) {
	if (typeof path !== "string" || path === "") return { note: "pass ?fetch=/plugins/... to probe a bundle URL" };
	try {
		const response = modules.fetchBundle({ method: "GET", url: path });
		return { path, status: response.status, contentType: response.headers?.get?.("content-type") ?? null };
	} catch (error) {
		return { path, note: `fetchBundle threw: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Host plugin body: register the diagnostic routes.
 *
 * The declarations are static (`inject`) and the services are read off the
 * context, matching how the shipped host plugins register their own web routes —
 * a dynamic `ctx.inject` would leave a route silently unregistered if the service
 * arrived later, which here would look exactly like "the browser has nothing to
 * report".
 * @param ctx - host context carrying the web server and the client module service.
 */
export function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: DIAG_PATH,
		handler: async (req, res) => {
			// GET reports the host's own view of the browser roster; POST records one
			// report from the browser.
			if (req.method === "GET") {
				const url = new URL(req.url ?? "/", "http://localhost");
				const body = JSON.stringify({
					graph: describeGraph(ctx.clientModules),
					fetch: describeFetch(ctx.clientModules, url.searchParams.get("fetch"))
				}, null, 2);
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(body);
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
				res.end("GET or POST only");
				return;
			}
			const body = await readBody(req);
			const result = record(body);
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end(result);
		}
	}), "live-diff: diagnostic route");

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: STYLE_PATH,
		handler: (req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
				res.end("GET or HEAD only");
				return;
			}
			const css = readStyle();
			if (css === null) {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end(`no stylesheet at ${styleFile()}`);
				return;
			}
			res.writeHead(200, {
				"content-type": "text/css; charset=utf-8",
				"cache-control": "no-store"
			});
			res.end(req.method === "HEAD" ? undefined : css);
		}
	}), "live-diff: backdrop stylesheet route");
}

/** Services this half needs before it can register anything. */
export const inject = ["webServer", "clientModules"];
