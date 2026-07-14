<!-- @reviewed 2026-07-14 wish-async-result -->

# wish()

`wish()` discovers and connects to other pieces at runtime. It searches
favorites, mentionables, and profile elements by tag, and returns a reactive
`WishState<T>`.

```tsx
// Shown inside a pattern body.
const wishResult = wish<{ content: string }>({ query: "#note" });
```

## Result Shape

`wish()` returns a `WishState<T>` with the following properties:

| Property     | Type             | Description                                           |
|--------------|------------------|-------------------------------------------------------|
| `result`     | `AsyncResult<T>` | Resolved piece or its current availability            |
| `candidates` | `T[]`            | All matching pieces                                   |
| `[UI]`       | `VNode`          | Built-in UI: picker (multiple matches) or result cell |

Keep the result channel for guards and use `resultOf()` for the ordinary `T`
view:

```tsx
// Shown for illustration only.
const wishResult = wish<{ content: string }>({ query: "#note" });
const note = resultOf(wishResult.result);

// Read a property from the resolved piece
const text = note.content;

// Render the resolved piece's own UI
return { [UI]: <div>{note}</div> };
```

The common case does not inspect availability. Nodes which consume `note` wait
while the wish is pending and propagate errors automatically. A surface which
handles failure explicitly guards the original channel:

```tsx
// Shown for illustration only.
const noteWish = wish<Note>({ query: "#note" });
const note = resultOf(noteWish.result);

return {
  [UI]: hasError(noteWish.result)
    ? <div>{noteWish.result.error.message}</div>
    : <NoteCard note={note} />,
};
```

### Single match auto-confirms

When exactly one piece matches, `result` is set immediately with no picker
shown. The `candidates` array will contain that single item.

### Multiple matches show a picker

When multiple pieces match, a picker UI is rendered via `wishResult[UI]`. The
user browses candidates and clicks "Confirm Selection". Until confirmed,
`result` reactively reflects the currently highlighted candidate.

