# TODO: Wish Mentionable Search Feature

## All Tasks Complete

- [x] Added `scope` parameter to wish: `~` for favorites, `.` for mentionables
- [x] Fixed cell resolution: sync(), resolveAsCell(), schema extraction pattern
- [x] Committed main implementation (2 commits on `ben/2026-01-30-wish-mentionable`)
- [x] Fixed failing tests by adding `patternSpace` identity (separate from home space)
- [x] Removed DEBUG console.log statements
- [x] All 45 test steps pass

## Code Review Notes
- Removed unnecessary favorites fallback (`asSchemaFromLinks` fallback) - this was correct since tag is always snapshotted
- Hashtag matching is intentionally duplicated between favorites/mentionables for clarity

## Key Implementation Details (for reference)

### Cell Resolution Chain for Mentionables
```typescript
getSpaceCell(ctx)
  .key("defaultPattern")
  .key("backlinksIndex")
  .key("mentionable")
  .resolveAsCell()
  .asSchema(mentionableListSchema);
mentionableCell.sync(); // Critical! Data not available without this
const mentionables = mentionableCell.get() as Cell<any>[];
```

### Schema Extraction Pattern (from home.tsx)
```typescript
const schema = (pieceCell as any)?.resolveAsCell()?.asSchema(undefined)
  .asSchemaFromLinks?.()?.schema;
if (typeof schema === "object") {
  tag = JSON.stringify(schema);
}
```

### Test Setup Pattern
Tests need:
1. `patternSpace` identity separate from `userIdentity` (home space)
2. Separate commits for each DID to avoid `StorageTransactionWriteIsolationError`
3. `backlinksIndex` as a **separate cell** (not inline object):
```typescript
const backlinksIndexCell = runtime.getCell(patternSpace.did(), "backlinks-index", undefined, tx);
backlinksIndexCell.set({ mentionable: [mentionableItem] });
defaultPatternCell.set({ backlinksIndex: backlinksIndexCell });
```
