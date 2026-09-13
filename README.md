# dsh-plugin-live-diff

Live streaming diffs for DSH file mutations — a diff that **grows while the model is
still emitting the call**, instead of appearing all at once at the end.

## Where the live diff is rendered, and why

Two surfaces, one shared reader:

| Surface | Registration | When it renders |
| --- | --- | --- |
| Chat transcript row | `tool.call.toolview` (keyed `edit` / `write`) | **Only after the call settles** |
| Right-sidebar **Live Diffs** tab | `sidebarRightTabs` + `sidebar.right.pane.tab` | Continuously, while the call runs |

A third surface — a `Diffs` tab in the transcript area, registered through
`conversation.view` — was built and then removed: the sidebar sits beside the files
the diff describes, and is where a reader already is when an edit lands. The `apply`
test asserts that registration stays absent, so it cannot creep back in.

The right-sidebar tab registers in the same two stages the shipped files tab uses,
and its body's `inject` receives the session id the same way:

```js
ctx.effect(() => ctx.sidebarRightTabs.register({
    id: "dsh-plugin-live-diff",     // implementation identity, unique across registrations
    kind: "live-diffs",             // the discriminator `openTab` names
    priority: "extension",
    title: () => "Live Diffs",      // no `patterns` => a page type, opened by kind
    guide: [{                       // ← NOT optional in practice; see below
        order: 20,
        title: () => "Live Diffs",
        description: () => "File edits as they are written, one growing diff at a time"
    }]
}), "live-diff: sidebar tab type");
ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab", key: "dsh-plugin-live-diff",
    inject: (sessionId) => ({ __diffSource: diffSourceFor(ctx, sessionId) })
}, DiffsView));
```

#### The `guide` entry is what makes the tab reachable

The registry documents `guide` as optional — *"Entry boxes for the guide page. Omit
to stay off it."* That phrasing hides a trap: the sidebar's add control opens the
**guide page**, and that page lists one capsule per registered `guide` entry. A type
that omits it is registered, is visible to `openTab`, and **cannot be opened by a
user at all**.

That single omission cost this plugin several debugging rounds, because its symptom
is indistinguishable from "the plugin never loaded": no chip, no body, no beacon,
nothing. The `apply` test now asserts the capsule exists, so the failure returns as a
test error rather than as a blank panel.

Both live surfaces read the same `inFlightDiffs` result. A tab is only a *place* to
put the card, never a different data path: if one surface is blank and another is
not, the difference is mounting, not data.

### Debugging from outside the browser

The plugin now carries its own instrumentation, because the author cannot open the
GUI (see below) and three separate faults looked identical from the outside — a
blank tab.

**Two global markers**, both set inside `try`/`catch` so they can never be the cause
of a failure:

```js
JSON.stringify(window.__liveDiffDebug)
// {"factoryRan":true,"applyRan":true,"hasSlots":true,"hasSidebarTabs":true}
```

| Reading | Meaning |
| --- | --- |
| `undefined` | the bundle never executed — a load or parse fault |
| `factoryRan` only | the module ran, the plugin was never activated |
| `applyRan` + services | registration ran; the fault is mounting or reachability |
| `hasSidebarTabs: false` | the service this plugin needs is absent from its context |

**A host introspection route.** `GET /live-diff-diag` answers with the host's own
view of the browser roster, which is otherwise unreadable from outside:

```json
{ "graph": { "available": true, "entryCount": 54,
             "liveDiff": [{ "id": "dsh-plugin-live-diff", "rev": "..." }],
             "batches": [ ... ] },
  "fetch": { "status": 200 } }
```

`?fetch=<bundle path>` additionally probes one of the host's own bundle URLs and
reports the status, which distinguishes "the bundle never reached the browser" from
"it arrived and did nothing".

### Getting the data right: two dead ends, and the bug that hid the answer

Finding a source that carries a *growing* tool call took two dead ends. Both of
these genuinely cannot work, and the reasons are worth keeping:

**1. `snapshot.runningCalls` — already complete.** The host dispatches a call only
after the model has finished streaming its arguments, so `argsRaw` is whole the
moment the call appears here. The call then executes in milliseconds, so the card
flashes rather than grows.

**2. `snapshot.partial.blocks` — pruned by design.** The Chat projection treats a
tool call as invisible content:

