<!-- @reviewed 2025-12-10 docs-rationalization -->

Charms can be favorites and added to your [[HOME_SPACE]]. These charms can be accessed from _any_ space, via this list.

# Accessing the Favorites list

You can `wish` for the favorites list itself (see `system/favorites-manager.tsx` for a full example):

```tsx
type Favorite = { cell: { [NAME]?: string }; tag: string };
const wishResult = wish<Array<Favorite>>({ query: "#favorites" });
```

The `tag` field contains the serialized `resultSchema` of the charm pointed to by `cell`. This is automatically populated when adding a favorite and is used for tag-based searching in the wish system.

# Wishing for A Specific Charm

See `system/wish.tsx` for a full example. 

In `note.tsx` I decorate my schema with a jsdoc comment containing "#note":
```tsx
/** Represents a small #note a user took to remember some text. */
type Output = {
  mentioned: Default<Array<MentionableCharm>, []>;
  backlinks: MentionableCharm[];

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

# Call wish() at Pattern Level

Always call `wish()` at the pattern body level, not inside `computed()` or other reactive constructs:

```tsx
export default pattern<Input>(({ enableSearch }) => {
  // ✅ Call wish() once at pattern level
  const searchCharm = wish<SearchOutput>({ query: "#search" });

  // Use computed() to conditionally process the result
  const searchData = computed(() => {
    if (!enableSearch) return null;
    return searchCharm?.result?.data;
  });

  return { searchData, [UI]: <div>{searchData}</div> };
});
```

This ensures the wish is established once. Conditional logic belongs in how you *use* the result, not in whether you *create* the wish.

# Intended Usage

Keep a handle to important information in a charm, e.g. google auth, user preferences/biography, cross-cutting data (calendar).

# Future Plans

This is the minimum viable design. We will later:

- find tags on specific sub-schemas and properly discover the paths to the subtrees
- result a 'result picker' UI from in the `wishResult` to choose between many options and/or override
- support filtering `wish` to certain scopes
