<!-- @reviewed 2026-02-06 wish-result-shape -->

# wish()

`wish()` discovers and connects to other pieces at runtime. It searches
favorites, mentionables, and profile elements by tag, and returns a reactive
`WishState<T>`.

```tsx
const wishResult = wish<{ content: string }>({ query: "#note" });
```

## Result Shape

`wish()` returns a `WishState<T>` with the following properties:

| Property     | Type    | Description                                           |
|--------------|---------|-------------------------------------------------------|
| `result`     | `T`     | The resolved piece (auto-confirmed or user-selected)  |
| `candidates` | `T[]`   | All matching pieces                                   |
| `[UI]`       | `VNode` | Built-in UI: picker (multiple matches) or result cell |
| `error`      | `any`   | Error message if resolution failed                    |

Access the resolved piece via `wishResult.result`:

```tsx
const wishResult = wish<{ content: string }>({ query: "#note" });

// Read a property from the resolved piece
const text = wishResult.result.content;

// Render the resolved piece's own UI
return { [UI]: <div>{wishResult.result}</div> };
```

### Single match auto-confirms

When exactly one piece matches, `result` is set immediately with no picker
shown. The `candidates` array will contain that single item.

### Multiple matches show a picker

When multiple pieces match, a picker UI is rendered via `wishResult[UI]`. The
user browses candidates and clicks "Confirm Selection". Until confirmed,
`result` reactively reflects the currently highlighted candidate.

You can render the built-in UI directly:

```tsx
return { [UI]: <div>{wishResult}</div> };
```

## Wishing for a Specific Piece

Decorate your schema with a jsdoc comment containing a `#tag`:

```tsx
/** Represents a small #note a user took to remember some text. */
type Output = {
  content: string | Default<"">;
};
```

Then wish for that tag from another pattern:

```tsx
const wishResult = wish<{ content: string }>({ query: "#note" });
```

## Scope Parameter

The `scope` parameter controls where wish searches for matching pieces:

- `"~"` - Search favorites in the [[HOME_SPACE]] (global, cross-space)
- `"."` - Search [[mentionable]] items in the current space
- `"profile"` - Search elements in the current user's shared profile

By default (no scope), wish searches **favorites only** for backward
compatibility.

### Examples

```tsx
// Search only favorites (default behavior)
wish({ query: "#note" })
wish({ query: "#note", scope: ["~"] })

// Search only mentionables in current space
wish({ query: "#note", scope: ["."] })

// Search both favorites AND mentionables (favorites first)
wish({ query: "#note", scope: ["~", "."] })

// Search the current user's shared profile elements
wish({ query: "#portfolio", scope: ["profile"] })
```

### Well-Known Profile Targets

Profiles are linked from the user's home default pattern at
`homeSpaceCell.defaultPattern.profile`. These well-known wishes resolve from
that link:

```tsx
wish({ query: "#profile" }) // profile default pattern
wish({ query: "#profileName" }) // profile.name
wish({ query: "#profileAvatar" }) // profile.avatar
wish({ query: "#profileSpace" }) // profile space cell
```

The optional `[UI]` for `wish({ query: "#profile" })` renders a link to the
profile default pattern when the profile exists. If the viewer has not created a
profile yet, it renders the same profile-name input used by the home profile tab
through the trusted profile-create pattern surface. Submitting a name creates
the viewer's profile through the home default pattern and leaves the current
view in place; the wish UI reacts into the profile link once the profile link
exists.

When rendering profile data from a shared piece, use a user-scoped result schema
for the rendered output so each viewer sees their own home profile projection.

### Favorites vs Mentionables vs Profile

| Feature    | Favorites (`~`)            | Mentionables (`.`)              | Profile (`profile`)              |
|------------|----------------------------|---------------------------------|----------------------------------|
| Storage    | Home default pattern       | Current space                   | Profile default pattern          |
| Scope      | Cross-space                | Per-space                       | Cross-space, per-user            |
| Source     | User's favorites list      | Pattern's `mentionable` export  | User's profile element list      |
| Tag source | Snapshotted when favorited | Computed from schema            | `userTags` first, then `tag`     |

### When to Use Each Scope

- **Favorites only (default)**: Globally available pieces the user has explicitly saved
- **Mentionables only**: Space-specific features that discover pieces created within that space
- **Profile only**: User-owned profile pieces that should follow the viewer
  across shared spaces
- **Both**: Find any relevant piece regardless of where it lives

## Call wish() at Pattern Level

Always call `wish()` at the pattern body level, not inside `computed()` or other
reactive constructs:

```tsx
export default pattern<Input>(({ enableSearch }) => {
  // ✅ Call wish() once at pattern level
  const searchPiece = wish<SearchOutput>({ query: "#search" });

  // Use computed() to conditionally process the result
  const searchData = computed(() => {
    if (!enableSearch) return null;
    return searchPiece.result?.data;
  });

  return { searchData, [UI]: <div>{searchData}</div> };
});
```

This ensures the wish is established once. Conditional logic belongs in how you
*use* the result, not in whether you *create* the wish.

## Intended Usage

Keep a handle to important information in a piece, e.g. google auth, user
preferences/biography, cross-cutting data (calendar).

### Adding Pieces via `#default`

To add new pieces to the space, wish for the `addPiece` handler as a `Stream`:

```tsx
const defaultApp = wish<{ addPiece: Stream<{ piece: MentionablePiece }> }>({
  query: "#default",
});
defaultApp.result.addPiece.send({ piece: newPiece });
```

Do **not** wish for `allPieces` as a `Writable` — see
[Adding Pieces](adding-pieces.md).
