/**
 * DOM-level tests for the overlay's incremental patcher and its resize handle.
 *
 * Why this file exists
 * --------------------
 * The flicker and the missing-content complaint were both *rendering* failures,
 * and the lesson from the earlier CSS bugs is that a render stub cannot see them:
 * `innerHTML = markup` looked perfectly correct in every source-level assertion
 * while destroying and rebuilding the subtree twelve times a second in the
 * browser. The only way to catch that class of bug before a restart-and-look
 * cycle is to run the patcher against a DOM that records element identity.
 *
 * The shim below is deliberately tiny and implements only what this code uses.
 * That mirrors production: the panel is built from `createElement` / `appendChild`
 * / `textContent`, nothing more.
 *
 * Run: node test/overlay.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─────────────────────────────── minimal DOM ────────────────────────────────

function createTextNode(text) {
	return { nodeType: 3, text: String(text), parentNode: null };
}

function createElement(tag) {
	// `style` mirrors the real object more closely than a bag of fields: assigning
	// `cssText` parses out the individual properties, so `style.width` survives a
	// `cssText` assignment. Without that, the plugin's own `style.width` readback
	// (used for the resize start width) returned "" in the shim while a browser
	// would have returned the value — the assertions were testing the shim.
	const style = { display: "", width: "" };
	let cssText = "";
	Object.defineProperty(style, "cssText", {
		get: () => cssText,
		set: (value) => {
			cssText = String(value);
			for (const declaration of cssText.split(";")) {
				const colon = declaration.indexOf(":");
				if (colon <= 0) continue;
				const name = declaration.slice(0, colon).trim();
				const property = name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
				if (property === "cssText" || property === "") continue;
				style[property] = declaration.slice(colon + 1).trim();
			}
		}
	});
	const element = {
		nodeType: 1,
		tagName: String(tag).toUpperCase(),
		childNodes: [],
		parentNode: null,
		style,
		className: "",
		title: "",
		id: "",
		innerHTML: "",
		listeners: {}
	};
	// `textContent` is derived from the child nodes, like the real property, rather
	// than stored as a plain field. A plain field made `element.textContent` stay
	// empty after `appendChild(textNode)`, so assertions on rendered text were
	// reading a value the DOM would never have had.
	Object.defineProperty(element, "textContent", {
		get() {
			if (element.childNodes.length === 0) return element.__text ?? "";
			return element.childNodes.map((node) => node.textContent ?? node.text ?? "").join("");
		},
		set(value) {
			element.childNodes.length = 0;
			element.__text = String(value);
		}
	});
	// `innerHTML` is write-counted.
	//
	// This is the only way to observe the property the plugin is *for*: whether a
	// row's markup was rewritten on a tick where nothing about it changed. A plain
	// field cannot distinguish "wrote the same string again" from "did not write",
	// which made the anti-flicker assertion tautological — a version that rewrote
	// every row on every tick passed the whole suite.
	element.__htmlWrites = 0;
	Object.defineProperty(element, "innerHTML", {
		get() { return element.__html ?? ""; },
		set(value) {
			element.__html = String(value);
			element.__htmlWrites += 1;
		}
	});
	Object.defineProperty(element, "children", {
		get: () => element.childNodes.filter((node) => node.nodeType === 1)
	});
	Object.defineProperty(element, "firstChild", {
		get: () => element.childNodes[0] ?? null
	});
	Object.defineProperty(element, "lastChild", {
		get: () => element.childNodes[element.childNodes.length - 1] ?? null
	});
	element.appendChild = (child) => {
		if (child.parentNode !== null && typeof child.parentNode.removeChild === "function") {
			child.parentNode.removeChild(child);
		}
		child.parentNode = element;
		element.childNodes.push(child);
		return child;
	};
	element.removeChild = (child) => {
		const index = element.childNodes.indexOf(child);
		if (index >= 0) element.childNodes.splice(index, 1);
		child.parentNode = null;
		return child;
	};
	element.append = (...nodes) => {
		for (const node of nodes) {
			element.appendChild(typeof node === "string" ? createTextNode(node) : node);
		}
	};
	element.addEventListener = (type, handler) => {
		(element.listeners[type] ??= []).push(handler);
	};
	element.removeEventListener = (type, handler) => {
		const list = element.listeners[type] ?? [];
		const index = list.indexOf(handler);
		if (index >= 0) list.splice(index, 1);
	};
	element.setPointerCapture = () => {};
	element.releasePointerCapture = () => {};
	/**
	 * Dispatch an event the way a browser does: fire on this element, then bubble up
	 * through the ancestors, keeping `target` as the element it started on.
	 *
	 * The previous version called only this element's own listeners, which silently
	 * made a test meaningless: pressing a button inside the header dispatched nothing
	 * at all, because the drag listener lives on the header. The handler's "do not
	 * start a drag from a control" guard was therefore never exercised — removing it
	 * still passed the suite.
	 */
	element.dispatch = (type, event = {}) => {
		const payload = { target: element, preventDefault() {}, ...event };
		let cursor = element;
		while (cursor !== null && cursor !== void 0) {
			for (const handler of cursor.listeners?.[type] ?? []) handler(payload);
			cursor = cursor.parentNode;
		}
	};
	/** Nearest ancestor (or self) matching the selector, as `Element.closest` does. */
	element.closest = (selector) => {
		let cursor = element;
		while (cursor !== null && cursor !== void 0) {
			if (selector === "button" && cursor.tagName === "BUTTON") return cursor;
			cursor = cursor.parentNode;
		}
		return null;
	};
	element.getBoundingClientRect = () => ({ width: 400, height: 600, top: 0, left: 0, right: 400, bottom: 600 });
	// Every element gets `classList`, not just `body`: the resize handle toggles
	// its own `on` marker through it.
	element.classList = {
		values: new Set(),
		add(name) { this.values.add(name); },
		remove(name) { this.values.delete(name); },
		contains(name) { return this.values.has(name); }
	};
	// `textContent` is a plain field above (the patcher writes it and the tests
	// read it); `style.display` and friends are plain fields too. No CSS is
	// computed here — that is the browser's job, and `apply.test.mjs` guards the
	// layout rules that must not regress.
	return element;
}

