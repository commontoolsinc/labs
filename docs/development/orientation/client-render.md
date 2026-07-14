# The client and rendering stack: `html`, `ui`, `iframe-sandbox`, `shell`

This is how a reactive cell value becomes pixels. There are four packages in the
chain, plus two small support packages (`lib-shell`, `felt`). They layer like
this: `html` is a custom virtual-DOM layer and JSX runtime; `ui` is the
`cf-*` web-component library built on Lit; `iframe-sandbox` runs untrusted
pattern UI in an iframe; `shell` is the single-page application that ties it
together.

---

## How the packages relate

```mermaid
flowchart TB
    shell["shell — the single-page app (Lit)"]
    ui["ui — cf-* web components (Lit)"]
    iframe["iframe-sandbox — untrusted UI in an iframe"]
    html["html — VDOM + JSX runtime"]
    libshell["lib-shell — runtime lifecycle, credentials"]
    felt["felt — esbuild bundler (build-time only)"]
    rtc["runtime-client"]
    runner["runner"]

    shell --> ui
    shell --> libshell
    shell --> rtc
    ui --> html
    ui --> rtc
    iframe --> runner
    html --> runner
    html --> rtc
    libshell --> rtc
    felt -. "bundles" .-> shell
```

The repository sets `jsxImportSource` to `@commonfabric/html`, so every pattern
`.tsx` file compiles its JSX into `h()` calls in the `html` package. That is why
`html` is foundational to the whole client even though it is small.

---

## The render pipeline: cell to DOM, on a worker

There are two render paths in `html`. The live one runs the reconciler **in a
Web Worker**, where cell values are synchronous, and ships DOM-mutation
operations to the main thread over a message channel. (A legacy main-thread
renderer still exists in `render.ts`, selected by a flag.) Understanding the
worker path is understanding the client.

```mermaid
flowchart TB
    uicell["a pattern's [UI] Cell"]
    render["render(parent, cellHandle)"]
    vdr["VDomRenderer (main thread)"]
    mount["session.mount over the runtime connection"]
    recon["WorkerReconciler (worker thread)"]
    sink["subscribes via cell.sink(), diffs, keys children"]
    ops["emits a batch of VDomOps"]
    applic["DomApplicator (main thread) mutates real DOM"]
    dom["DOM / cf-* elements"]
    evt["DOM event → serialized → handlerId → back to worker"]

    uicell --> render --> vdr --> mount --> recon
    recon --> sink --> ops --> applic --> dom
    dom --> evt --> recon
```

Two facts that catch people out:

- **Cell-backed VNodes are plain serializable JSON.** Event handlers cross the
  worker/main boundary as integer `handlerId`s, not closures (the reconciler will
  accept a raw function prop and register it to a `handlerId`, so a VNode can hold
  a function transiently, but nothing function-valued crosses the wire). This is
  why the reconciler can live in a worker at all.
- **The reconciler enforces CFC render policy.** It can replace blocked content
  with a `cf-cfc-blocked` placeholder. If UI content "disappears," suspect the
  flow-control policy before suspecting a render bug.

On the component side, a `cf-*` element binds to a cell through a
`CellController` (a Lit reactive controller). The controller subscribes via the
main-thread `CellHandle.subscribe()` and calls `requestUpdate()` on change;
writing back calls `cellHandle.set(v)`, which sends a `CellSet` request over IPC
to the worker, and the worker applies it in a transaction
(`runtime.edit()` → `withTx(tx).set(v)` → `tx.commit()`). Debounce and blur
timing for inputs live on the controller. The runtime and the current space
arrive through Lit context (`runtimeContext`, `spaceContext`).

---

## The iframe sandbox protocol

Untrusted pattern UI runs inside a double-nested iframe under a strict
Content-Security-Policy. The guest never touches the host DOM or the host's
reactive data directly. Everything goes through a message protocol across three
frames: the host (the shell), an outer frame, and the inner guest document.

```mermaid
sequenceDiagram
    participant Host as Host (shell)
    participant Outer as Outer frame
    participant Guest as Inner guest

    Outer->>Host: Ready
    Host->>Outer: Init { id }
    Host->>Outer: LoadDocument { html }
    Outer->>Guest: set srcdoc
    Outer->>Host: Load
    Note over Host,Guest: handshake complete, now bidirectional

    Guest->>Host: Subscribe / Read / Write / LLMRequest / Perform
    Host->>Guest: Update [key, value] / Effect / LLMResponse
```

