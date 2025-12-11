# Blessed Docs Verification Notes

Detailed findings from manual verification of `community-patterns/community-docs/blessed/` claims.

**Parent doc:** `docs/PATTERN_LIBRARY_RATIONALIZATION.md`

---

## Cross-Charm Stream Invocation via wish()

**Source:** `blessed/cross-charm.md`
**Test patterns:** `packages/patterns/blessed-verification/test-cross-charm-server.tsx`, `test-cross-charm-client.tsx`
**Result:** VERIFIED WITH CORRECTIONS

### What the blessed doc claims:

1. Streams from wished charms appear as opaque `{ $stream: true }` objects
2. Pass to handler that declares `Stream<T>` in signature
3. Framework "unwraps" the opaque stream into a callable one
4. Inside handler, call `refreshStream.send({})` on the unwrapped stream

### What actually happens:

1. **CORRECT:** Streams appear as Cells wrapping `{ $stream: true }` marker
2. Declaring `Stream<T>` in handler signature does NOT auto-unwrap anything
3. The stream stays as a Cell; call `.send(eventData)` on the Cell itself
4. Event data must be an object (runtime calls `event.preventDefault()`) - can include data properties but NO functions

### Working pattern:

```typescript
const invokeServerStream = handler<unknown, { stream: Stream<void>; ... }>(
  (_event, state) => {
    const streamCell = state.stream as any;  // Actually a Cell, not unwrapped Stream
    const innerValue = streamCell.get();     // Returns { $stream: true }
    if (innerValue && innerValue.$stream) {
      streamCell.send({});  // Call .send() on the Cell, not the inner value
    }
  }
);
```

### Why the blessed doc's example still works:

The example `refreshStream.send({})` works, but NOT because of auto-unwrapping. It works because:
- Cells have a `.send()` method (see `cell.ts:612`)
- When Cell contents have `$stream` marker, `.send()` dispatches to stream listeners
- The "unwrapping" explanation is incorrect; it's Cell method dispatch

### Prerequisites discovered (not in blessed doc):

1. **Wish tags must be in JSDoc on Output type** - e.g., `/** A #mytag charm */` before `interface Output`
2. **Wish searches favorites only** - charm must be favorited to be discoverable via `wish({ query: "#tag" })`
3. **Event data must be an object** - `undefined` fails (runtime calls `event.preventDefault()`), functions in object fail in `convertCellsToLinks`. Data properties are fine: `{ foo: "bar" }` works.

---

## ct.render Forces Charm Execution

**Source:** `blessed/cross-charm.md`
**Test patterns:** `packages/patterns/blessed-verification/test-cross-charm-client.tsx`
**Result:** VERIFIED

Using `<ct-render $cell={wishResult.result} />` forces the wished charm to execute. Without it, the charm is referenced but not active (handlers won't respond).

---

## ifElse Executes BOTH Branches

**Source:** `blessed/reactivity.md`
**Test pattern:** `packages/patterns/blessed-verification/test-ifelse-both-branches.tsx`
**Result:** VERIFIED

Both branch computeds run on every condition change. The test uses `Cell.of()` for internal counters that increment in each branch's computed. Both counters increment together on toggle.

**Key implementation detail:** Must close over the reactive value (condition) in computed to create dependency.

---

## Idempotent Side Effects in computed()

**Source:** `blessed/reactivity.md`
**Test pattern:** `packages/patterns/blessed-verification/test-idempotent-side-effects.tsx`
**Result:** VERIFIED

Non-idempotent side effects (e.g., `array.push()`) cause scheduler thrashing until 101-iteration safety limit. Idempotent pattern (check-before-write with deterministic keys) settles properly.

---

## Never Use await in Handlers

**Source:** `blessed/handlers.md`
**Test pattern:** `packages/patterns/blessed-verification/test-await-in-handler.tsx`
**Result:** VERIFIED

`await` blocks UI thread. Use `fetchData` pattern for async operations to keep UI responsive.