/** A fresh fake environment, installed on `globalThis`. */
function installDom() {
	const byId = new Map();
	const body = createElement("body");
	const documentElement = createElement("html");
	documentElement.clientWidth = 1280;
	// A real viewport has both. Without `clientHeight` the panel falls back to its
	// minimum height, which is correct behaviour but makes height assertions test the
	// fallback instead of the fraction.
	documentElement.clientHeight = 768;
	const store = new Map();
	const dom = {
		body,
		document: {
			body,
			documentElement,
			// `id` is a plain field on the element, so the registry has to be
			// wired in through the factory. Without it `getElementById` always
			// returns null, `ensureOverlay` never finds its own panel, and it
			// builds a *second* one on every call — which silently makes every
			// assertion below inspect the wrong element.
			createElement: (tag) => {
				const element = createElement(tag);
				Object.defineProperty(element, "id", {
					get: () => element.__id ?? "",
					set: (value) => {
						element.__id = value;
						byId.set(value, element);
					}
				});
				return element;
			},
			createTextNode,
			getElementById: (id) => byId.get(id) ?? null
		},
		window: {
			localStorage: {
				getItem: (key) => (store.has(key) ? store.get(key) : null),
				setItem: (key, value) => { store.set(key, String(value)); },
				removeItem: (key) => { store.delete(key); }
			},
			// Recorded so a test can prove a listener was REMOVED, not merely added.
			// A leaked `window` listener is invisible to behaviour assertions — it
			// only shows up as one more callback per plugin load.
			listeners: new Map(),
			addEventListener(type, handler) {
				if (!this.listeners.has(type)) this.listeners.set(type, new Set());
				this.listeners.get(type).add(handler);
			},
			removeEventListener(type, handler) {
				const set = this.listeners.get(type);
				if (set !== void 0) set.delete(handler);
			}
		},
		store
	};
	globalThis.document = dom.document;
	globalThis.window = dom.window;
	return dom;
}

// ───────────────────────────── bundle under test ────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

const jsx = (type, props, children) => ({ type, props, children });
/**
 * Every ref object `useRef` has created, so a test can find the one a component
 * attached and check WHICH element carries it. This is the only way to observe the
 * defect this guards: a ref on the wrong element throws nothing and looks correct
 * in the tree unless you inspect where it landed.
 */
const createdRefs = [];
const reactStub = {
	jsx,
	Fragment: Symbol("Fragment"),
	useEffect: () => {},
	useCallback: (fn) => fn,
	useRef: (value) => {
		const ref = { current: value };
		createdRefs.push(ref);
		return ref;
	},
	useMemo: (compute) => compute(),
	// `DiffsView` calls `useState`; without it the plugin's bundle cannot even be
	// materialized by this harness, which is part of why that view had no coverage.
	useState: (value) => [value, () => {}],
	useSyncExternalStore: () => null
};
const requireStub = (specifier) => {
	if (specifier === "react/jsx-runtime") return { jsx, Fragment: Symbol("Fragment") };
	if (specifier === "react") return reactStub;
	if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return { DiffBlock: () => null };
	throw new Error(`unexpected require: ${specifier}`);
};

/**
 * Evaluate a **fresh copy** of the bundle against a fresh fake DOM.
 *
 * Re-evaluating matters: the overlay keeps module-level state (`overlayLastDiffs`,
 * `overlayCollapsed`) that would otherwise leak between tests and make results
 * depend on execution order. A fresh evaluation is the only way to reset it,
 * since none of it is exported.
 * @returns the plugin surface plus the fake environment.
 */
function loadPlugin() {
	const dom = installDom();
	let registration;
	globalThis.window.__ModuleLoader__ = { load: (value) => { registration = value; } };
	new Function(source)();
	const plugin = registration.factory(requireStub);
	return { dom, plugin, node: plugin.ensureOverlay() };
}

// ─────────────────────────────── helpers ────────────────────────────────────

/** Row elements of the first diff block. */
function rowsOf(node) {
	const list = node.__list;
	const block = list.children.find((child) => child.className === "diff");
	if (block === void 0) return [];
	return [...block.children[1].children];
}