The outer frame validates the message origin against the known host origin. The
host side registers a single `IframeContextHandler` whose methods
(`read`/`write`/`subscribe`/`onLLMRequest`/`onPerform`) wire guest requests to
the real reactive runtime. The README documents the deliberately accepted
security gaps (for example, a hardcoded-CDN allowlist and anchors with
`target=_blank` are both exfiltration vectors, and `document.baseURI` leaks the
parent URL into the iframe).

---

## The shell single-page app

`shell` boots a Lit component tree, authenticates an identity, builds a
`RuntimeClient` running in a Web Worker, and renders pieces with `cf-render`.
Navigation is URL-driven with no router library: a small set of pure functions
maps URLs to an `AppView` and back, and all state changes go through immutable
`Command` objects.

```mermaid
flowchart TB
    html_["public/index.html mounts <x-root-view>"]
    root["RootView"]
    identity["restore Identity from KeyStore"]
    ri["RuntimeInternals (lib-shell) builds RuntimeClient over a Web Worker"]
    toolshed["toolshed (over the worker's memory WebSocket)"]
    appview["AppView tree: Header, Body → cf-piece / cf-render"]
    nav["URL ⟷ AppView mapping, popstate, navigate(AppView)"]

    html_ --> root --> identity --> ri --> toolshed
    root --> appview
    appview <--> nav
```

The view files are large (`SchedulerGraphView` and `DebuggerView` are each over
3000 lines) because the shell ships its own debugging and scheduler-visualization
tools.

---

## Technical debt and sharp edges

- **Two of the four repo cycles live here.** `ui ↔ shell` (four `cf-*`
  components import navigation helpers from `@commonfabric/shell/shared`, and the
  shell imports `cf-*` classes and Lit contexts back) and `runner ↔ html` (the
  runtime's builder imports `h()` from `html`, and `html` imports cell helpers
  back from `runner`). See the [dependency page](dependency-graph.md).
- **`cf-markdown` renders unsanitized HTML.** It uses `unsafeHTML` without
  sanitization — a cross-site-scripting risk if it is ever fed untrusted
  markdown. Worth knowing before you reuse it.
- **There are two render paths.** The worker-thread reconciler is live; the
  main-thread `renderNode`/`effect` path in `render.ts` is legacy but still
  present and still selectable by a flag.
- **`cf-*` components self-register on import.** Importing the module calls
  `customElements.define`. There is no separate registration step; if a
  component is "missing," check that its module was imported.
- **`v1` is gone but the `v2/` directory name remains.** `ui/src/index.ts` is
  just `export * from "./v2/index.ts"`. Everything is v2; the directory name is
  flagged for cleanup.
- **Several shell views are disabled pending a worker refactor.** `ACLView` and
  parts of `QuickJumpView` carry `TODO(runtime-worker-refactor)` and are
  currently inert.
- **The biggest files to budget for:** `html/src/jsx.d.ts` (5458 lines, but it
  is generated type declarations), `html/src/worker/reconciler.ts` (3862), and
  the shell debug views (~3000 each).

---

## Public surfaces

- **`html`** — `.` (`h`, a few UI helpers), plus `./client`, `./jsx-runtime`,
  `./jsx-dev-runtime`, `./worker`, `./main`, `./vdom-ops`, `./mock-doc`,
  `./utils`, `./debug`.
- **`ui`** — `.` → `v2/index.ts` (the `BaseElement`, `DebugController`, the Lit
  contexts `runtimeContext`/`spaceContext`, the style tokens, and all `cf-*`
  classes, which self-register). Note `CellController` is *not* re-exported from
  the barrel — components import it by relative path from `v2/core/`.
- **`iframe-sandbox`** — `.` exports `CommonIframeSandboxElement`, the `IPC`
  namespace, and `setIframeContextHandler`.
- **`shell`** — the app entry is `src/index.ts`; the library export is
  `./shared` (app state and navigation).
- **`lib-shell`** — `.`, `./credentials`, `./runtime`. **`felt`** — `mod.ts`
  and `./cli`.