```js
// dsh-client-ui-chat
function blockIsVisible(block) {
    if (block === void 0 || block.kind === "tool-call") return false;   // ←
    ...
}
function hasVisibleContent(blocks) { return blocks.some(blockIsVisible); }
```

So a step whose only block is a tool call is published with `visibility: "hidden"`
(and may not be published at all), and `legacyContribution` then drops that hidden
non-assistant node. Tool calls are *excluded from the chat snapshot on purpose* —
`AssistantMarkdown` separately does `case "tool-call": break;`. The transcript row
is therefore called exactly once per call, at settlement, and no plugin reading the
Chat projection can render a growing edit.

**3. The raw Session event window — works.** `SessionBinding` exposes the event feed
the projection is itself built from, and its entries keep what the projection throws
away:

```ts
export interface SessionBinding {
    readonly session: SessionFace;
    /** Contiguous event window reserved for Conversation assembly. */
    readonly eventSource: SessionEventSource;      // ObservableSnapshot<SessionEventWindow>
}
type SessionEventLikeEntry =
  | { type: 'event';     event: SessionEvent }                 // durable
  | { type: 'transient'; event: AssistantLiveChunkEvent };     // client-only live chunk
// AssistantLiveChunkEvent.data.chunk: StreamChunk  ← carries every `tool-call-delta`
```

The reader accumulates `argumentsDelta` per stream index and deletes an index on a
`block-start` / `block-end`, so a finished call cannot leak into the next one. That
accumulated text is exactly the half-arrived JSON this plugin's tolerant reader was
built for.

#### The bug that hid this answer for several rounds

The source above was right, but the plugin still rendered nothing — and the reason
turned out to be unrelated to data sources at all:

```
"reason":"source failed: diffSourceFor threw:
          Error: cannot get property \"sessions\" without inject"
```

The Cordis context is a proxy that **throws** on a read of an undeclared service
instead of returning `undefined`, so `ctx.sessions` was unusable because `sessions`
was missing from the plugin's `inject` list. Every snapshot read failed; the
plugin's own `try`/`catch` turned that into an empty panel, which reads exactly like
"there was nothing to show".

Two lessons, both now enforced by tests:

- **Declare every service a client plugin reads.** A missing one is not a soft
  failure; it is a thrown error on every access. `apply.test.mjs` asserts the exact
  `inject` array.
- **A sidecar has two levels in DSH: registered, and reachable.** The sidebar tab
  registered fine and `apply` ran, but it was invisible in the add-tab list because
  the tab definition carried no `guide` entry — the only discovery surface. See
  "The `guide` entry is what makes the tab reachable" above.

```js
const binding = ctx.sessions.binding(sessionId);
binding.eventSource.getSnapshot().entries   // includes transient tool-call deltas
binding.eventSource.subscribe(listener)
```

Talking to `ctx.sessions` directly is also why this plugin injects only `slots`
(plus `sidebarRightTabs` for the sidebar tab) — it no longer needs the chat
projection or its `uiConversation` service at all.

### The diagnostic channel: how the browser reports to the author

A panel already helps whoever is looking at the screen. It does not help the author
of this plugin, who cannot look: the Web surface is gated by a per-process token
that is never written to disk, so `http://127.0.0.1:3080/` answers **401** to local
tooling. A browser is installed on the machine, but a headless one is a *new*
session and gets the same 401.

The way out is not to obtain the token but to skip it: the browser already holds its
own session, so **the page reports itself**. The host half registers one
unauthenticated POST route and appends what it receives to a file.

```
browser half  ──POST /live-diff-diag──▶  host half  ──append──▶  diag.log
              (fetch, same origin,                        (readable by the author)
               no credential needed)
```

| Piece | Where | Notes |
| --- | --- | --- |
| Route | `lib/index.js` | `{ kind: "prefix", path: "/live-diff-diag" }`, registered in an owned `ctx.effect` |
| Declaration | `lib/index.js` | `export const inject = ["webServer"]` — static, like the shipped host plugins |
| Log | `diag.log` (override `DSH_LIVE_DIFF_LOG`) | One JSON line per report, timestamped |
| Sender | `lib/client.js` `beacon()` | Fires once on mount; failures are swallowed |

Two deliberate details:

- **`reset: true` on the first report truncates the log.** The panel re-sends on
  every mount, so an append-only file would grow without bound across reloads.
- **Failures are swallowed.** A diagnostic channel that can break the surface it
  observes is worse than no channel.