/** The header element of the first diff block. */
function headOf(node) {
	const block = node.__list.children.find((child) => child.className === "diff");
	return block === void 0 ? null : block.children[0];
}

/** All four corner resize grips, in creation order: tl, tr, bl, br. */
function gripsOf(node) {
	return node.children.filter(
		(child) => typeof child.className === "string" && child.className.startsWith("rz ")
	);
}

/** The top-left grip, which the drag tests use as the reference corner. */
function stripOf(node) {
	return node.children.find((child) => child.className === "rz rz-tl");
}

/** The header, which doubles as the move handle and hosts the buttons. */
function barOf(node) {
	return node.children.find((child) => child.className === "bar");
}

/** The bar's buttons, in DOM order: collapse, then hide. */
function buttonsOf(node) {
	const bar = barOf(node);
	return bar === void 0 ? [] : bar.children.filter((child) => child.tagName === "BUTTON");
}

/** A minimal but complete diagnostics report, for the empty-state render. */
function fakeReport(reason = "no transient (live chunk) entries in the window") {
	return {
		entryCount: 0, transientCount: 0, deltaCount: 0, accumulating: 0,
		entryTypes: new Map(), chunkTypes: new Map(), toolNames: [], sequence: "", reason
	};
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const check = (name, condition, detail = "") => {
	if (!condition) throw new Error(`${name}${detail === "" ? "" : ` <- ${detail}`}`);
};

// ───────────────────────────────── tests ────────────────────────────────────

test("空状态显示占位而非空白", () => {
	const { plugin, node } = loadPlugin();
	plugin.renderOverlay([], fakeReport(), { broken: void 0 });
	check("有占位元素", node.__list.children.some((child) => child.className === "empty"));
	check("诊断面板非空", node.__diag.textContent.includes("no transient"), node.__diag.textContent);
});

test("patchOverlayList 复用已有行元素（不重建）", () => {
	const { plugin, node } = loadPlugin();
	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "x = 1", streaming: true
	})]);
	const first = rowsOf(node);
	check("首帧有一行", first.length === 1, `got ${String(first.length)}`);

	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "x = 1\ny = 2", streaming: true
	})]);
	const second = rowsOf(node);
	check("第二帧有两行", second.length === 2, `got ${String(second.length)}`);
	// The regression: a rebuild would have produced a brand-new element here,
	// restarting the row's fade-in animation on every 80 ms tick.
	check("第一行是同一个 DOM 元素", second[0] === first[0]);
	check("第一行文本未变", second[0].children[2].innerHTML === first[0].children[2].innerHTML);
});

test("行数变少时丢弃多余行", () => {
	const { plugin, node } = loadPlugin();
	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "1\n2\n3", streaming: true
	})]);
	check("先有三行", rowsOf(node).length === 3, `got ${String(rowsOf(node).length)}`);
	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "1", streaming: true
	})]);
	check("剩一行", rowsOf(node).length === 1, `got ${String(rowsOf(node).length)}`);
});

test("流式结束时移除光标与 writing 标记", () => {
	const { plugin, node } = loadPlugin();
	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "x = 1", streaming: true
	})]);
	const row = rowsOf(node)[0];
	const caret = row.children[2].lastChild;
	check("流式时有光标", caret !== null && caret.className === "c");
	const head = headOf(node);
	check("流式时显示 writing", head.children[4].textContent === "writing", head.children[4].textContent);

	// A settled diff: streaming off, caret gone. This is what `finishedViews`
	// produces when the call completes.
	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "x = 1", streaming: false
	})]);
	const settled = rowsOf(node)[0];
	check("结束后无光标",
		settled.children[2].lastChild === null || settled.children[2].lastChild.className !== "c");
	check("结束后无 writing", head.children[4].textContent === "", head.children[4].textContent);
});

test("同一行文本增长时原地更新，不新增元素", () => {
	const { plugin, node } = loadPlugin();
	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "x", streaming: true
	})]);
	const before = rowsOf(node)[0];
	const textBefore = before.children[2].innerHTML;
	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "xyz", streaming: true
	})]);
	const after = rowsOf(node)[0];
	check("仍是同一个元素", after === before);
	check("文本已更新", after.children[2].innerHTML !== textBefore, after.children[2].innerHTML);
});

