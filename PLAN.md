# Plan: Favorites with Tags for Wish Search

## Overview

Enhance the favorites system to store `{ cell, tag }` entries instead of just cell references, enabling wish() to search favorites by tag matching.

## Design Decisions

- **Tag format**: `JSON.stringify(schema)` - captures full schema for flexible matching
- **Search**: Case-insensitive text search against stringified schema
- **Code org**: Factor out `getCellSchema` to shared utility in runner

## Data Structure Change

```typescript
// FROM: Cell<Cell<never>[]>
// TO:   Cell<{ cell: Cell<unknown>, tag: string }[]>

interface FavoriteEntry {
  cell: Cell<unknown>;
  tag: string;  // JSON.stringify of cell's schema
}
```

## Critical Files

| File | Changes |
|------|---------|
| `packages/runner/src/builtins/cell-schema.ts` | NEW - shared schema utilities |
| `packages/runner/src/builtins/llm-dialog.ts` | Import from cell-schema.ts |
| `packages/runner/src/runtime.ts` | Update HomeSpaceCellContents, homeSpaceCellSchema |
| `packages/charm/src/favorites.ts` | Update all functions for new structure |
| `packages/charm/src/manager.ts` | Add favoriteEntrySchema, favoriteListSchema |
| `packages/runner/src/builtins/wish.ts` | Add tag search in #favorites case |
| `packages/runner/src/index.ts` | Export new utilities |

## Edge Cases

- **Empty tags**: Cells without schema get empty string tag, won't match searches
- **Multiple matches**: Returns first match (can enhance later)
- **Tag staleness**: Tags captured at addFavorite time, won't update if schema changes (acceptable)
