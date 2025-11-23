# Bug: Maps/closures refactor creates double path nesting, breaking variable access in JSX

## Summary

The maps/closures refactor (commit a896f9026, Oct 31) introduced a bug where derived/wished variables get an extra level of path nesting, causing them to be `undefined` when accessed in JSX expressions.

## Verified Timeline

I bisected the issue and tested with the actual runtime at each commit:

1. **Before refactor** (commit 1b3682cba): ✅ **WORKS**
   - Charm names display correctly: "DefaultCharmList (1)"
   - Count shows correctly: "Charms (1)"

2. **After refactor** (commit a896f9026): ❌ **BROKEN**
   - Charm names show: "Untitled Charm"
   - Count shows: "Charms ()"
   - Error: `TypeError: Cannot read properties of undefined (reading 'length')`

3. **After Bernhard's change** (commit dccbe4f46): ❌ **STILL BROKEN**
   - Bernhard was trying to fix deletion (unrelated issue)
   - Display bug persisted from the refactor

## Root Cause

The refactor creates an extra level of path nesting. Looking at the error details:

```
reads: [
  {
    id: "of:baedreigjehbnhumsrplxuzluszqgbeep7h2nssonwk4jpepodrcda6tdp4",
    path: [ "internal", "allCharms", "allCharms" ],  // ❌ WRONG: double "allCharms"
    ...
  }
]
```

**Expected path**: `["internal", "allCharms"]`
**Actual path**: `["internal", "allCharms", "allCharms"]`

The variable name is being duplicated in the path, causing the runtime to look for a non-existent nested property.

## Affected Code Pattern

The issue affects this common pattern in `/packages/patterns/default-app.tsx`:

```typescript
const allCharms = derive<MentionableCharm[], MentionableCharm[]>(
  wish<MentionableCharm[]>("#allCharms"),
  (c) => c,
);

return {
  [NAME]: str`DefaultCharmList (${allCharms.length})`,  // ✅ WORKS in tagged template
  [UI]: (
    <ct-screen>
      <h2>Charms ({allCharms.length})</h2>  // ❌ FAILS in JSX - shows empty "()"
      {allCharms.map((charm) => ...)}       // ❌ FAILS - nothing renders
    </ct-screen>
  )
}
```

## Key Observation

The same variable works in different contexts:

- ✅ **Tagged templates** (`str\`...\``): Works correctly
- ❌ **JSX expressions**: Returns `undefined`

This suggests the refactor changed how JSX closures capture variables, creating the incorrect nested path.

## Reproduction

1. Checkout commit a896f9026 (the refactor)
2. Build and run dev servers
3. Create a charm with default-app.tsx
4. Observe: charm names show "Untitled Charm" instead of actual names
5. Check console: Error about reading 'length' of undefined

## Impact

- All patterns using `derive` with variables accessed in JSX are broken
- The `str` tagged template workaround only helps for string interpolation, not for actual JSX rendering
- Affects: default-app.tsx, chatbot-list-view.tsx, and any pattern using this pattern

## Files Affected

- `/packages/patterns/default-app.tsx` - Primary example
- `/packages/patterns/chatbot-list-view.tsx` - Also uses derive with wish
- Any pattern using derived/wished values in JSX

## Related Commits

- **a896f9026** - "Feature/map closures hierarchical params v2" - **THIS BROKE IT**
- dccbe4f46 - Bernhard's deletion fix (unrelated, came after)
- 31c0f526a - Original deletion fix using `.equals()` (worked before refactor)

## Testing Done

Created test spaces with code from before and after the refactor:
- `alex-pre-refactor-test`: Shows names correctly ✅
- `alex-post-refactor-test`: Shows "Untitled Charm" ❌
- `alex-111-1` (current main): Shows "Untitled Charm" ❌
