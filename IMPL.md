# Implementation Steps

## Step 1: Create shared utility `packages/runner/src/builtins/cell-schema.ts`

Extract from `llm-dialog.ts` (lines 103-126):
- `getCellSchema(cell)` - returns `{ schema, rootSchema }`
- `buildMinimalSchemaFromValue(cell)` - fallback for cells without schema
- Add new `getCellDescription(cell)` - returns `JSON.stringify(schema)` or empty string

## Step 2: Update `packages/runner/src/builtins/llm-dialog.ts`

- Import `getCellSchema` from new `cell-schema.ts`
- Remove local definition (lines 103-126)

## Step 3: Update `packages/runner/src/runtime.ts`

Update `HomeSpaceCellContents` interface (line 99) and `homeSpaceCellSchema` (lines 128-137):

```typescript
export interface HomeSpaceCellContents {
  favorites: Cell<{ cell: Cell<unknown>; tag: string }[]>;
}

export const homeSpaceCellSchema: JSONSchema = {
  type: "object",
  properties: {
    favorites: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cell: { not: true, asCell: true },
          tag: { type: "string", default: "" },
        },
        required: ["cell"],
      },
      asCell: true,
    },
  },
};
```

## Step 4: Update `packages/charm/src/manager.ts`

Add new schema definitions (near line 56):

```typescript
export const favoriteEntrySchema = {
  type: "object",
  properties: {
    cell: { not: true, asCell: true },
    tag: { type: "string", default: "" },
  },
  required: ["cell"],
} as const satisfies JSONSchema;

export const favoriteListSchema = {
  type: "array",
  items: favoriteEntrySchema,
} as const satisfies JSONSchema;
```

## Step 5: Update `packages/charm/src/favorites.ts`

1. Import `getCellDescription` from runner
2. Update `getHomeFavorites()` to use new schema
3. Update `addFavorite()`:
   ```typescript
   const tag = getCellDescription(charm);
   favoritesWithTx.push({ cell: charm, tag });
   ```
4. Update `removeFavorite()` - compare by `entry.cell` entity ID
5. Update `isFavorite()` - compare by `entry.cell` entity ID

## Step 6: Update `packages/runner/src/builtins/wish.ts`

Modify `#favorites` case in `resolveBase()` (lines 118-132):

```typescript
case "#favorites": {
  const userDID = ctx.runtime.userIdentityDID;
  if (!userDID) return undefined;

  const homeSpaceCell = ctx.runtime.getCell(userDID, userDID, undefined, ctx.tx);

  // No path = return favorites list
  if (parsed.path.length === 0) {
    return { cell: homeSpaceCell, pathPrefix: ["favorites"] };
  }

  // Path provided = search by tag
  const searchTerm = parsed.path[0].toLowerCase();
  const favoritesCell = homeSpaceCell.key("favorites").asSchema(favoriteListSchema);
  const favorites = favoritesCell.get() || [];

  // Case-insensitive search in stringified schema
  const match = favorites.find((entry) =>
    entry.tag?.toLowerCase().includes(searchTerm)
  );

  if (!match) {
    console.error(`No favorite found matching "${searchTerm}"`);
    return undefined;
  }

  return {
    cell: match.cell,
    pathPrefix: parsed.path.slice(1),  // remaining path after search term
  };
}
```

## Step 7: Export from `packages/runner/src/index.ts`

Add export for `getCellSchema` and `getCellDescription` from cell-schema.ts
