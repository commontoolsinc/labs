# Pattern Debugging Guide

Quick error reference and debugging workflows. For detailed explanations, see linked docs.

## Quick Error Reference

| Error Message | Cause | Fix |
|---------------|-------|-----|
| "Property 'set' does not exist" | Missing `Writable<>` in signature | Add `Writable<T>` for write access ([@writeable](../../common/concepts/types-and-schemas/writable.md)) |
| "X.get is not a function" | Calling `.get()` on computed/lift result | Access directly without `.get()` - only `Writable<>` has `.get()` ([gotchas/get-is-not-a-function](gotchas/get-is-not-a-function.md)) |
| "X.filter is not a function" | Value isn't an array (yet) | Check `Default<>`, don't assume `.get()` is the fix ([gotchas/filter-map-find-not-a-function](gotchas/filter-map-find-not-a-function.md)) |
| Console storm of "Cannot read properties of undefined (reading 'map')"; a UI section silently fails to render | A render-path `computed` chains `.map()`/`.filter()`/`[...]` off a scoped `.get()` that is `undefined` until first sync (esp. `perSession`); `Default<>` hasn't hydrated yet | Guard every render-path scoped read with `?? []` ([gotchas/scoped-cell-pitfalls](gotchas/scoped-cell-pitfalls.md#5)) |
| "new Cell() only accepts static data" | Passing an input prop, mapped field, or computed/reactive value into `new Writable()` / `new Cell()` | Use the input writable cell directly, or initialize pattern-owned local cells from static values only ([new-cells](../../common/patterns/new-cells.md), [@reactivity](../../common/concepts/reactivity.md)) |
| "Tried to access a reactive reference outside a reactive context" | Accessing reactive value at init time (in `[NAME]`, `new Writable()`, or object indexing) | Wrap in `computed()`, use `lift()`, or set in event handler ([gotchas/reactive-reference-outside-context](gotchas/reactive-reference-outside-context.md)) |
| ".trim is not a function" / ".replace is not a function" / ".includes is not a function" | Calling plain string helpers on reactive fields, often from JSX or `.map()` render contexts | Render reactive values directly when possible, or derive labels/branches in `computed()` ([reactivity-issues](reactivity-issues.md), [@reactivity](../../common/concepts/reactivity.md)) |
| "Type 'string' is not assignable to type 'CSSProperties'" | String style on HTML element | Use object syntax `style={{ ... }}` ([style-errors](style-errors.md)) |
| Type mismatch binding item to `$checked` | Binding whole item, not property | Bind `item.done`, not `item` ([type-errors](type-errors.md)) |
| "ReadOnlyAddressError" | onClick inside computed() | Move button outside, use disabled ([gotchas/onclick-inside-computed](gotchas/onclick-inside-computed.md)) |
| Piece hangs, never renders | ifElse with composed pattern cell | Use local computed cell ([gotchas/ifelse-composed-pattern-cells](gotchas/ifelse-composed-pattern-cells.md)) |
| Piece body renders empty on cold load (slug/id URL) but fine via in-app nav; no console error | `[UI]` is a bare pattern instance, or a helper-returned VNode (re-materializes for the deployed root, not a re-run sub-piece) | Author `[UI]` as inline DOM-rooted JSX; nest child patterns inside DOM ([gotchas/piece-ui-must-be-vnode](gotchas/piece-ui-must-be-vnode.md)) |
| Data not updating | Missing `$` prefix or wrong event | Use `$checked`, `$value` ([reactivity-issues](reactivity-issues.md)) |
| Filtered list not updating | Need computed() | Wrap in `computed()` ([reactivity-issues](reactivity-issues.md)) |
| lift() returns 0/empty | Passing cell directly to lift() | Use `computed()` or pass as object param ([gotchas/lift-returns-stale-data](gotchas/lift-returns-stale-data.md)) |
| Handler binding: unknown property | Passing event data at binding time | Use inline handler for test buttons ([gotchas/handler-binding-error](gotchas/handler-binding-error.md)) |
| Stream.subscribe doesn't exist | Using new Stream()/subscribe() | Bound handler IS the stream ([gotchas/stream-subscribe-dont-exist](gotchas/stream-subscribe-dont-exist.md)) |
| Can't access variable in nested scope | Variable scoping limitation | Pre-compute grouped data or use lift() with explicit params ([reactivity-issues](reactivity-issues.md#variable-scoping-in-reactive-contexts)) |
| "Cannot access cell via closure" | Using lift() with closure | Pass all reactive deps as params to lift() ([@reactivity](../../common/concepts/reactivity.md)) |
| CLI `get` returns stale computed values | `piece set` doesn't trigger recompute | Run `piece step` after `set` to trigger re-evaluation ([cli-debugging](cli-debugging.md#stale-computed-values-after-piece-set)) |
| "handler() should be defined at module scope" | handler() inside pattern body | Move handler() outside pattern ([gotchas/handler-inside-pattern](gotchas/handler-inside-pattern.md)) |
| UI churning, high CPU, never settles | Non-idempotent computed or action cycle | Run `await commonfabric.detectNonIdempotent()` ([non-idempotent-detection](non-idempotent-detection.md)) |
| `non-idempotent raw:map` or `Too many iterations: ... raw:map` | Mapped render body is doing work during render, often an event prop invoking `.send()` immediately | Inspect `.map()` JSX for `onClick={stream.send(...)}` or other render-time writes ([gotchas/immediate-event-invocation](gotchas/immediate-event-invocation.md)) |
| "Function creation is not allowed in pattern context" | Helper function inside pattern | Move function to module scope ([gotchas/handler-inside-pattern](gotchas/handler-inside-pattern.md)) |
| "lift() should not be immediately invoked inside a pattern" | `lift(...)(args)` inside pattern | Use `computed()` instead, or define lift() at module scope ([gotchas/handler-inside-pattern](gotchas/handler-inside-pattern.md)) |
| Click handler does nothing, ID lookup fails silently | Using custom `id` property for lookups | Use `equals()` for identity, not custom IDs ([gotchas/custom-id-property-pitfall](gotchas/custom-id-property-pitfall.md)) |
| Selection overwrites item data, `.set()` changes wrong value | Storing Cell reference directly | Box the reference: `{ item }` instead of `item` ([gotchas/cell-reference-overwrite](gotchas/cell-reference-overwrite.md)) |
| List of records renders intermittently/blank; full-cell read is huge | Persisting inline image `data` (base64 data-URL) in a (PerSpace) cell | Persist the blob `url`, not `data`; `includeData` only for transient LLM use ([gotchas/persisting-images-in-cells](gotchas/persisting-images-in-cells.md)) |
| Per-row inline form (delete-confirm, edit, picker) never opens; no error | `computed()` nested in a `.map()` over a **`computed()`-produced** list reads a `perSession` cell — the narrower-scope follow is silently blocked (mapping a cell directly works) | Bake the flag into the producing `computed()`: read the perSession cell once at top level, emit a plain boolean per row ([gotchas/persession-read-in-mapped-computed](gotchas/persession-read-in-mapped-computed.md)) |
| "Reactive reference from outer scope cannot be accessed via closure" / "Cannot access cell via closure" at pattern construction (pre-CT-1626 runtimes only; the construction-time abort is fixed in CT-1626 / PR #3726) | An inner `(cellCall() ?? []).map((el) => …)` was nested in an outer `.map((row) => …)`; the `?? []` hid the cell receiver from the ts-transformer so no `mapWithPattern` rewrite was inserted, but the runtime receiver was still an OpaqueRef. The shape remains a code smell — if you mean the cell, just map the cell. | Map the cell directly (`people.map(...)`); OR pre-bake into a top-level `computed` of plain values, then map that; OR explicit `derive({deps}, …)` per row ([gotchas/closure-capture-in-nested-map](gotchas/closure-capture-in-nested-map.md)) |
| Writable-input computed causes churn or stale fan-out | Computed writes through a `Writable<>` input while also participating in reactive scheduling | Treat it as effectful and check for cycles. Pull mode materializes stable side writes through idle materializers, so actual changed paths should drive downstream updates instead of broad fan-out. |

---

## Guides by Topic

### Common Gotchas

These issues compile without errors but fail at runtime.

- [.get() is Not a Function](gotchas/get-is-not-a-function.md) - Only `Writable<>` has `.get()`
- [filter/map/find is Not a Function](gotchas/filter-map-find-not-a-function.md) - Value isn't an array yet
- [Reactive Reference Outside Context](gotchas/reactive-reference-outside-context.md) - Use `lift()` for object indexing
- [Local Cells](../../common/patterns/new-cells.md) - `new Writable()` is for
  new pattern-owned cells initialized from static values
- [onClick Inside computed()](gotchas/onclick-inside-computed.md) - ReadOnlyAddressError
- [ifElse with Composed Pattern Cells](gotchas/ifelse-composed-pattern-cells.md) - Piece hangs
- [lift() Returns Stale/Empty Data](gotchas/lift-returns-stale-data.md) - Closure limitations
- [Handler Binding Error](gotchas/handler-binding-error.md) - Two-step binding pattern
- [Immediate Event Invocation](gotchas/immediate-event-invocation.md) - Event props invoking streams or writes during render
- [new Stream() / .subscribe() Don't Exist](gotchas/stream-subscribe-dont-exist.md) - Bound handlers ARE streams
- [handler() or Function Inside Pattern](gotchas/handler-inside-pattern.md) - Module scope requirement
- [Custom `id` Property Pitfall](gotchas/custom-id-property-pitfall.md) - Use `equals()` for identity
- [Cell Reference Overwrite](gotchas/cell-reference-overwrite.md) - Box references with `{ item }`
- [Persisting Images in Cells](gotchas/persisting-images-in-cells.md) - Store the blob `url`, not the inline `data`
- [perSession Read in a Mapped computed()](gotchas/persession-read-in-mapped-computed.md) - Per-row inline forms that never open; hoist the session read out of the nested `computed()`
- [Scoped Cell Pitfalls](gotchas/scoped-cell-pitfalls.md) - `PerSpace`/`PerUser`/`PerSession` gotchas, incl. guarding render-path `.get().map()` against undefined-before-sync
- [Closure Capture in Nested map()](gotchas/closure-capture-in-nested-map.md) - `(cellCall() ?? []).map(...)` nested in an outer `.map(...)` used to abort pattern construction; fixed in CT-1626 / PR #3726. The shape is still a code smell — three recipes (map cell directly; pre-bake top-level computed; per-row `derive`).

### Error Categories

- [Type Errors](type-errors.md) - Wrong bindings, Writable arrays
- [Style Errors](style-errors.md) - Object vs string syntax for HTML/custom elements
- [Reactivity Issues](reactivity-issues.md) - Data not updating, scoping problems
- [Runtime Errors](runtime-errors.md) - DOM access, async blocking

### Runtime Inspection

- [Logger System](logger-system.md) - Structured logging, levels, counts, timing, flags
- [Console Commands](console-commands.md) - `globalThis.commonfabric.*` browser console reference
  - Includes cell inspection utilities (`readCell`, `readArgumentCell`, `subscribeToCell`, `watchWrites`, `explainTriggerTrace`)
- [VDOM Debug Helpers](vdom-debug.md) - `commonfabric.vdom.*` VDOM tree inspection

### Diagnosis

- [Non-Idempotent Detection](non-idempotent-detection.md) - Detect non-settling computations, cycles, and non-idempotent actions
- [Debugging Settle Waves](settle-wave-investigation.md) - Worker-focused workflow for tracing fan-out, logger baselines, and next instrumentation

### Workflows

- [Debugging Workflow](workflow.md) - Step-by-step process + quick fixes
- [Testing Patterns](testing.md) - Local and deployed testing
- [CLI-Based Debugging](cli-debugging.md) - When to use CLI vs browser
- [Performance](performance.md) - Handler creation, pre-computing

---

## See Also

- [@reactivity](../../common/concepts/reactivity.md) - Reactivity system
- [@writeable](../../common/concepts/types-and-schemas/writable.md) - Writable type system
- [@COMPONENTS](../../common/components/COMPONENTS.md) - UI components
- [@CELL_CONTEXT](../../common/components/CELL_CONTEXT.md) - Debug tool details
