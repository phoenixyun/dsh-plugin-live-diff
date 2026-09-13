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
	const element = {
		nodeType: 1,
		tagName: String(tag).toUpperCase(),
		childNodes: [],
		parentNode: null,
		style: { cssText: "", display: "", width: "" },
		className: "",
		title: "",
		id: "",
		textContent: "",
		innerHTML: "",
		listeners: {}
	};
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
	element.dispatch = (type, event = {}) => {
		for (const handler of element.listeners[type] ?? []) {
			handler({ target: element, preventDefault() {}, ...event });
		}
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
			addEventListener: () => {}
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

/** The left-edge resize strip. */
function stripOf(node) {
	return node.children.find((child) => child.className === "rz");
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
	const { plugin, node } = loadPlugin();
	const view = plugin.buildDiffView({
		path: "/a/b.py", oldText: null, newText: "x = 1", streaming: true
	});
	plugin.patchOverlayList(node.__list, [view]);
	const text = rowsOf(node)[0].children[2];
	const painted = text.__text;
	plugin.patchOverlayList(node.__list, [view]);
	check("文本节点未被重写",
		rowsOf(node)[0].children[2] === text && text.__text === painted);
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
	// getBoundingClientRect is a fixed 400 in the shim, so the starting width is
	// recorded from there; dragging left by 100 must widen by 100.
	strip.dispatch("pointerdown", { clientX: 500, pointerId: 1 });
	strip.dispatch("pointermove", { clientX: 400, pointerId: 1 });
	check("左拖后变宽 100px", node.style.width === "500px", node.style.width);
	strip.dispatch("pointermove", { clientX: 600, pointerId: 1 });
	check("右拖后变窄 100px", node.style.width === "300px", node.style.width);
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

test("拖动期间显示宽度读数，松手后写入存储", () => {
	const { dom, node } = loadPlugin();
	const strip = stripOf(node);
	const chip = node.__widthChip;
	check("初始隐藏", chip.style.display !== "inline");
	strip.dispatch("pointerdown", { clientX: 500, pointerId: 1 });
	check("拖动中显示", chip.style.display === "inline", chip.style.display);
	strip.dispatch("pointermove", { clientX: 450, pointerId: 1 });
	check("读数已更新", chip.textContent.endsWith("px"), chip.textContent);
	check("body 进入拖拽态", dom.body.classList.contains("dshld-resizing"));
	strip.dispatch("pointerup", { clientX: 450, pointerId: 1 });
	check("松手后隐藏", chip.style.display === "none", chip.style.display);
	check("宽度已持久化", dom.store.get("dsh-live-diff:width") === "450",
		String(dom.store.get("dsh-live-diff:width")));
	check("body 类已清理", dom.body.classList.contains("dshld-resizing") === false);
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
	dom.window.localStorage.getItem = () => { throw new Error("SecurityError"); };
	dom.window.localStorage.setItem = () => { throw new Error("SecurityError"); };
	check("回退到默认宽度", plugin.storedWidth() === plugin.WIDTH_DEFAULT);
	// Must not throw: a broken preference store is not worth a broken panel.
	const strip = stripOf(node);
	strip.dispatch("pointerdown", { clientX: 500, pointerId: 1 });
	strip.dispatch("pointermove", { clientX: 450, pointerId: 1 });
	strip.dispatch("pointerup", { clientX: 450, pointerId: 1 });
	check("存不进去也不抛错", node.style.width === "450px", node.style.width);
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