test("连续 40 帧流式增长：既有行元素全程不被替换", () => {
	// The closest offline stand-in for the reported flicker. The real panel is
	// polled at 80 ms while a file is written, so it re-renders ~12 times a second
	// for the whole write. If any of those ticks rebuilt a row, its fade-in would
	// restart — which is what "一直在闪" was. Here every row element created on an
	// earlier tick must still be the same object on every later tick.
	const { plugin, node } = loadPlugin();
	const lines = [];
	const seen = new Map();
	for (let frame = 0; frame < 40; frame += 1) {
		// Each frame appends a partial line and extends the one being written,
		// mirroring `tool-call-delta` growth inside the JSON string.
		lines.push(`line ${String(frame)}`);
		const streaming = `partial ${"x".repeat(frame)}`;
		const newText = [...lines, streaming].join("\n");
		plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
			path: "/a/b.py", oldText: null, newText, streaming: true
		})]);

		const rows = rowsOf(node);
		// `lines` grows by one per frame, and the line being written is always
		// present as the last row, so the total is `frame + 2`.
		check(`第 ${String(frame)} 帧行数正确`, rows.length === frame + 2,
			`got ${String(rows.length)}`);
		for (let index = 0; index < rows.length; index += 1) {
			const previous = seen.get(index);
			if (previous === void 0) seen.set(index, rows[index]);
			else if (previous !== rows[index]) {
				throw new Error(`第 ${String(frame)} 帧的行 ${String(index)} 被替换成了新元素`);
			}
		}
	}
	// Only the growing line may carry the current-line marker.
	const marked = rowsOf(node).filter((row) => row.className.includes("cur"));
	check("仅有正在写入的一行带 cur", marked.length === 1, `got ${String(marked.length)}`);
});

test("相同文本不重复写 DOM（动画不会重启动）", () => {
	// This asserts the property the whole plugin exists for, and it has to be
	// observed through a write counter.
	//
	// The previous version captured `text.__text` before the second patch and
	// compared it afterwards — but `__text` and `innerHTML` are assigned together in
	// the same branch, so the assertion held whether or not the DOM was touched.
	// Verified: replacing the dedupe guard with `if (true) {` (rewriting every row's
	// markup on every tick, i.e. exactly the flicker bug) kept the whole suite green.
	const { plugin, node } = loadPlugin();
	const view = plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "x = 1", streaming: true
	});
	plugin.patchOverlayList(node.__list, [view]);
	const text = rowsOf(node)[0].children[2];
	const writesAfterFirst = text.__htmlWrites;
	check("首次绘制写入了 markup", writesAfterFirst === 1, `got ${String(writesAfterFirst)}`);

	plugin.patchOverlayList(node.__list, [view]);
	check("文本未变时不重写 markup",
		text.__htmlWrites === writesAfterFirst,
		`writes went ${String(writesAfterFirst)} -> ${String(text.__htmlWrites)}`);
	check("仍是同一个文本节点", rowsOf(node)[0].children[2] === text);

	// And the counter must actually be able to move, or the assertion above is
	// vacuous for the opposite reason.
	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "x = 2", streaming: true
	})]);
	check("文本变化时确实重写", text.__htmlWrites > writesAfterFirst,
		`writes stayed at ${String(text.__htmlWrites)}`);
});

test("写入结束后不残留 cur 高亮", () => {
	// The "finished" branch of `renderOverlay` had no coverage at all: the existing
	// empty-state test runs on a fresh module, which takes the placeholder branch
	// instead. That branch cleared `caret` but not `current`, and `current` is what
	// drives the `.cur` wash.
	const { plugin, node } = loadPlugin();
	const frame = {
		entryCount: 1, transientCount: 2, deltaCount: 3, accumulating: 1,
		entryTypes: new Map(), chunkTypes: new Map(), toolNames: ["write"], sequence: "", reason: "deltas present"
	};
	plugin.renderOverlay(
		[{ callId: "stream:0", toolName: "write", diff: { path: "/a/b.py", oldText: null, newText: "a\nb", streaming: true } }],
		frame,
		{ broken: void 0 }
	);
	check("流式时最后一行带 cur",
		rowsOf(node).some((row) => row.className.includes("cur")));

	// Settle: entries empty, but something was on screen.
	plugin.renderOverlay([], { ...frame, entryCount: 0, transientCount: 0, deltaCount: 0, accumulating: 0, reason: "idle" }, { broken: void 0 });
	const rows = rowsOf(node);
	check("结束后无 cur 高亮", rows.every((row) => !row.className.includes("cur")),
		JSON.stringify(rows.map((row) => row.className)));
	check("结束后无光标",
		rows.every((row) => row.children[2].lastChild === null || row.children[2].lastChild.className !== "c"));
	check("结束后保留了内容", rows.length === 2, `got ${String(rows.length)}`);
});

test("行符号列随 kind 变化而更新", () => {
	// Rows are matched to elements by index while their KIND is recomputed every
	// tick, so a row can change from context to addition in place. The sign is part
	// of the row's meaning (a green addition must not read as a blank context line),
	// so it has to be repainted rather than written once at creation.
	const { plugin, node } = loadPlugin();
	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "a\nb", streaming: true
	})]);
	const first = rowsOf(node);
	check("首帧两行都是新增",
		first.every((row) => row.className.includes("add") && row.children[1].textContent === "+"));

	// Now a diff whose SECOND row is context. Position 1 must stop claiming to be
	// an addition.
	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: "a\nb", newText: "a\nc", streaming: true
	})]);
	const second = rowsOf(node);
	const kinds = second.map((row) => row.className.replace("r ", ""));
	const signs = second.map((row) => row.children[1].textContent);
	check("种类与符号一一对应",
		kinds.every((kind, index) => {
			const expected = kind.startsWith("add") ? "+" : kind.startsWith("del") ? "-" : " ";
			return signs[index] === expected;
		}),
		`kinds=${JSON.stringify(kinds)} signs=${JSON.stringify(signs)}`);
});

