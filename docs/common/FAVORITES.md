Charms can be favorites and added to your [[HOME_SPACE]]. These charms can be accessed from _any_ space, via this list.

# Accessing the Favorites list

You can `wish` for the favorites list itself (see `favorites-manager.tsx` for a full example):

```tsx
type Favorite = { cell: Cell<{ [NAME]?: string }>; description: string };
const wishResult = wish<Array<Favorite>>({ tag: "#favorites" });
```

The `description` field contains the serialized `resultSchema` of the charm pointed to by `cell`. This is useful, because the description can contain tags as hints to the `wish` system.

# Wishing for A Specific Charm

See `wish.tsx` for a full example. 

In `note.tsx` I decorate my schema with a description containing "#note":
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
const wishResult = wish<{ content: string }>({ tag: "#note" });
```

# Intended Usage

Keep a handle to important information in a charm, e.g. google auth, user preferences/biography, cross-cutting data (calendar).

# Future Plans

This is the minimum viable design. We will later:

- find tags on specific sub-schemas and properly discover the paths to the subtrees
- result a 'result picker' UI from in the `wishResult` to choose between many options and/or override
- support filtering `wish` to certain scopes
