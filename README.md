# dsh-plugin-live-diff

Live streaming diffs for [DSH](https://github.com/deepseek-ai) file edits — a diff
that **grows while the model is still emitting the call**, instead of appearing all
at once when the tool call settles.

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

It replaces rendering only. It writes nothing to your files and modifies no other
package.

## Install

Two pieces, both outside DSH's own files.

**1. Make the package resolvable** under the active profile's `node_modules`.
A junction/symlink, not a `file:` specifier — the Loader does not resolve those.

```bat
:: Windows
mklink /J "%DSH_HOME%\profiles\node_modules\dsh-plugin-live-diff" "C:\path\to\dsh-plugin-live-diff"
```

```bash
# POSIX
ln -s /path/to/dsh-plugin-live-diff "$DSH_HOME/profiles/node_modules/dsh-plugin-live-diff"
```

**2. Add a row** to the profile's user patch layer, `profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: live-diff
      name: dsh-plugin-live-diff
```

**3. Restart `dsh web`.** A running process does not pick up a new package; the row
has to be seen at startup. After that, edits to the plugin are picked up live
(`patchReload: live`), but **client-bundle changes still need a restart plus a hard
refresh** (`Ctrl+Shift+R`) — a plain refresh has served a stale bundle.

## Verify it works

```bash
node test/parser.test.mjs      # tolerant reader over every truncation point
node test/overlay.test.mjs     # incremental DOM patching, resize handle
node test/apply.test.mjs       # registration, plus CSS/layout guards
node test/highlight.test.mjs   # language detection and tokenising
node test/host.test.mjs        # host-side diagnostics route
```

All five exit 0.

Then make the model edit a file and watch the panel. If it stays empty, the panel's
own diagnostics footer and the host log say why — see below.

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
the measured transport granularity, and the layout traps that shipped twice — is in
[`docs/DESIGN.md`](docs/DESIGN.md).

## Credits

Behaviour (not code) was informed by [Cline](https://github.com/cline/cline)'s
streaming diff: degrade to what has arrived rather than bailing, infer "still
streaming" from the document not being closed, and pin the view to the newest line.
Details in the design notes. Cline is Apache-2.0; no Cline code is included here.

## License

MIT