test("占位提示在有内容时移除、变空时回来", () => {
	const { plugin, node } = loadPlugin();
	plugin.patchOverlayList(node.__list, []);
	plugin.setPlaceholder(node.__list, "No file edits yet.");
	check("占位出现", node.__list.children.some((child) => child.className === "empty"));
	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "x", streaming: true
	})]);
	plugin.setPlaceholder(node.__list, null);
	check("占位移除", !node.__list.children.some((child) => child.className === "empty"));
});

test("占位提示的换行渲染成 br 而不是被折叠", () => {
	// The fake DOM does not collapse whitespace, so it cannot reproduce the bug
	// this guards: assigning `"a\nb"` to `textContent` renders on ONE line in a
	// real browser, because a newline in text content is collapsed like any other
	// whitespace. Asserting the structure (an actual `<br>` element) is what makes
	// this test meaningful — asserting the text would pass either way.
	const { plugin, node } = loadPlugin();
	plugin.setPlaceholder(node.__list, "No file edits yet.\nThe next edit will appear here.");
	const placeholder = node.__list.children.find((child) => child.className === "empty");
	check("占位存在", placeholder !== void 0);
	const breaks = placeholder.children.filter((child) => child.tagName === "BR");
	check("换行被渲染成 br 元素", breaks.length === 1, `got ${String(breaks.length)}`);

	// And a single-line placeholder must not gain a stray break.
	plugin.setPlaceholder(node.__list, "one line");
	check("单行不产生 br", placeholder.children.filter((c) => c.tagName === "BR").length === 0);
	// Reusing the element keeps its identity, but the text must actually change.
	check("文本已更新", placeholder.textContent.includes("one line"), placeholder.textContent);
	check("旧文本已清除", !placeholder.textContent.includes("No file edits yet."));
});

test("跟随滚动的 ref 落在真正可滚动的元素上", () => {
	// `.dshld_body` is the element carrying `max-height` and `overflow` (injected via
	// `ensureStyles`), so it is the only element that can scroll. The ref used to be
	// a prop, and the sidebar view attached it to an outer wrapper that has no
	// overflow: the pin then set `scrollTop` on a box that could not scroll, and the
	// body that actually scrolls was never followed. Nothing threw — the diff just
	// grew out of view — so this has to be asserted structurally.
	const { plugin } = loadPlugin();
	const diff = { path: "/a/b.py", oldText: null, newText: "a\nb", streaming: true };
	createdRefs.length = 0;
	const tree = plugin.DiffBodyScroller({ diff, children: null });

	check("滚动容器带 dshld_body 类", tree.props.className === "dshld_body", tree.props.className);
	check("滚动容器有 onScroll", typeof tree.props.onScroll === "function");
	check("滚动容器带 ref", tree.props.ref !== void 0 && tree.props.ref !== null);
	check("ref 来自 useRef（可被 React 挂上）",
		createdRefs.includes(tree.props.ref), "ref 不是 useRef 创建的");

	// The follow-scroll must not fire when the element is not mounted yet, and must
	// not throw when the element is absent.
	const handler = tree.props.onScroll;
	tree.props.ref.current = null;
	handler();
	check("元素未挂载时 onScroll 不抛错", true);

	// A body that is scrolled to the bottom counts as following; scrolled up does not.
	const element = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 };
	tree.props.ref.current = element;
	element.scrollTop = 800;
	handler();
	element.scrollTop = 100;
	handler();
	check("滚动状态可被读取而不抛错", true);
});

test("buildDiffView 产出正确的行模型", () => {
	const { plugin } = loadPlugin();
	const view = plugin.buildDiffView({
		path: "/a/b.py", oldText: "keep\nold", newText: "keep\nnew", streaming: true
	});
	check("语言识别为 python", view.language === "python", view.language);
	check("首行是上下文", view.rows[0].kind === "ctx", view.rows[0].kind);
	check("有一处删除", view.removed === 1, `removed=${String(view.removed)}`);
	check("有一处新增", view.added === 1, `added=${String(view.added)}`);
	check("最后一行带光标", view.rows[view.rows.length - 1].caret === true);
});

test("只有正在写入的那一行带 cur 标记", () => {
	const { plugin, node } = loadPlugin();
	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "a\nb\nc", streaming: true
	})]);
	const rows = rowsOf(node);
	const marked = rows.filter((row) => row.className.includes("cur"));
	check("恰好一行被标记", marked.length === 1, `got ${String(marked.length)}`);
	check("是最后一行", marked[0] === rows[rows.length - 1]);
	check("其余行没有标记", rows.slice(0, -1).every((row) => !row.className.includes("cur")));

	// Settled: the marker must go away with the caret.
	plugin.patchOverlayList(node.__list, [plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "a\nb\nc", streaming: false
	})]);
	check("结束后无标记", rowsOf(node).every((row) => !row.className.includes("cur")));
});

// ──────────────────────────────── resize ────────────────────────────────────

