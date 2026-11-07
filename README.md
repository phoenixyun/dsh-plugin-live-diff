# dsh-plugin-live-diff

Live streaming diffs for [DSH](https://github.com/deepseek-ai) file edits — a diff
that **grows while the model is still emitting the call**, instead of appearing all
at once when the tool call settles. Since 0.2.0 the same stream is also painted
**behind the whole app** as a frosted-glass window backdrop.

**[中文说明 →](README.zh-CN.md)**

```
┌ Live Diffs ─────────────────────── 1 in flight ─┐
│ solar/viewport.py                     python    │
│ 403  + def zoom_by(self, steps, anchor_x=None): │
│ 404  +     world_x, world_y = self.to_world(…)  │
│ 405  +     self.zoom = clamp_zoom(…)            │
│ 406  +     self.offset_x = anchor_x - …    ▌    │
└─────────────────────────────────────────────────┘
```

## Demo

[26-second demo on Bilibili — "deepseek v4.1 flash 太强大了 50元手搓文件变更实时预览"](https://www.bilibili.com/video/BV1N6YB6KESy/)\
*Live Diffs for DSH — 边写边看的编辑过程*

## The problem

DSH already ships a diff card, and it already accumulates the streaming data — the
host does `argsRaw: base.argsRaw + chunk.argumentsDelta` for exactly this reason.
What it lacks is a reader that tolerates a **half-arrived** argument string:

```js
// dsh-client-ui-tool
value = JSON.parse(call.argsRaw);          // throws on a truncated document
if (typeof oldText !== "string" || typeof newText !== "string") return null;
```

While a call streams, `argsRaw` is a truncated JSON document, so the parse fails and
the card stays empty until the final token lands. This plugin supplies the tolerant
reader, and a surface to put the result on.

## What it does

- **Floating panel** (`Live Diffs`) that patches the diff in place as characters
  arrive. Width is draggable from its left edge and remembered across reloads.
- **Chat transcript card** for `edit` / `write`, rendered through DSH's own
  `DiffBlock` primitive so it matches the shell's diff cards by construction.
- **Tolerant reader** over partial JSON: a field whose value string is still open
  comes back usable-but-incomplete instead of `null`.
- **Partial syntax colouring** with per-language profiles (Python, JS/TS, JSON,
  YAML, shell, Markdown).
- The panel keeps the newest line in view while streaming, and **stays on screen
  after the edit finishes** rather than blanking the moment `entries` empties.
- **A finished edit is not re-rendered row by row** — the DOM is patched
  incrementally, so a line's fade-in plays once instead of restarting on every poll.

## The window backdrop

The same reading is painted behind the entire app. The shell's large opaque
surfaces are **measured, not matched by class name** (viewport area + computed
background): surfaces covering ≥85% of the window are cleared so the backdrop can
show through, and opaque panels ≥0.1% become frosted glass. Nested surfaces are
skipped once an ancestor is glassed — two stacked translucent layers turn
"frosted" into "milky".

- **Liquid glass**: in browsers that accept it, `backdrop-filter: url(#dshld-lg-lens)`
  refracts the diff behind big panels through an SVG displacement filter; elsewhere
  it degrades to plain blur.
- **Pointer light**: a soft sheen follows the cursor across the glass; its strength
  and radius are tunable.
- **White foregrounds**: over glass the shell's grey text loses contrast, so text is
  lifted to white by default — and its opacity is a slider.
- **Titlebar untouched**: the window's titlebar keeps the stock look; only the app
  area becomes glass.
- **Live-tunable**: the backdrop stylesheet is *served* from disk rather than baked
  into the bundle, and the browser re-fetches it every 1.5 s. Edits to `style.css`
  land in about a second, with no restart and no rebuild.

### Appearance tuner

A round button at the bottom-right corner opens a 264 px panel with **9 sliders and
2 switches** (中文界面):

| Control | Range | What it changes |
| --- | --- | --- |
| 面板不透明度 | 0.05 – 0.9 | one opacity for every glass band |
| 玻璃模糊 | 0 – 24 px | backdrop blur radius |
| 折射强度 | 0 – 40 | liquid-glass displacement scale |
| 高光强度 | 0 – 1 | pointer-light sheen opacity |
| 光斑大小 | 80 – 900 px | sheen radius |
| 文字不透明度 | 0.3 – 1 | foreground text alpha (white-text mode) |
| 代码层亮度 | 0.2 – 1 | opacity of the diff painted behind the app |
| 代码字号 | 12 – 28 px | size of that backdrop code |
| 背景压暗 | 0 – 1 | veil over the backdrop |
| 界面文字转白色 | on/off | lift every foreground to white |
| 液态玻璃（折射） | on/off | use the SVG refraction filter |

Values persist in `localStorage` (`dshld.tuner.v2`); the panel's reset button puts
every control back to its default.

### Escape hatches

- `/* dshld-off */` anywhere in the served `style.css` turns the whole effect off
  live; deleting the marker turns it back on. Everything the plugin does to the
  shell is keyed on one attribute (`data-dshld-backdrop`), so dropping it is a
  complete revert.
- `?dshld-demo=1` paints a synthetic, steadily growing diff so the look can be
  worked on without waiting for a model edit.
- `window.__dshldDebug.state()` / `.probe()` / `.scan()` / `.demo()` in the browser
  console report what the backdrop can and cannot see.

It replaces rendering only. It writes nothing to your files and modifies no other
package.

## Requirements

Built and verified against **DSH `0.1.5-rc.1`** and the DSH desktop app on
**`0.2.1-rc.5`**, Windows (`cordis` 4.0.2).

This plugin talks to DSH through its **internal** client surfaces, not a published
extension API. Nothing here is versioned or guaranteed:

| What it relies on | Used for |
| --- | --- |
| `ctx.sessions` client service | reading the session event window — the only source carrying streaming `tool-call-delta` chunks |
| `ctx.slots` / `ctx.sidebarRightTabs` | registering the transcript card and the sidebar tab type |
| `@deepseek-ai/dsh-client-ui-primitives` (`DiffBlock`) | the chat transcript card |
| `ctx.webServer` + `ctx.clientModules` | the host-side `/live-diff-diag` diagnostic route and the served stylesheet |
| keyed `tool.call.toolview` entries for `edit` / `write` | **replacing** the shipped `FileMutationRow` for those two tools |

That last row is the sharpest edge: a keyed registration replaces the shipped row,
so this plugin deliberately overrides a component DSH ships. A DSH upgrade that
renames the tool keys, changes the `toolview` contract, or restructures the session
event window will break it — most likely by showing an empty panel rather than by
raising an error.

If you are on a different DSH build, try it and read the diagnostics (below); the
panel reports what it can and cannot see rather than failing silently.

## Install

The package ships its own bundle patch (`cordis.patch.yml`) and declares
`dsh.bundle.patch`, so it installs and mounts in one step — no junction, no
hand-written patch row.

**From the plugin market:** open **Settings → Plugins → Plugin Market** (插件 →
插件市场), search for `Live Diffs` / `dsh-plugin-live-diff`, and install. Most
client plugins work after a page refresh.

**From the command line** (plain `dsh web` / custom profiles):

```bash
dsh plugin --profile <profile> add github:phoenixyun/dsh-plugin-live-diff
```

**DSH Desktop:** use the in-app **Settings → Plugins** page. The desktop app keeps
its own plugin manager and its profile is not the `web` profile, so a CLI install
does not reach it.

A running process does not pick up a new host package; the row has to be seen at
startup, so restart after installing (the market offers a one-click restart when it
is needed). After that, edits to the plugin are picked up live (`patchReload: live`),
but **client-bundle changes still need a restart plus a hard refresh**
(`Ctrl+Shift+R`) — a plain refresh has served a stale bundle.

### Migrating from a hand install

Earlier versions were installed by hand: a junction in the profile's `node_modules`
plus an `id: live-diff` row in the profile's `cordis.patch.yml`. Remove that manual
row (and the junction) before installing the bundled version — leaving both would
load the plugin twice.

### Development install (link a checkout)

Two pieces, both outside DSH's own files.

1. Make the package resolvable under the active profile's `node_modules`. A
   junction/symlink, not a `file:` specifier — the Loader does not resolve those.

   ```bat
   :: Windows
   mklink /J "%DSH_HOME%\profiles\<profile>\node_modules\dsh-plugin-live-diff" "C:\path\to\dsh-plugin-live-diff"
   ```

   ```bash
   # POSIX
   ln -s /path/to/dsh-plugin-live-diff "$DSH_HOME/profiles/<profile>/node_modules/dsh-plugin-live-diff"
   ```

2. Add the bundle row to `profiles/<profile>/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: dsh-plugin-live-diff
         name: dsh-plugin-live-diff
   ```

3. Restart DSH.

## Verify it works

```bash
npm test
```

That runs six suites and prints one line each:

| Suite | What it covers |
| --- | --- |
| `parser.test.mjs` | the tolerant reader, truncating a real tool call at 25 points |
| `apply.test.mjs` | registration, plus layout and manifest guards |
| `host.test.mjs` | both host routes end to end, without a server |
| `highlight.test.mjs` | language detection and tokenising |
| `overlay.test.mjs` | incremental DOM patching, resize, scroll, the finished state |
| `audit.mjs` | static audit of the bundle: dead helpers, duplicate declarations, `require()` specifiers missing from `dsh.client.inject` |

All six exit 0. Then make the model edit a file and watch the panel. If it stays
empty, the panel's own diagnostics footer and the host log say why — see below.

## Diagnostics

The author cannot open your browser, so the panel reports on itself. It POSTs a
one-line reading to `/live-diff-diag` on every change, and the host half appends it
to a log file:

- default: `<system temp>/dsh-plugin-live-diff/diag.log`
- override: the `DSH_LIVE_DIFF_LOG` environment variable

Each line carries the event-window counters and a compact event sequence:

```json
{"surface":"overlay","entryCount":1,"deltaCount":269,"accumulating":1,
 "sequence":"b0) t0)x269","toolNames":["write"],"reason":"deltas present"}
```

`sequence` collapses runs of the same chunk type per stream index, which is how the
arrival order was confirmed: `block-start` always precedes that index's deltas.

**The panel does not overwrite `document.title`.** It used to; a title is only
visible while its tab is inactive, which is the one moment nobody is watching a live
diff.

## Design notes

The reasoning behind the non-obvious decisions — why the panel is plain DOM rather
than React, why the sidebar was abandoned, why Cline's components were not ported,
the measured transport granularity, the layout traps that shipped twice, and the
"measure surfaces, never match class names" rule behind the backdrop — is in
[`docs/DESIGN.md`](docs/DESIGN.md).

## Credits

Behaviour (not code) was informed by [Cline](https://github.com/cline/cline)'s
streaming diff: degrade to what has arrived rather than bailing, infer "still
streaming" from the document not being closed, and pin the view to the newest line.
Details in the design notes. Cline is Apache-2.0; no Cline code is included here.

## License

MIT
