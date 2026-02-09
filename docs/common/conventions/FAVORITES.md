<!-- @reviewed 2026-02-06 wish-extracted -->

Pieces can be favorites and added to your [[HOME_SPACE]]. These pieces can be
accessed from _any_ space, via this list.

# Accessing the Favorites list

You can [[wish]] for the favorites list itself (see
`system/favorites-manager.tsx` for a full example):

```tsx
type Favorite = { cell: { [NAME]?: string }; tag: string };
const wishResult = wish<Array<Favorite>>({ query: "#favorites" });
```

The `tag` field contains the serialized `resultSchema` of the piece pointed to
by `cell`. This is automatically populated when adding a favorite and is used
for tag-based searching in the wish system.

See [[wish]] for full documentation of using `wish()`, including the result
shape, scope parameter, and usage patterns.