test("左边缘拖拽改变宽度（左拖变宽）", () => {
	const { node } = loadPlugin();
	const strip = stripOf(node);
	check("存在拖拽把手", strip !== void 0);
	// The start width comes from the panel's own `style.width` (the shim's
	// `getBoundingClientRect` is a fixed 400 and is deliberately NOT the source —
	// in a real browser the rect is 0 for an element that is not yet in the
	// document, and reading it there used to collapse the panel to its minimum on
	// the first window resize). Assertions are therefore relative to the real start.
	const start = Number.parseFloat(node.style.width);
	check("起始宽度来自 style，不为 0", start > 0, node.style.width);

	strip.dispatch("pointerdown", { clientX: 500, pointerId: 1 });
	strip.dispatch("pointermove", { clientX: 400, pointerId: 1 });
	check("左拖 100px 后变宽 100px",
		node.style.width === `${String(Math.round(start + 100))}px`, node.style.width);
	// A second move within the same drag: the delta is still measured from the press
	// point, so the width must be start+dx, not lastWidth+dx.
	strip.dispatch("pointermove", { clientX: 600, pointerId: 1 });
	check("同一拖动内右拖 100px 后变窄 100px",
		node.style.width === `${String(Math.round(start - 100))}px`, node.style.width);
	strip.dispatch("pointerup", { clientX: 600, pointerId: 1 });

	// A SECOND, separate drag. This is what pins the baseline capture: the first drag
	// leaves the width at `start-100`, so a handler that measures from the previous
	// width instead of re-capturing on pointerdown reads the wrong baseline here. The
	// earlier single-drag version of this test could not tell the two apart, because
	// the captured value and the starting value happened to be equal on the first
	// press only.
	const afterFirst = Number.parseFloat(node.style.width);
	strip.dispatch("pointerdown", { clientX: 500, pointerId: 1 });
	strip.dispatch("pointermove", { clientX: 450, pointerId: 1 });
	check("第二次拖动左移 50px 后变宽 50px",
		node.style.width === `${String(Math.round(afterFirst + 50))}px`,
		`${String(node.style.width)}，第一次结束后是 ${String(afterFirst)}px`);
});

test("宽度被夹在最小值与视口之间", () => {
	const { plugin, node } = loadPlugin();
	const strip = stripOf(node);
	strip.dispatch("pointerdown", { clientX: 0, pointerId: 1 });
	// Drag far right: would go negative without clamping.
	strip.dispatch("pointermove", { clientX: 5000, pointerId: 1 });
	check("不小于最小值", node.style.width === `${String(plugin.WIDTH_MIN)}px`, node.style.width);
	// Drag far left: would exceed the viewport without clamping.
	strip.dispatch("pointermove", { clientX: -5000, pointerId: 1 });
	check("不超过视口上限", node.style.width === `${String(plugin.maxWidth())}px`, node.style.width);
});

test("默认高度不是满视口（否则会盖住宿主控件）", () => {
	// A full-height panel at `z-index: 2147483647` covered the host's own controls in
	// the bottom-right corner; one of them could not be clicked at all.
	const { plugin, node } = loadPlugin();
	const height = Number.parseFloat(node.style.height);
	check("高度是具体像素而不是 100vh", node.style.height.endsWith("px"), node.style.height);
	check("高度小于视口", height < 768, `${String(height)} vs 768`);
	check("高度不低于最小值", height >= plugin.HEIGHT_MIN, String(height));
	check("高度约等于视口的固定比例",
		Math.abs(height - 768 * plugin.HEIGHT_FRACTION) <= 1,
		`${String(height)} vs ${String(768 * plugin.HEIGHT_FRACTION)}`);
});

test("拖动标题栏可移动面板，并切换到 left/top 定位", () => {
	const { node } = loadPlugin();
	const bar = barOf(node);
	check("标题栏存在", bar !== void 0);
	// Unset style properties read as "" in a browser and as undefined in the shim, so
	// this checks falsiness rather than equality with the empty string.
	check("默认用 right/bottom 定位",
		Boolean(node.style.right) && !node.style.left,
		`right=${String(node.style.right)} left=${String(node.style.left)}`);

	// The shim's rect is a fixed box, so the anchor switch takes those numbers.
	bar.dispatch("pointerdown", { clientX: 500, clientY: 400, pointerId: 1 });
	bar.dispatch("pointermove", { clientX: 460, clientY: 380, pointerId: 1 });
	check("拖动后改用 left/top", Boolean(node.style.left) && Boolean(node.style.top),
		`left=${String(node.style.left)} top=${String(node.style.top)}`);
	check("right/bottom 已清除", !node.style.right && !node.style.bottom,
		`right=${String(node.style.right)} bottom=${String(node.style.bottom)}`);

	// A drag is a move, not a resize: width and height must be untouched.
	check("移动不改变宽度", node.style.width.endsWith("px"));
	check("移动不改变高度", node.style.height.endsWith("px"));
});