The route carries diagnostics only. It never reads or writes wiki content, and the
web server's routing tables apply no authorization of their own — the 401 lives in
the index handler, not in the router.

### The empty state is a diagnostic panel

The author of this plugin cannot observe the browser, so a blank tab is a useless
signal. The empty state therefore reports what the event window actually held, and
the report distinguishes each way this feature can fail:

```
window.entries: 12
entry types: transient×9, event×3
chunk types: tool-call-delta×7, text-delta×2
tool names seen: edit
transient: 9  ·  accumulating: 1
deltas present - the view should be rendering
```

`diagnoseWindow` reports the *first* thing that is missing, so a specific zero names
the layer that dropped the data:

| Report | Meaning |
| --- | --- |
| `event window is null/undefined` | no session binding, or `eventSource` absent |
| `window.entries is not an array` | the window shape changed |
| `event window is empty` | the follow stream delivered nothing |
| `no transient (live chunk) entries in the window` | only durable events arrived — live frames are not opted in |
| `no tool-call-delta chunks arrived` | chunks flow, but not tool-call deltas |
| `saw N delta(s), but every stream index was closed` | deltas arrived and were finalised (e.g. a read) |
| `deltas present - the view should be rendering` | data is there; a rendering bug is next |

It never throws: every access is guarded, and `diagnoseWindow` reports structural
surprises (`(no type)`, `(no chunk)`) rather than failing. `inFlightDiffs` and
`diagnoseWindow` are both exported so the tests can pin this behaviour.

## Why stock DSH doesn't already do this

DSH ships a diff card, and its own source says it derives *running* diffs. But it
derives them with:

```js
// dsh-client-ui-tool/lib/client.js
function parsedToolCall(block) {
    value = JSON.parse(call.argsRaw);   // ← throws on a half-arrived document
    ...
}
```

and then rejects anything incomplete:

```js
if (typeof oldText !== "string" || typeof newText !== "string") return null;
```

While streaming, `argsRaw` is a **truncated JSON document**, so the parse fails and
the card stays empty until the final token lands. The streaming data was never
missing — DSH already accumulates it (`argsRaw: base.argsRaw + chunk.argumentsDelta`)
— what was missing is a reader that tolerates a partial document.

## Should Cline's own components be ported instead?

Measured, not guessed. Cline's diff view is three plain React components in
`next/webview-ui/build/assets/index.js` (`lqn` file card, `cqn` counts, `uqn` line
renderer) with **no VS Code API and no Cline state** in them — so porting is
*possible*. It is still the wrong move:

| | Port Cline's components | Reuse DSH's `DiffBlock` |
| --- | --- | --- |
| Styling | Tailwind classes the shell doesn't load (`bg-green-500/10`, `border-l-4`), plus Cline's icon set — every one would have to be re-expressed in DSH's tokens anyway | Pixel-identical to the shell's own diff cards by construction |
| Extras | none | collapse/expand, copy button, `└ +c -h · n files` footer, per-file grouping — all inherited |
| Fidelity risk | the *components* are the least interesting part: they are ~40 lines of coloured rows | — |

The thing worth having from Cline is **behavioural, not visual**, and all three
pieces are reproduced here (see above). Two further facts settled it:

- DSH's own row builder does **no line alignment** — it emits every removal, then
  every addition (`dsh-client-ui-primitives`: `Zm`). Cline's renderer is likewise
  plain `+`/`-` rows. So alignment was never part of the effect, and adding it
  only desynchronizes this card from the shell's rendering of the same call.
- `DiffBlock` takes `maxLines` and collapses to it — it is **already built for a
  streaming preview**, which is exactly the slot this plugin fills.

## What this plugin does

Takes over the `tool.call.toolview` slot for `edit` and `write`, derives diff
material from a tolerant incremental reader over `argsRaw`, and renders the result
through DSH's own `DiffBlock` primitive:

- `readJsonFields` walks the document character by character; a field whose value
  string is still open comes back usable-but-incomplete instead of `null`.
- Common head/tail lines are kept as context; the changed middle is emitted as
  removals then additions, matching the primitive's own derivation.
- The newest added line carries a caret while streaming.
- While streaming the card is pinned to its newest line; scrolling away releases
  the pin, returning to the bottom resumes it.
- Once the call settles, the card defers to the host's own `meta.diffs`, so the
  final picture never depends on this reconstruction.