> **Exception — well-known profile targets.** `wish({ query: "#profile" })` does
> _not_ follow the "result reflects the highlighted candidate" rule. Its
> `.result` is **always the single current profile** (default → MRU → first) in
> every mode; the picker there is only a switching affordance, and selecting a
> profile changes `.result` by reordering candidates (MRU/default writes), not by
> a confirm gesture. See [Well-Known Profile Targets](#well-known-profile-targets)
> (CT-1829). Generalizing this "single-best by default; picker opt-in" shape to
> all wishes is a future step.

You can render the built-in UI directly:

```tsx
// Shown inside a pattern body.
return { [UI]: <div>{wishResult}</div> };
```

## Wishing for a Specific Piece

Decorate your schema with a jsdoc comment containing a `#tag`:

```tsx
// Shown at module scope.
/** Represents a small #note a user took to remember some text. */
type Output = {
  content: string | Default<"">;
};
```

Then wish for that tag from another pattern:

```tsx
// Shown inside a pattern body.
const wishResult = wish<{ content: string }>({ query: "#note" });
```

## Scope Parameter

The `scope` parameter controls where wish searches for matching pieces:

- `"~"` - Search favorites in the [home space](HOME_SPACE.md) (global, cross-space)
- `"."` - Search [mentionable](mentionable.md) items in the current space
- `"profile"` - Search elements in the current user's shared profile

By default (no scope), wish searches **favorites only** for backward
compatibility.

### Examples

```tsx
// Shown inside a pattern body.
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

A user may have multiple profiles, stored on the home default pattern at
`homeSpaceCell.defaultPattern.profiles` (a list), with `defaultProfile` and a
recency-ordered `mru`. The well-known wishes enumerate that list and resolve,
ordered **default first, then by MRU, then list order**:

```tsx
// Shown at module scope.
wish({ query: "#profile" }) // the single current profile; see [UI] below
wish({ query: "#profileName" }) // default profile's initialNameApplied
wish({ query: "#profileAvatar" }) // default profile's avatar
wish({ query: "#profileBio" }) // default profile's bio (free-text description)
wish({ query: "#profileSpace" }) // default profile's space cell
```

`wish({ query: "#profile" }).result` is **always the single current profile** —
the best of the ordered candidates (default → MRU → first) — in **every** mode
(interactive, headless, and the blessed read). It is never `undefined` while a
profile exists, and it never depends on the picker sidecar pattern running, so
consumers can gate on `.result` without stranding in the multi-profile case
(CT-1829). The `candidates` array holds all ordered profiles.

The picker is the **switching affordance**, not the source of `.result`:
selection is _state_, not a channel. When the picker's "Use" writes `mru` or
"Set default" writes `defaultProfile`, it reorders the candidates, so
`ordered[0]` — and therefore `.result` — updates reactively. The optional `[UI]`
for `wish({ query: "#profile" })`:

- **0 profiles:** the trusted profile-create surface (same input as the home
  Profile tab). Submitting a name creates the viewer's first profile and leaves
  the current view in place; the wish reacts once the link exists. `.result`
  carries an `error` availability value until the first profile exists.
- **1 profile:** a link to that profile.
- **2+ profiles, a valid default set:** a link to the default profile.
- **2+ profiles, no valid default:** the **profile picker**
  (`profile-picker.tsx`) — lists profiles, sets the default, stamps MRU, and
  creates more inline — rendered purely as the switcher. `.result` still
  resolves to the ordered best (MRU-or-first) immediately; picking a profile is
  what changes it.

When rendering profile data from a shared piece, use a user-scoped result schema
for the rendered output so each viewer sees their own home profile projection.

### Favorites vs Mentionables vs Profile

| Feature    | Favorites (`~`)            | Mentionables (`.`)              | Profile (`profile`)              |
|------------|----------------------------|---------------------------------|----------------------------------|
| Storage    | Home default pattern       | Current space                   | Profile default pattern          |
| Scope      | Cross-space                | Per-space                       | Cross-space, per-user            |
| Source     | User's favorites list      | Pattern's `mentionable` export  | User's profile element list      |
| Tag source | Snapshotted when favorited | Computed from schema            | `userTags` first, then `tag`     |

### Accessing the Favorites List Itself

Favorites are pieces added to the user's home space; they are accessible from
any space. You can wish for the favorites list directly (see
`system/favorites-manager.tsx` for a full example):

```tsx
// Shown at module scope.
type Favorite = { cell: { [NAME]?: string }; tags: string[] };
const wishResult = wish<Array<Favorite>>({ query: "#favorites" });
```

The `tags` field holds the discovery tags of the piece pointed to by `cell` —
the hashtags from its schema's doc comment, lowercased and without the leading
`#`. The favorites client derives them from the piece's schema when the
favorite is added (the schema is not reachable from inside the home pattern's
handler), and the wish system matches against them.

Favorites created before the `tags` field instead carry a `tag` field holding
the piece's serialized result schema; the wish system still reads it,
extracting hashtags from the serialized text. The `tag` field is deprecated;
do not write it.

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
// Shown at module scope.
export default pattern<Input>(({ enableSearch }) => {
  // ✅ Call wish() once at pattern level
  const searchPiece = wish<SearchOutput>({ query: "#search" });
  const search = resultOf(searchPiece.result);

  // Use computed() to conditionally process the result
  const searchData = computed(() => {
    if (!enableSearch) return null;
    return search.data;
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
// Shown for illustration only.
const defaultApp = wish<{ addPiece: Stream<{ piece: MentionablePiece }> }>({
  query: "#default",
});
const { addPiece } = resultOf(defaultApp.result);
addPiece.send({ piece: newPiece });
```

Do **not** wish for `allPieces` as a `Writable` — see
[Adding Pieces](adding-pieces.md).