test("四个角手柄各自的方向都正确", () => {
	// Each corner grows the panel when dragged AWAY from its own corner, which means a
	// grip on the left grows on a negative `dx` and one on the right on a positive
	// `dx`; likewise the top on a negative `dy` and the bottom on a positive `dy`.
	// Getting a sign wrong makes a grip shrink when it should grow, and vice versa —
	// visible only by trying the specific corner.
	const { node } = loadPlugin();
	const grips = gripsOf(node);
	check("存在四个角手柄", grips.length === 4,
		`got ${grips.length}: ${grips.map((g) => g.className).join(", ")}`);
	check("四个角互不重复",
		new Set(grips.map((g) => g.className)).size === 4,
		grips.map((g) => g.className).join(", "));

	// name -> [widthSign, heightSign]: the sign a drag of +10,+10 should apply.
	const expected = { "rz-tl": [-1, -1], "rz-tr": [1, -1], "rz-bl": [-1, 1], "rz-br": [1, 1] };

	for (const grip of grips) {
		const [widthSign, heightSign] = expected[grip.className.replace("rz ", "")];
		// Fresh panel per corner so the clamp bounds never interfere.
		const fresh = loadPlugin().node;
		const target = gripsOf(fresh).find((g) => g.className === grip.className);
		const startWidth = Number.parseFloat(fresh.style.width);
		const startHeight = Number.parseFloat(fresh.style.height);

		target.dispatch("pointerdown", { clientX: 500, clientY: 500, pointerId: 1 });
		// Drag by +20,+20 and clamp the expectation into the same bounds the code uses:
		// width in [WIDTH_MIN, maxWidth], height in [HEIGHT_MIN, viewport].
		target.dispatch("pointermove", { clientX: 520, clientY: 520, pointerId: 1 });
		const wantWidth = Math.min(1256, Math.max(280, startWidth + widthSign * 20));
		const wantHeight = Math.min(768, Math.max(180, startHeight + heightSign * 20));
		check(`${grip.className} 宽度方向正确`,
			fresh.style.width === `${String(Math.round(wantWidth))}px`,
			`${fresh.style.width}，期望 ${String(Math.round(wantWidth))}px`);
		check(`${grip.className} 高度方向正确`,
			fresh.style.height === `${String(Math.round(wantHeight))}px`,
			`${fresh.style.height}，期望 ${String(Math.round(wantHeight))}px`);
		target.dispatch("pointerup", { clientX: 520, clientY: 520, pointerId: 1 });
	}
});

test("角手柄的尺寸被夹在合法区间", () => {
	const { plugin, node } = loadPlugin();
	const grip = stripOf(node);
	check("存在角手柄", grip !== void 0, "没有 .rz 元素");
	grip.dispatch("pointerdown", { clientX: 500, clientY: 500, pointerId: 1 });
	// Drag far beyond both bounds at once.
	grip.dispatch("pointermove", { clientX: -99999, clientY: -99999, pointerId: 1 });
	const grownWidth = Number.parseFloat(node.style.width);
	const grownHeight = Number.parseFloat(node.style.height);
	check("宽度不超过上限", grownWidth <= plugin.maxWidth(), String(grownWidth));
	check("高度不超过视口", grownHeight <= 768, String(grownHeight));
	grip.dispatch("pointermove", { clientX: 99999, clientY: 99999, pointerId: 1 });
	check("宽度不小于最小值",
		Number.parseFloat(node.style.width) >= plugin.WIDTH_MIN, node.style.width);
	check("高度不小于最小值",
		Number.parseFloat(node.style.height) >= plugin.HEIGHT_MIN, node.style.height);
});

test("拖拽不会吃掉标题栏按钮的点击", () => {
	// The move handle is the header, and the header contains the buttons. A press on a
	// button used to start a drag, which called `preventDefault()` and suppressed the
	// button's click — the hide button stopped working entirely.
	const { node } = loadPlugin();
	const bar = barOf(node);
	const buttons = buttonsOf(node);
	check("标题栏有两个按钮", buttons.length === 2, `got ${String(buttons.length)}`);
	const [collapse, hide] = buttons;

	// A press whose target is a button must not start a drag.
	hide.dispatch("pointerdown", { clientX: 500, clientY: 400, pointerId: 1 });
	check("按下按钮不进入拖拽态", !bar.classList.contains("on"));
	check("按下按钮不加 body 拖拽态", !node.ownerDocument?.body?.classList?.contains("dshld-resizing"));

	// And the handlers still do their job.
	check("隐藏按钮有 onclick", typeof hide.onclick === "function");
	const list = node.__list;
	hide.onclick();
	check("点击隐藏后面板不可见", node.style.display === "none", node.style.display);

	check("折叠按钮有 onclick", typeof collapse.onclick === "function");
	collapse.onclick();
	check("点击折叠后列表隐藏", list.style.display === "none", list.style.display);
	check("折叠标记已记录", node.__list !== void 0);
});

test("移动后位置会写入存储", () => {
	const { dom, node } = loadPlugin();
	const bar = barOf(node);
	bar.dispatch("pointerdown", { clientX: 500, clientY: 400, pointerId: 1 });
	bar.dispatch("pointermove", { clientX: 440, clientY: 360, pointerId: 1 });
	bar.dispatch("pointerup", { clientX: 440, clientY: 360, pointerId: 1 });
	check("left 已持久化", dom.store.has("dsh-live-diff:left"),
		`keys=${[...dom.store.keys()].join(",")}`);
	check("top 已持久化", dom.store.has("dsh-live-diff:top"));
});

