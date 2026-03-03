# Mentionables

Mentionables are pieces that a pattern exposes for discovery by other patterns
and UI components. They power `@`-mention autocomplete in `ct-prompt-input` and
`[[`-mention autocomplete in `ct-code-editor`.

## Exporting Mentionables

Export a `mentionable` property from your pattern to make child pieces
discoverable:

```tsx
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
const createdPieces = Writable.of<any[]>([]);

const create = handler((_, { createdPieces }) => {
  createdPieces.push(ChildPattern({ name: "New" }));
});

return {
  [UI]: <ct-button onClick={create({ createdPieces })}>Create</ct-button>,
  mentionable: createdPieces,
};
```

**Notes:**
- Exported mentionables appear in autocomplete but NOT in the sidebar piece list
- Use this instead of writing to `allPieces` directly

## Wishing for Mentionables

Patterns can discover mentionables in the current space using `wish()`:

```tsx
const mentionable = wish<MentionablePiece[]>({ query: "#mentionable" }).result;
```

Or with the `scope` parameter:

```tsx
// Search mentionables in current space
const result = wish<{ content: string }>({ query: "#note", scope: ["."] });

// Search both favorites and mentionables
const result = wish<{ content: string }>({ query: "#note", scope: ["~", "."] });
```

See [wish](wish.md) for full documentation.

## Consuming Mentionables in UI Components

### ct-prompt-input (`@`-mentions)

Pass the mentionable cell to `ct-prompt-input` via the `$mentionable` attribute:

```tsx
const mentionable = wish<MentionablePiece[]>({ query: "#mentionable" }).result;

<ct-prompt-input
  $mentionable={mentionable}
  placeholder="Type @ to mention..."
/>
```

When the user types `@` and selects a mention, it is inserted as a markdown
link in the format `[Name](/of:entityId)`. The `/of:` prefix and entity ID
follow the LLM-friendly link format used throughout the system.

### ct-code-editor (`[[`-mentions)

Pass mentionable and mentioned cells to `ct-code-editor`:

```tsx
const mentionable = wish<MentionablePiece[]>({ query: "#mentionable" }).result;
const mentioned = Writable.of<MentionablePiece[]>([]);

<ct-code-editor
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

## Cell Resolution and `@link` Indirection

Mentionable arrays from `wish()` results contain `@link` references, not
direct data. Each array entry is a sub-cell (e.g.,
`/of:parentId/internal/mentionable/0`) that points to the real piece cell
via indirection.

### The problem

Without schema information, accessing these sub-cells returns nested
`CellHandle` objects instead of data. The sub-cell IDs are also unstable
array paths, not the stable entity IDs needed for LLM tools and link
resolution.

### The solution: `asSchema()`

UI components that consume mentionable cells must use `.asSchema()` to tell
the runtime to resolve `@link` indirection before delivering values:

```tsx
import { MentionableArraySchema } from "../../core/mentionable.ts";

// In MentionController (used by ct-prompt-input):
this._mentionableTyped = this._mentionable.asSchema<MentionableArray>(
  MentionableArraySchema,
);
this._mentionableTyped.subscribe(() => {
  this.host.requestUpdate();
});

// In ct-code-editor (in willUpdate):
this.mentionable = this.mentionable.asSchema(MentionableArraySchema);
```

Without `asSchema()`, `.get()` on array entries returns `CellHandle` objects
(the raw `@link` references) instead of the actual mentionable data.

### Resolving stable entity IDs

Sub-cell IDs like `/of:parentId/internal/mentionable/0` are array indices,
not stable entity references. To get the real piece cell ID, use
`resolveAsCell()`:

```tsx
const resolved = await subCell.resolveAsCell();
const stableId = resolved.ref().id;  // e.g., "of:bafyabc123"
```

**Important:** `CellHandle.id()` strips the `of:` prefix, while
`CellHandle.ref().id` preserves it. Use `.ref().id` when building
LLM-friendly links (`/of:...` format). Use `.id()` when you need the bare
CID (e.g., for wiki-link format in `ct-code-editor`).

## Link Formats

The system uses two link formats for mentions, depending on context:

| Format | Example | Used by |
|--------|---------|---------|
| Markdown link | `[Note](/of:bafyabc123)` | `ct-prompt-input`, LLM dialog, `ct-markdown` |
| Wiki-link | `[[Note (bafyabc123)]]` | `ct-code-editor`, `note-md.tsx` |

### Markdown links (`/of:...`)

These follow the LLM-friendly link format from `link-types.ts`. Path
segments are encoded per RFC 6901 (JSON Pointer): `~` becomes `~0`, `/`
becomes `~1`.

`ct-markdown` converts rendered `<a href="/of:...">` elements into
interactive `<ct-cell-link>` components.

### Wiki-links (`[[Name (id)]]`)

These use bare CIDs without the `of:` prefix. `note-md.tsx` converts them
to markdown links for display:

```tsx
raw.replace(
  /\[\[([^\]]*?)\s*\(([^)]+)\)\]\]/g,
  (_match, name, id) => `[${name.trim()}](/of:${id})`,
);
```

## Architecture

```
Pattern                    UI Component              Runtime
───────                    ────────────              ───────
wish("#mentionable")  ──►  $mentionable prop    ──►  @link array
                           │
                           ▼
                      .asSchema(MentionableArraySchema)
                           │
                           ▼
                      Resolved data (names, values)
                           │
                    ┌──────┴──────┐
                    ▼             ▼
             ct-prompt-input  ct-code-editor
             MentionController   (own impl)
                    │             │
                    ▼             ▼
             @-mention        [[-mention
             [Name](/of:id)   [[Name (id)]]
                    │             │
                    ▼             ▼
             LLM sees links   note-md.tsx converts
             in user message  to [Name](/of:id)
                                  │
                                  ▼
                              ct-markdown renders
                              as ct-cell-link
```
