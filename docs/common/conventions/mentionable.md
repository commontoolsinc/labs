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
