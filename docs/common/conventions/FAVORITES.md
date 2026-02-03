<!-- @reviewed 2025-12-10 docs-rationalization -->

Pieces can be favorites and added to your [[HOME_SPACE]]. These pieces can be accessed from _any_ space, via this list.

# Accessing the Favorites list

You can `wish` for the favorites list itself (see `system/favorites-manager.tsx` for a full example):

```tsx
type Favorite = { cell: { [NAME]?: string }; tag: string };
const wishResult = wish<Array<Favorite>>({ query: "#favorites" });
```

The `tag` field contains the serialized `resultSchema` of the piece pointed to by `cell`. This is automatically populated when adding a favorite and is used for tag-based searching in the wish system.

# Wishing for A Specific Piece

See `system/wish.tsx` for a full example.

In `note.tsx` I decorate my schema with a jsdoc comment containing "#note":
```tsx
/** Represents a small #note a user took to remember some text. */
type Output = {
  mentioned: Default<Array<MentionablePiece>, []>;
  backlinks: MentionablePiece[];

  content: Default<string, "">;
  grep: Stream<{ query: string }>;
  translate: Stream<{ language: string }>;
  editContent: Stream<{ detail: { value: string } }>;
};
```

Later, I wish for "#note" and discover the first matching item in the list.

```tsx
const wishResult = wish<{ content: string }>({ query: "#note" });
```

# Scope Parameter

The `scope` parameter controls where wish searches for matching pieces:

- `"~"` - Search favorites in the [[HOME_SPACE]] (global, cross-space)
- `"."` - Search [[mentionable]] items in the current space

By default (no scope), wish searches **favorites only** for backward compatibility.

## Examples

```tsx
// Search only favorites (default behavior)
wish({ query: "#note" })
wish({ query: "#note", scope: ["~"] })

// Search only mentionables in current space
wish({ query: "#note", scope: ["."] })

// Search both favorites AND mentionables (favorites first)
wish({ query: "#note", scope: ["~", "."] })
```

## Favorites vs Mentionables

| Feature | Favorites (`~`) | Mentionables (`.`) |
|---------|-----------------|-------------------|
| Storage | Home space (global) | Current space |
| Scope | Cross-space | Per-space |
| Source | User's favorites list | Pattern's `mentionable` export |
| Tag source | Snapshotted when favorited | Computed from schema |

## When to Use Each Scope

- **Favorites only (default)**: Use when you want globally available pieces the user has explicitly saved
- **Mentionables only**: Use when building space-specific features that discover pieces created within that space
- **Both**: Use when you want to find any relevant piece regardless of where it lives

# Call wish() at Pattern Level

Always call `wish()` at the pattern body level, not inside `computed()` or other reactive constructs:

```tsx
export default pattern<Input>(({ enableSearch }) => {
  // ✅ Call wish() once at pattern level
  const searchPiece = wish<SearchOutput>({ query: "#search" });

  // Use computed() to conditionally process the result
  const searchData = computed(() => {
    if (!enableSearch) return null;
    return searchPiece?.result?.data;
  });

  return { searchData, [UI]: <div>{searchData}</div> };
});
```

This ensures the wish is established once. Conditional logic belongs in how you *use* the result, not in whether you *create* the wish.

# Intended Usage

Keep a handle to important information in a piece, e.g. google auth, user preferences/biography, cross-cutting data (calendar).
