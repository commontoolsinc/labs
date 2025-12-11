# Bug: Renderer subscriptions don't track link changes in ifElse result cells

**Status:** Identified, not yet fixed
**Discovered:** 2025-12-11
**Severity:** Medium (affects nested map + ifElse patterns)

---

## Summary

When using nested `map` + `ifElse` patterns, items disappear from the UI after array mutations even though the underlying data and ifElse evaluations are correct. The root cause is that the renderer's subscription mechanism subscribes to the **dereferenced content** of cells, not the cells containing links themselves.

---

## Reproduction Steps

1. Create a pattern with nested maps + ifElse:
```tsx
{categories.map((category) => (
  <div>
    <strong>{category}:</strong>
    {items.map((item) =>
      ifElse(
        computed(() => item.category === category),
        <div><ct-checkbox $checked={item.done}>{item.title}</ct-checkbox></div>,
        null
      )
    )}
  </div>
))}
```

2. Initial state: 3 items (Milk/Dairy, Bread/Bakery, Cheese/Dairy)
3. Check Milk's checkbox (sets `done = true`)
4. Remove Milk from the array

**Expected:** CategoryList shows Bread (Bakery) and Cheese (Dairy)
**Actual:** CategoryList shows empty categories, items invisible

---

## Root Cause

`ifElse` stores its result as a **link** to either the `ifTrue` or `ifFalse` branch using `setRaw(ref)`. When the renderer calls `subscribeToReferencedDocs`, it:

1. Reads through the link via `validateAndTransform` -> `resolveLink`
2. Subscribes to the **final dereferenced target** (the VNode content)
3. Does NOT subscribe to the cell containing the link

When ifElse changes which branch the link points to (e.g., from ifTrue to ifFalse), the old subscription doesn't fire because the old VNode didn't change—only the pointer to it changed.

---

## Evidence from Logs

**ifElse correctly evaluates and sets link:**
```
[ifElse#0] condition=true, setting result to ifTrue, branchValue type=object, isNull=false
```

**But renderer receives null (stale dereferenced value):**
```
[render#70] effect#2 key={"cell":{"/":"baedreias5lg73yp... valueType=null
[render#70] replaceWith ... oldNode=DIV newNode=#text
```

The ifElse correctly switches to a VNode, but the renderer still sees `null` because it was subscribed to the old target.

---

## Technical Details

**Key files:**
- `packages/runner/src/builtins/if-else.ts:58` - Uses `resultWithLog.setRaw(ref)` to store a link
- `packages/runner/src/cell.ts:subscribeToReferencedDocs` - Subscribes via `validateAndTransform` which calls `resolveLink`
- `packages/runner/src/link-resolution.ts` - `resolveLink` follows all links to the final value

**The problem chain:**
1. ifElse creates a result cell with identity `{ ifElse: cause }`
2. It stores a link (`setRaw`) pointing to either ifTrue or ifFalse branch
3. Renderer subscribes to the result cell via `subscribeToReferencedDocs`
4. `subscribeToReferencedDocs` calls `validateAndTransform` which follows the link
5. The subscription is registered against the **target** of the link (the VNode), not the cell containing the link
6. When ifElse changes the link to point elsewhere, the old subscription doesn't fire

---

## Potential Fix Approaches

1. **Subscribe to link-containing cells**: When reading through a link, also subscribe to the cell containing the link itself

2. **Track link targets**: Maintain a mapping from link targets back to their containing cells so changes can propagate

3. **Change ifElse to copy values**: Instead of storing links, copy the actual values (may have performance implications for large VNodes)

4. **Two-level subscription**: Have `subscribeToReferencedDocs` subscribe at each level of link resolution, not just the final target

---

## Test Pattern

Minimal reproduction: `packages/patterns/folk-wisdom-verification/test-nested-map-bug-repro.tsx`
Debug version with logging: `packages/patterns/folk-wisdom-verification/test-nested-map-bug-debug.tsx`

---

## Related Issues

This bug was discovered while investigating why items disappear from CategoryList UI patterns. It's separate from:
- The mapWithPattern cell closure bug (cells captured from outer scope fail)
- The alias bug (setting cell to array element creates bidirectional link)
