# Parking Coordinator: Test Timeout Investigation

## Summary

The parking-coordinator pattern's test fails with a 5-second timeout on
`action_edit_spot_1` (editing a spot's label/notes via `.set(toSpliced())`).
This was initially reported as a reactivity detection bug — the hypothesis being
that same-length array mutations aren't detected by the reactive system. **That
hypothesis is incorrect.** The actual root cause is a reactive cascade
performance issue caused by the pattern's 26 `.map()` calls in its JSX template.

## How to reproduce

```bash
# Full test (3 failures at action_6, action_21)
deno task ct test packages/patterns/parking-coordinator --verbose

# Minimal reproduction (1 failure: add spot 7, then edit spot 1)
deno task ct test packages/patterns/parking-coordinator/minimal-repro.test.tsx --verbose
```

## What we ruled out

### The data layer correctly detects same-length array mutations

When `.set(toSpliced())` replaces an element without changing array length,
`normalizeAndDiff()` correctly detects the change. The spread
`{...current[idx], label: "edited"}` creates a new plain object without the
`[ID]` symbol, so `recursivelyAddIDIfNeeded()` assigns a new `[ID]`, creating a
new entity ref. The diff sees old ref ≠ new ref and emits changes to the entity
document's fields.

### Reactive propagation works correctly for simple patterns

A minimal pattern with push → edit(toSpliced) correctly triggers downstream
lift/computed re-evaluation. This passes both as a runner unit test and via
`deno task ct test`:

```typescript
// packages/patterns/repro-edit-bug/ — this passes
const editItem = action(() => {
  const current = items.get();
  const idx = current.findIndex((i) => i.id === "a");
  if (idx >= 0) {
    items.set(current.toSpliced(idx, 1, { ...current[idx], label: "edited" }));
  }
});
```

### The edit works when done alone

Running `editSpot` on the full parking-coordinator pattern **without** first
calling `addSpot` succeeds in ~7 seconds (within timeout). The timeout only
occurs when `addSpot` (`.push()`) precedes `editSpot` (`.set(toSpliced())`).

### The order matters

| Sequence                  | Result             |
| ------------------------- | ------------------ |
| edit only                 | PASS               |
| edit → add                | PASS               |
| add → edit                | **FAIL (timeout)** |
| 4 persons + add → edit    | **FAIL (timeout)** |
| 4 persons → edit (no add) | PASS               |

## Actual root cause: reactive cascade performance

### Pattern complexity

The parking-coordinator pattern has:

- **26 `.map()` calls** in its JSX template
- Each `.map()` creates sub-piecelets per array element via the `map` builtin
- Multiple `computed()` values cross-reference `spots`, `persons`, and
  `requests` arrays
- UI computations for colors, sizes, and layout per element

### Profiling data

**`addSpot.push()` (action_5):**

- Settle loop: 4 iterations, work set sizes: 52 → 26 → 155 → 40
- **274 total computation runs in 1.2 seconds**
- The `map` builtin (`module.ts:92`) runs 147 times at ~3.8ms each

**`editSpot.set(toSpliced())` (action_6):**

- Settle loop: ~5 iterations, work set sizes: 24 → small → small → 203 → 11
- **243 total computation runs in 3.2 seconds**
- The `map` builtin runs 135 times at **~14ms each** (up from 3.8ms)
- Per-run cost increases because after the push, there are more sub-piecelets (4
  spots instead of 3) to reconcile

**Combined: 1.2s + 3.2s = 4.4s**, which with overhead exceeds the 5s timeout.

### Why per-run cost increases after push

After `addSpot` adds a 4th spot, every `.map()` over spots now iterates 4
elements instead of 3. Since there are 26 `.map()` calls, this compounds: each
map action creates/reconciles more sub-piecelets, each sub-piecelet has its own
reactive dependencies, and changes cascade through more settle iterations.

### Why simple patterns don't exhibit this

A pattern with just an array, push/edit handlers, and a single computed has
trivial reactive cost — the entire cycle completes in <1ms. The issue is
specific to patterns with O(N × M) reactive complexity where N is the number of
array elements and M is the number of `.map()` calls over that array.

## Potential fixes

### Short-term: increase test timeout

The test runner uses a 5-second timeout. The parking-coordinator needs ~5s for
each action's reactive cascade. Increasing to 10-15s would mask the issue but
not fix the underlying performance problem.

### Medium-term: optimize the map builtin

The `map` builtin (`packages/runner/src/builtins/map.ts`) runs once per change
per `.map()` call. When an array element's content changes (same-length
mutation), all maps over that array re-run, even if the map callback doesn't
read the changed field. More granular dependency tracking could avoid
unnecessary re-runs.

### Medium-term: reduce reactive cascade depth

The settle loop runs multiple iterations because each iteration's writes trigger
new work. With 26 maps and multiple interconnected computeds, a single array
change fans out into hundreds of computations across 4-5 settle iterations.
Batching or coalescing writes within an iteration could reduce the cascade.

### Long-term: pull-based scheduling for UI

In pull mode (not currently used for pattern tests), only effects are scheduled
eagerly; computations are pulled on demand. This would prevent the UI-related
map computations from running during test assertions that don't read UI output.

### Pattern-level: reduce `.map()` count

The parking-coordinator template has 26 `.map()` calls, many of which re-derive
the same data. Consolidating maps or computing derived data once in a `computed`
rather than inline in JSX would reduce the reactive surface area.
