# Pattern Debugging Guide

Quick error reference and debugging workflows. For detailed explanations, see linked docs.

## Quick Error Reference

| Error Message | Cause | Fix |
|---------------|-------|-----|
| "Property 'set' does not exist" | Missing `Writable<>` in signature | Add `Writable<T>` for write access ([@writeable](../../common/concepts/types-and-schemas/writable.md)) |
| "X.get is not a function" | Calling `.get()` on computed/lift result | Access directly without `.get()` - only `Writable<>` has `.get()` ([gotchas/get-is-not-a-function](gotchas/get-is-not-a-function.md)) |
| "X.filter is not a function" | Value isn't an array (yet) | Check `Default<>`, don't assume `.get()` is the fix ([gotchas/filter-map-find-not-a-function](gotchas/filter-map-find-not-a-function.md)) |
| "Tried to access a reactive reference outside a reactive context" | Accessing reactive value at init time (in `[NAME]`, `Writable.of()`, or object indexing) | Wrap in `computed()`, use `lift()`, or set in event handler ([gotchas/reactive-reference-outside-context](gotchas/reactive-reference-outside-context.md)) |
| "Type 'string' is not assignable to type 'CSSProperties'" | String style on HTML element | Use object syntax `style={{ ... }}` ([style-errors](style-errors.md)) |
| Type mismatch binding item to `$checked` | Binding whole item, not property | Bind `item.done`, not `item` ([type-errors](type-errors.md)) |
| "ReadOnlyAddressError" | onClick inside computed() | Move button outside, use disabled ([gotchas/onclick-inside-computed](gotchas/onclick-inside-computed.md)) |
| Piece hangs, never renders | ifElse with composed pattern cell | Use local computed cell ([gotchas/ifelse-composed-pattern-cells](gotchas/ifelse-composed-pattern-cells.md)) |
| Data not updating | Missing `$` prefix or wrong event | Use `$checked`, `$value` ([reactivity-issues](reactivity-issues.md)) |
| Filtered list not updating | Need computed() | Wrap in `computed()` ([reactivity-issues](reactivity-issues.md)) |
| lift() returns 0/empty | Passing cell directly to lift() | Use `computed()` or pass as object param ([gotchas/lift-returns-stale-data](gotchas/lift-returns-stale-data.md)) |
| Handler binding: unknown property | Passing event data at binding time | Use inline handler for test buttons ([gotchas/handler-binding-error](gotchas/handler-binding-error.md)) |
| Stream.subscribe doesn't exist | Using Stream.of()/subscribe() | Bound handler IS the stream ([gotchas/stream-subscribe-dont-exist](gotchas/stream-subscribe-dont-exist.md)) |
| Can't access variable in nested scope | Variable scoping limitation | Pre-compute grouped data or use lift() with explicit params ([reactivity-issues](reactivity-issues.md#variable-scoping-in-reactive-contexts)) |
| "Cannot access cell via closure" | Using lift() with closure | Pass all reactive deps as params to lift() ([@reactivity](../../common/concepts/reactivity.md)) |
| CLI `get` returns stale computed values | `piece set` doesn't trigger recompute | Run `piece step` after `set` to trigger re-evaluation ([cli-debugging](cli-debugging.md#stale-computed-values-after-piece-set)) |
| "handler() should be defined at module scope" | handler() inside pattern body | Move handler() outside pattern ([gotchas/handler-inside-pattern](gotchas/handler-inside-pattern.md)) |
| "Function creation is not allowed in pattern context" | Helper function inside pattern | Move function to module scope ([gotchas/handler-inside-pattern](gotchas/handler-inside-pattern.md)) |
| "lift() should not be immediately invoked inside a pattern" | `lift(...)(args)` inside pattern | Use `computed()` instead, or define lift() at module scope ([gotchas/handler-inside-pattern](gotchas/handler-inside-pattern.md)) |
| Click handler does nothing, ID lookup fails silently | Using custom `id` property for lookups | Use `equals()` for identity, not custom IDs ([gotchas/custom-id-property-pitfall](gotchas/custom-id-property-pitfall.md)) |
| Selection overwrites item data, `.set()` changes wrong value | Storing Cell reference directly | Box the reference: `{ item }` instead of `item` ([gotchas/cell-reference-overwrite](gotchas/cell-reference-overwrite.md)) |

---

## Guides by Topic

### Common Gotchas

These issues compile without errors but fail at runtime.

- [.get() is Not a Function](gotchas/get-is-not-a-function.md) - Only `Writable<>` has `.get()`
- [filter/map/find is Not a Function](gotchas/filter-map-find-not-a-function.md) - Value isn't an array yet
- [Reactive Reference Outside Context](gotchas/reactive-reference-outside-context.md) - Use `lift()` for object indexing
- [onClick Inside computed()](gotchas/onclick-inside-computed.md) - ReadOnlyAddressError
- [ifElse with Composed Pattern Cells](gotchas/ifelse-composed-pattern-cells.md) - Piece hangs
- [lift() Returns Stale/Empty Data](gotchas/lift-returns-stale-data.md) - Closure limitations
- [Handler Binding Error](gotchas/handler-binding-error.md) - Two-step binding pattern
- [Stream.of() / .subscribe() Don't Exist](gotchas/stream-subscribe-dont-exist.md) - Bound handlers ARE streams
- [handler() or Function Inside Pattern](gotchas/handler-inside-pattern.md) - Module scope requirement
- [Custom `id` Property Pitfall](gotchas/custom-id-property-pitfall.md) - Use `equals()` for identity
- [Cell Reference Overwrite](gotchas/cell-reference-overwrite.md) - Box references with `{ item }`

### Error Categories

- [Type Errors](type-errors.md) - Wrong bindings, Writable arrays
- [Style Errors](style-errors.md) - Object vs string syntax for HTML/custom elements
- [Reactivity Issues](reactivity-issues.md) - Data not updating, scoping problems
- [Runtime Errors](runtime-errors.md) - DOM access, async blocking

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