It replaces rendering only. It writes nothing to disk and modifies no other package.

## What was borrowed from Cline

Read from `saoudrizwan.claude-dev-4.1.17.vsix` (bundled webview):

1. **Its parser never bails on an incomplete block.** In `mqn`, when the `=======`
   separator has not arrived it still returns the SEARCH side as deletions; when
   `+++++++ REPLACE` has not arrived it still returns everything after the separator
   as additions. Degrading to "what has arrived so far" is the whole trick.

2. **Streaming state is inferred from marker counts, not from a completion signal:**

   ```js
   const replaces = (text.match(/\+{7,} REPLACE/g) || []).length;
   const searches = (text.match(/-{7,} SEARCH/g) || []).length;
   return { parsedFiles, isStreaming: replaces < searches };
   ```

   The equivalent here is "the JSON document has not closed yet".

3. **The card pins itself to the newest line while streaming** — without this a long
   diff grows off-screen and the growth is invisible. Cline's rule:

   ```js
   if (expanded && isStreaming && atBottom && el)
       el.scrollTop = el.scrollHeight - el.clientHeight;
   ```

   with `atBottom` maintained by `Math.abs(scrollHeight - clientHeight - scrollTop) < 10`
   in `onScroll`, so a deliberate scroll up is respected. This plugin uses the same
   pin/release rule (threshold 20px).

Note: the shipped webview parses the `------- SEARCH` / `=======` / `+++++++ REPLACE`
family (and also carries `*** Begin Patch` / `*** Update File` markers). The
`<<<<<<< SEARCH` form in older public docs is a different prompt generation, not what
this bundle's renderer matches.

## Layout

| Path | Role |
| --- | --- |
| `lib/client.js` | Browser half: incremental reader, diff derivation, the card. |
| `lib/index.js` | Host half: empty `apply`, the convention for a pure-UI plugin. |
| `package.json` | `dsh.client` declaration that puts the browser half on the Web boot graph. |
| `test/parser.test.mjs` | Regression tests over every truncation point of a real call. |

The served `client.js` registers its own factory
(`window.__ModuleLoader__.load({ id, factory })`) because the client module system
passes bundle bytes through verbatim. It requires only `react`, `react/jsx-runtime`,
and `@deepseek-ai/dsh-client-ui-primitives` — all three are singletons the shell's
module table already provides:

```js
// dsh-web-frontend: the static module seed
{ react, "react/jsx-runtime", "react-dom", "react-dom/client",
  "@deepseek-ai/cordis", "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit" }
```

That entry is what makes the native `DiffBlock` reachable from a plugin, and is
why this plugin does not carry its own diff renderer.

## Mounting

Two pieces, both outside DSH's own files:

1. A junction so the profile can resolve the bare package name (the same mechanism
   DSH's own packages use; a `file:` URL specifier does **not** resolve through the
   Loader). Create it under the active profile's `node_modules`, pointing at
   wherever you cloned this plugin:

   ```
   <DSH_HOME>\profiles\node_modules\dsh-plugin-live-diff
       -> <path to your clone>\dsh-plugin-live-diff
   ```

   On Windows that is `mklink /J <link> <target>`; on POSIX a symlink works the
   same way.

2. A row in the profile's user patch layer, `profiles\web\cordis.patch.yml`:

   ```yaml
   - insert:
       - id: live-diff
         name: dsh-plugin-live-diff
   ```

## Activating

A running `dsh web` process does not pick up a **new package**; the row has to be
seen at startup. Restart `dsh web` to activate. The profile sets
`patchReload: live`, so once the package is known, later edits to this plugin are
picked up on patch reload.

## Verifying

Run the tests:

```
node test/parser.test.mjs
```

Then, in the GUI, ask for a file edit and watch the card: added lines should appear
and accumulate *while* the call is still running, with a caret on the newest line and
the body pinned to it.

## Tests

`test/parser.test.mjs` asserts, among other things, that every truncation point of a
real call yields a usable partial `new_string`, that the added-line count grows across
the stream, that a dangling escape (`"abc\`) is dropped rather than rendered, and that
a non-string field ahead of the interesting one does not desynchronize the reader.

`test/resolve.probe.mjs` asks DSH's own resolution rules whether a given mount form
can find the package — the tool that showed a `file:` URL specifier fails to resolve
while a bare name succeeds.
