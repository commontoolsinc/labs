# Design: `findIndex` on reactive arrays

## Motivation

Pattern authors frequently need to find an element in a reactive array. Today
the workaround is `.filter(pred)[0]`, which creates an intermediate array cell
with per-element predicate patterns, evaluates all elements, and returns an
opaque element reference rather than a positional index.

A dedicated `findIndex` returns a number (-1 if not found), which is simpler to
work with and matches the `Array.prototype.findIndex` API.

## Design decision: lift-based (like reduce)

We considered three approaches:

| Approach | Model | Pros | Cons |
|----------|-------|------|------|
| **A. Per-element pattern** (like filter) | Run predicate pattern per element, return index of first truthy | Per-element reactivity | No better than `filter(pred)[0]` — still evaluates all elements, two-pass convergence |
| **B. lift-based** (like reduce) | `lift(items => items.findIndex(pred))` | Short-circuits, simple, no new builtin | Reruns on any change, predicate gets unwrapped values |
| **C. Short-circuit pattern** | Lazy per-element patterns, stop at first match | Optimal reactivity | Cascading convergence, complex teardown |

**Chosen: Option B.** `findIndex` returns a number, not an element reference —
there's no need for per-element reactive tracking. The lift approach
short-circuits naturally via JS `Array.prototype.findIndex`, requires no new
runtime builtin, no compiler changes, and the predicate receives unwrapped
values so normal JS comparisons (`item.active === true`) work.

The tradeoff is that the entire findIndex reruns when any array element changes.
This is the same tradeoff as `reduce`, and is acceptable for index lookups.

## Implementation

### cell.ts (OpaqueRef API)

Add alongside `reduce`:

```typescript
findIndex(
  this: IsThisObject,
  fn: (
    element: T extends Array<infer U> ? U : T,
    index: number,
    array: (T extends Array<infer U> ? U : T)[],
  ) => boolean,
): OpaqueRef<number> {
  return lift((list: any[]) => {
    if (!Array.isArray(list)) return -1;
    return list.findIndex(fn);
  })(this as unknown as OpaqueRef<any>);
}
```

That's it. No new builtin module, no compiler transform, no schema changes.

### What about `find`?

`find` returns `T | undefined` which is an element reference. In the reactive
system, this would need to return an `OpaqueRef<T | undefined>`. With the
lift-based approach, the returned value is an unwrapped copy, not a cell
reference to the original element. This is fine for reading properties but
doesn't support writing back to the found element.

If `find` (returning element references) is needed later, it would require the
per-element pattern approach (Option A) and compiler support. We're deferring
that — `findIndex` + index access covers the common cases.

## Implementation plan

1. Add `findIndex` method to OpaqueRef in `packages/runner/src/cell.ts`
2. Add runtime test in `packages/runner/test/`
3. No compiler changes needed
