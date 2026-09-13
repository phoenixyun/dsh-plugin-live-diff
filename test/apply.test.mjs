/**
 * Exercise `apply()` with a recorder context before the browser ever sees it.
 *
 * Registration calls are contract-shaped: a wrong field name, a duplicated kind,
 * or an `inject` that is not a function fails silently at runtime as "nothing
 * rendered". Running `apply` here turns those into loud assertions, which is
 * worth far more than another restart-and-look cycle.
 *
 * Run: node test/apply.test.mjs
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
	useSyncExternalStore: () => null
};
const requireStub = (specifier) => {
	if (specifier === "react/jsx-runtime") return { jsx, Fragment: Symbol("Fragment") };
	if (specifier === "react") return reactStub;
	if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return { DiffBlock: () => null };
	throw new Error(`unexpected require: ${specifier}`);
};

new Function(source)();
const plugin = registration.factory(requireStub);

// ── recorder context ────────────────────────────────────────────────────────
const recorded = { effects: [], slotInjections: [], slotRegistrations: [], tabTypes: [] };

const makeSlotRegistry = (name) => ({
	inject: (slotName, factory) => {
		recorded.slotInjections.push({ from: name, slot: slotName, factoryIsFunction: typeof factory === "function" });
		// Run the factory as the framework would, capturing what it registers.
		const produced = factory();
		if (produced !== null && produced !== void 0 && typeof produced[Symbol.iterator] === "function" && typeof produced.next === "function") {
			for (const entry of produced) recorded.slotRegistrations.push({ slot: slotName, entry });
		}
		return () => {};
	},
	register: (options, component) => {
		recorded.slotRegistrations.push({ slot: options.name, entry: options, component });
		return () => {};
	}
});

const ctx = {
	slots: makeSlotRegistry("ctx"),
	effect: (fn, label) => {
		recorded.effects.push(label);
		const disposer = fn();
		return typeof disposer === "function" ? disposer : () => {};
	},
	sidebarRightTabs: {
		register: (definition) => {
			recorded.tabTypes.push(definition);
			return () => {};
		}
	},
	sessions: {
		binding: () => ({ eventSource: { getSnapshot: () => null, subscribe: () => () => {} } }),
		list: {
			getSnapshot: () => ({ byId: {}, current: "session-1" }),
			subscribe: () => () => {}
		}
	}
};

// `apply` is a total function: it must not throw for a well-formed context.
plugin.apply(ctx);

// ── assertions ──────────────────────────────────────────────────────────────
assert.deepEqual(
	plugin.inject,
	["slots", "sidebarRightTabs", "sessions"],
	"declares every service it reads — the context proxy throws on an undeclared read"
);

// Tool views: both mutation tools are taken over.
const toolViews = recorded.slotInjections.filter((entry) => entry.slot === "tool.call.toolview");
assert.equal(toolViews.length, 1, "injects the tool view slot once");
assert.ok(toolViews[0].factoryIsFunction, "the tool view injection is a factory");

// Conversation view tab: deliberately absent. A transcript-area tab was tried and
// removed, so a registration here would be a regression rather than a feature.
const conversationViews = recorded.slotInjections.filter((entry) => entry.slot === "conversation.view");
assert.equal(conversationViews.length, 0, "registers no conversation-view tab");

// Sidebar: a page-type definition plus both keyed seats.
assert.equal(recorded.tabTypes.length, 1, "registers exactly one sidebar tab type");
const tab = recorded.tabTypes[0];
assert.equal(tab.kind, "live-diffs", "the tab kind is what openTab names");
assert.equal(typeof tab.id, "string", "the definition carries an implementation id");
assert.equal(typeof tab.title, "function", "title is a function, as the contract requires");
assert.equal(tab.patterns, void 0, "no patterns means a page type, not a resource type");
assert.equal(tab.priority, "extension", "registers in the extension band");
assert.equal(tab.title(), "Live Diffs", "the chip text is stable");

// The `guide` entry is what makes the tab reachable at all. The sidebar's add
// control opens the *guide page*, which lists one capsule per guide entry; a type
// without one registers, runs `apply`, and still cannot be opened by a user. That
// is exactly how this plugin spent several rounds looking like it never loaded.
assert.ok(Array.isArray(tab.guide), "the type contributes a guide entry");
assert.equal(tab.guide.length, 1, "exactly one capsule");
assert.equal(typeof tab.guide[0].order, "number", "the capsule carries an ascending order");
assert.equal(tab.guide[0].title(), "Live Diffs", "the capsule is titled");
assert.equal(typeof tab.guide[0].description, "function", "the capsule describes itself");

const sidebarBody = recorded.slotInjections.filter((entry) => entry.slot === "sidebar.right.pane.tab");
const sidebarTitle = recorded.slotInjections.filter((entry) => entry.slot === "sidebar.right.pane.tab.title");
assert.equal(sidebarBody.length, 1, "injects the sidebar tab body seat once");
assert.equal(sidebarTitle.length, 1, "injects the sidebar tab title seat once");

// The seats are keyed by the definition id, and the body injects the reader.
const bodyRegistration = recorded.slotRegistrations.find((entry) => entry.slot === "sidebar.right.pane.tab");
assert.equal(bodyRegistration.entry.key, tab.id, "the body seat is keyed by the definition id");
assert.equal(typeof bodyRegistration.entry.inject, "function", "the body seat injects the session-bound reader");
assert.equal(typeof bodyRegistration.component, "function", "the body seat registers a component");
const injected = bodyRegistration.entry.inject("session-1");
assert.ok("__diffSource" in injected, "the body receives the diff source for its session");

const titleRegistration = recorded.slotRegistrations.find((entry) => entry.slot === "sidebar.right.pane.tab.title");
assert.equal(titleRegistration.entry.key, tab.id, "the title seat is keyed by the same id");

// Effects own every long-lived registration, so disposal is wired up. There are
// exactly two: the always-on overlay panel and the sidebar tab type. The overlay
// is the one that must be owned here — it outlives any opened tab.
assert.equal(recorded.effects.length, 2, "both the overlay and the tab type are owned by effects");
assert.ok(
	recorded.effects.includes("live-diff: overlay panel"),
	"the overlay starts from apply(), so it exists with no tab open"
);
assert.ok(
	recorded.effects.includes("live-diff: sidebar tab type"),
	"the sidebar type is registered inside an owned effect"
);

// ── layout guard ────────────────────────────────────────────────────────────
// A percentage height on the view's root resolves against the parent's height. A
// sidebar pane has no definite height, so it resolves to zero; with `overflow:
// auto` that clipped the entire panel while the component rendered perfectly and
// beaconed faithfully. This bug was shipped twice — once as `height: 100%`, once
// as `maxHeight: 100%` — and both times it was indistinguishable from "no data".
// The guard is a source assertion because the failure lives in CSS, which the
// render stubs cannot exercise.
const rootLayoutUsesNoPercentHeight = !/height:\s*"(?:100%|\d+%)"/.test(source);
assert.ok(rootLayoutUsesNoPercentHeight, "no percentage height in the view's layout");
const rootLayoutClipsNothing = !/pageStyle[\s\S]{0,400}?overflow:\s*"auto"/.test(source);
assert.ok(rootLayoutClipsNothing, "the root layout does not clip its own content");

// And the colours must be stated rather than inherited, for the same reason: an
// inherited colour on a white pane is white-on-white.
assert.ok(!/var\(--dsw-/.test(source), "no theme variables — a diagnostic must not be able to go invisible");

// The plugin must not rename the host application's browser tab.
//
// It used to write its counters into `document.title`. That renamed the host's
// own tab, and the reading was only visible while the tab was inactive — the one
// moment nobody is watching a live diff. The diagnostics beacon is the evidence
// channel; this guard keeps the title out of the code.
assert.ok(!/document\.title\s*=/.test(source), "the plugin must not overwrite document.title");

// Every third-party module the client half `require`s must be declared in
// `dsh.client.inject`.
//
// The declaration was `@deepseek-ai/dsh-client-ui-tool` while the code required
// `@deepseek-ai/dsh-client-ui-primitives` — a leftover from an earlier design that
// rendered through the tool package. Nothing failed, because the module table
// resolves whatever the factory asks for; the declaration is what tells the shell
// which packages must be on the boot graph, so a wrong one is a portability bug
// that only shows up on someone else's install.
const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const declared = new Set(manifest.dsh?.client?.inject ?? []);
const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
const builtin = new Set(["react", "react/jsx-runtime", "react-dom", "react-dom/client"]);
for (const specifier of required) {
	if (builtin.has(specifier)) continue;
	assert.ok(declared.has(specifier),
		`client requires ${specifier} but dsh.client.inject does not declare it`);
}
// And the reverse: a declared package the code never imports is a stale entry that
// would drag an unrelated package onto the boot graph.
for (const specifier of declared) {
	assert.ok(required.includes(specifier),
		`dsh.client.inject declares ${specifier} but the client never requires it`);
}

console.log("apply(): all assertions passed");
console.log(`  sidebar tab type: kind=${tab.kind} id=${tab.id} priority=${tab.priority}`);
console.log(`  slot injections: ${recorded.slotInjections.map((entry) => entry.slot).join(", ")}`);
console.log("  layout guard: no percentage height, no self-clipping, no theme variables, no title rewrite");
