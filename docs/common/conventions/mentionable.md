# Mentionables

Mentionables are pieces that a pattern exposes for discovery by other patterns
and UI components. They power `@`-mention autocomplete in `cf-prompt-input` and
`[[`-mention autocomplete in `cf-code-editor`.

## Exporting Mentionables

Export a `mentionable` property from your pattern to make child pieces
discoverable:

```tsx
// Shown for illustration only.
export default pattern<Input, Output>(({ ... }) => {
  const childPiece = ChildPattern({ ... });

  return {
    [NAME]: "Parent",
    [UI]: <div>...</div>,
    mentionable: [childPiece],  // Makes childPiece discoverable
  };
});
```

For dynamic collections, use a Writable:

```tsx
// Shown inside a pattern body.
const createdPieces = new Writable<any[]>([]);

const create = handler((_, { createdPieces }) => {
  createdPieces.push(ChildPattern({ name: "New" }));
});

return {
  [UI]: <cf-button onClick={create({ createdPieces })}>Create</cf-button>,
  mentionable: createdPieces,
};
```

**Notes:**
- Exported mentionables appear in autocomplete but NOT in the sidebar piece list
- This is for mentionables within your pattern's own scope — to add pieces to the
  global piece list, use the `addPiece` handler via `wish("#default")`.
  See [Adding Pieces](adding-pieces.md).

Mentionables are one deliberate way to make an unregistered child discoverable.
They do not provide a complete piece listing and cannot expose an orphan. See
[Finding Pieces](../concepts/piece-discovery.md).

### Index rows, and the reserved `piece` key

A `mentionable` list may hold the pieces themselves — the examples above —
or derived INDEX ROWS standing for them: entries shaped `{ [NAME], piece }`,
where the strings are the row's own copies and `piece` holds the actual
piece as a reference. A board-sized producer reaches for rows so that every
reader of the universe loads one document instead of every listed piece;
the Topics board's `mentionable` is the worked example
(`TopicMentionableRow` in `packages/patterns/topics/main.tsx`).

`piece` is therefore a RESERVED key on this contract: an entry carrying one
IS a row, and the editors store what `piece` names — never the entry — as
the mention's destination. A producer must not publish an unrelated
property named `piece` on its mentionable entries; doing so silently
redirects every mention of that entry. How consumers resolve rows is in
[`mentionable-internals.md`](../../../packages/ui/docs/mentionable-internals.md).

### The member name, `shortName`

One further key carries a collection's name for a member — `42` for a board
that numbers its members — and it is read at both ends of a mention. It is an
optional plain string.

On a ROW it is the collection's copy. `cf-code-editor` matches a `#42`
completion against it, and the copy is what lets that query run without reading
a member. A producer whose collection names nothing leaves it out, and a row
without it is one no such query reaches.

On a PIECE it is what the piece publishes for itself, read live off the
destination. A mention's pill renders it beside the label, so a mention already
written gains the number as soon as its destination starts publishing one, and
loses it again when the destination stops. A member pattern publishes it; a
universe row has no need to.

The name is never written into any document. A citation's spelling is computed
where it is read, which is the rule
[Naming in collections](../../specs/collection-naming.md) states.

## Wishing for Mentionables

Patterns can discover mentionables in the current space using `wish()`:

```tsx
// Shown inside a pattern body.
const mentionable = wish<MentionablePiece[]>({ query: "#mentionable" }).result;
```

Or with the `scope` parameter:

```tsx
// Shown for illustration only.
// Search mentionables in current space
const result = wish<{ content: string }>({ query: "#note", scope: ["."] });

// Search both favorites and mentionables
const result = wish<{ content: string }>({ query: "#note", scope: ["~", "."] });
```

See [wish](wish.md) for full documentation.

## Consuming Mentionables in UI Components

### cf-prompt-input (`@`-mentions)

Pass the mentionable cell to `cf-prompt-input` via the `$mentionable` attribute:

```tsx
// Shown inside a pattern body.
const mentionable = wish<MentionablePiece[]>({ query: "#mentionable" }).result;

<cf-prompt-input
  $mentionable={mentionable}
  placeholder="Type @ to mention..."
/>
```

When the user types `@` and selects a mention, it is inserted as a markdown
link in the format `[Name](/of:entityId)`. The `/of:` prefix and entity ID
follow the LLM-friendly link format used throughout the system.

### cf-code-editor (`[[`-mentions)

Pass mentionable and mentioned cells to `cf-code-editor`:

```tsx
// Shown inside a pattern body.
const mentionable = wish<MentionablePiece[]>({ query: "#mentionable" }).result;
const mentioned = new Writable<MentionablePiece[]>([]);

<cf-code-editor
  $value={content}
  $mentionable={mentionable}
  $mentioned={mentioned}
  language="text/markdown"
/>
```

When the user types `[[` and selects a mention, it is inserted as a wiki-link
in the format `[[Name (entityId)]]`. The entity ID is the bare CID without
the `of:` prefix. For rendering, `note-md.tsx` converts these to markdown
links by prepending `/of:`.

## Internals

How UI components resolve `@link` indirection (`asSchema()`,
`resolveAsCell()`, MentionController, link-format conversion) is contributor
documentation: see
[`packages/ui/docs/mentionable-internals.md`](../../../packages/ui/docs/mentionable-internals.md).
