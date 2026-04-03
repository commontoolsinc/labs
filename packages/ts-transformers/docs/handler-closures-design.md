# Handler Closures Transformation Spec

## Background

- The `dx1/unify-types` branch introduces a unified cell/stream type system
  built on the new `CELL_BRAND` symbol and capability interfaces (`IReadable`,
  `IWritable`, `IKeyable`, etc.).
- API exports and `commontools.d.ts` now define `HandlerFunction` in terms of
  `HandlerState<T>` and `StripCell<T>`, and the runner augments these interfaces
  with runtime-specific behaviour.
- Schema generator and opaque-ref transformers detect cell kinds via
  `CELL_BRAND`, keeping the hierarchical capture utilities valid across
  transformers.

## Impact on Handler Closures

- Generated handler callbacks must follow the public signature `(event, props)`
  so that `HandlerState<T>` inference works and schema injection can attach
  `toSchema` calls automatically.
- Captured values should appear under the `params` object we pass to
  `handler(...)`; we can reuse the hierarchical capture tree helpers we built
  for map closures to keep names/structure intact.
- Inline closures should only be rewritten when they are literal functions
  supplied to `on*` JSX attributes and are not already wrapped in
  `handler(...)`.

## Behaviour Overview

- Detect eligible JSX attributes using the existing `isEventHandlerJsxAttribute`
  helper (prop name starts with `on`).
- For inline arrow functions transform
  ```tsx
  <button onClick={() => counter.set(counter.get() + 1)} type="button" />;
  ```
  into
  ```tsx
  <button
    onClick={handler((event, { counter }) => counter.set(counter.get() + 1))({
      counter,
    })}
    type="button"
  />;
  ```
  preserving user-supplied parameter patterns whenever present.
- The params object mirrors the capture tree: nested state (`state.user.name`)
  becomes `{ state: { user: { name: state.user.name } } }` and optional
  chaining/computed keys are left untouched.
- Inline handlers are rewritten even when no captures exist. This keeps JSX
  syntax uniform and avoids downstream behaviour changes when captures are
  introduced later.
- Schema injection already recognises `handler(...)` calls and inserts
  `toSchema` arguments, so no additional transformer work is required there.

## Implementation Summary

1. Extend `ClosureTransformer` with a visitor that:
   - Finds JSX attributes whose name starts with `on`.
   - Confirms the initializer is an inline arrow function literal (excluding
     existing `handler(...)` invocations or other non-inline references).
   - Reuses `collectCaptures` / `groupCapturesByRoot` to build the capture tree
     for the handler body.
2. Build the rewritten callback:
   - Preserve explicit event/state parameters if the user provided them;
     otherwise synthesise `(eventParam, paramsParam)` placeholders.
   - Alias runtime names to originals via destructuring (e.g.
     `({ params: { counter } })`).
   - Leave the function body untouched except for computed-key caching
     (identical to map closures).
3. Emit the `handler(...)` call and params object; rely on schema injection to
   add `toSchema` arguments.
4. Capture regression coverage for: a basic increment handler; optional
   chaining/captured state; computed property access (`list[nextKey()]`); and an
   outer-variable collision (`const counter = …; onClick={() => counter}`).
5. Run `deno lint` and `deno task test` to cover the closure, derive, and
   handler suites.

## Decisions and Constraints

- We focus on inline arrow functions for now; other inline forms can be handled
  later if necessary.
- If the attribute already references a value returned from `handler(...)` (an
  `OpaqueRef`/cell) or any non-inline identifier, we leave it as-is.
- Captured cells/streams/opaque refs require no special casing—the capture tree
  handles them generically.

## Examples

### Basic Capture

```tsx
// Before
<button onClick={() => state.counter.set(state.counter.get() + 1)} type="button" />

// After
<button
  type="button"
  onClick={handler((event, { counter }) => counter.set(counter.get() + 1))({
    counter,
  })}
/>
```

### Optional Chaining and Computed Key

```tsx
// Before
<button
  type="button"
  onClick={() => recordMap[nextKey()]?.set(state.metrics.get() ?? 0)}
/>

// After
<button
  type="button"
  onClick={handler((event, { recordMap, state }) =>
    recordMap[nextKey()]?.set(state.metrics.get() ?? 0)
  )({
    recordMap,
    state: {
      metrics: state.metrics,
    },
  })}
/>
```