test("拖动期间显示宽度读数，松手后写入存储", () => {
	const { dom, node } = loadPlugin();
	const strip = stripOf(node);
	const chip = node.__widthChip;
	const start = Number.parseFloat(node.style.width);
	check("初始隐藏", chip.style.display !== "inline");
	strip.dispatch("pointerdown", { clientX: 500, pointerId: 1 });
	check("拖动中显示", chip.style.display === "inline", chip.style.display);
	strip.dispatch("pointermove", { clientX: 450, pointerId: 1 });
	check("读数已更新", chip.textContent.endsWith("px"), chip.textContent);
	check("body 进入拖拽态", dom.body.classList.contains("dshld-resizing"));
	strip.dispatch("pointerup", { clientX: 450, pointerId: 1 });
	check("松手后隐藏", chip.style.display === "none", chip.style.display);
	// Dragging left by 50 widens by 50 from whatever the panel opened at.
	check("宽度已持久化", dom.store.get("dsh-live-diff:width") === String(Math.round(start + 50)),
		String(dom.store.get("dsh-live-diff:width")));
	check("body 类已清理", dom.body.classList.contains("dshld-resizing") === false);
	check("松手后撤销了 window 监听",
		(dom.window.listeners.get("pointerup")?.size ?? 0) === 0,
		`still ${String(dom.window.listeners.get("pointerup")?.size ?? 0)}`);
});

test("storedWidth 读回已保存的宽度并忽略坏值", () => {
	const { dom, plugin } = loadPlugin();
	dom.window.localStorage.setItem("dsh-live-diff:width", "620");
	check("读回 620", plugin.storedWidth() === 620, String(plugin.storedWidth()));
	dom.window.localStorage.setItem("dsh-live-diff:width", "10");
	check("过小的值被忽略", plugin.storedWidth() === plugin.WIDTH_DEFAULT, String(plugin.storedWidth()));
	dom.window.localStorage.setItem("dsh-live-diff:width", "not-a-number");
	check("非数字被忽略", plugin.storedWidth() === plugin.WIDTH_DEFAULT, String(plugin.storedWidth()));
});

test("storage 抛错不影响浮窗", () => {
	const { dom, node, plugin } = loadPlugin();
	const start = Number.parseFloat(node.style.width);
	dom.window.localStorage.getItem = () => { throw new Error("SecurityError"); };
	dom.window.localStorage.setItem = () => { throw new Error("SecurityError"); };
	check("回退到默认宽度", plugin.storedWidth() === plugin.WIDTH_DEFAULT);
	// Must not throw: a broken preference store is not worth a broken panel.
	const strip = stripOf(node);
	strip.dispatch("pointerdown", { clientX: 500, pointerId: 1 });
	strip.dispatch("pointermove", { clientX: 450, pointerId: 1 });
	strip.dispatch("pointerup", { clientX: 450, pointerId: 1 });
	check("存不进去也不抛错", node.style.width === `${String(Math.round(start + 50))}px`, node.style.width);
});

test("双击把手恢复默认宽度", () => {
	const { node, plugin } = loadPlugin();
	const strip = stripOf(node);
	strip.dispatch("pointerdown", { clientX: 500, pointerId: 1 });
	strip.dispatch("pointermove", { clientX: 5000, pointerId: 1 });
	check("已被拖窄", node.style.width === `${String(plugin.WIDTH_MIN)}px`, node.style.width);
	strip.dispatch("dblclick", {});
	check("恢复默认", node.style.width === `${String(plugin.WIDTH_DEFAULT)}px`, node.style.width);
});

test("拖拽把手在 window 上的监听会被 disposer 移除", () => {
	// A `window` listener outlives the panel element, so removing the element does
	// not collect it. The live-reload path loads this plugin on every source
	// change, so a leak here accumulates one stale handler (and its whole closure)
	// per reload, all of them re-clamping a panel that no longer exists.
	const { dom, node } = loadPlugin();
	const resizeListeners = dom.window.listeners.get("resize");
	check("已注册 resize 监听", resizeListeners !== void 0 && resizeListeners.size === 1,
		`got ${String(resizeListeners?.size)}`);

	check("创建时暴露了 disposer", typeof node.__detachResize === "function");
	node.__detachResize();

	const after = dom.window.listeners.get("resize");
	check("disposer 移除了 resize 监听", after === void 0 || after.size === 0,
		`still ${String(after?.size)}`);
});

// ──────────────────────────────── runner ────────────────────────────────────

let failed = 0;
for (const item of cases) {
	try {
		item.fn();
		console.log(`  PASS  ${item.name}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL  ${item.name}\n        ${error.message}`);
	}
}
console.log(`\n${failed === 0 ? `全部通过（${String(cases.length)} 项）。` : `失败 ${String(failed)} 项（共 ${String(cases.length)} 项）。`}`);
process.exit(failed === 0 ? 0 : 1);
