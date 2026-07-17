# Mentionable Internals

Contributor documentation for how UI components resolve mentionable cells. For
the pattern-author-facing view (exporting mentionables, wishing for them,
passing them to components), see
[`docs/common/conventions/mentionable.md`](../../../docs/common/conventions/mentionable.md).

## Cell Resolution and `@link` Indirection

Mentionable arrays from `wish()` results contain `@link` references, not direct
data. Each array entry is a sub-cell (e.g.,
`/of:parentId/internal/mentionable/0`) that points to the real piece cell via
indirection.

### The problem

Without schema information, accessing these sub-cells returns nested
`CellHandle` objects instead of data. The sub-cell IDs are also unstable array
paths, not the stable entity IDs needed for LLM tools and link resolution.

### The solution: `asSchema()`

UI components that consume mentionable cells must use `.asSchema()` to tell the
runtime to resolve `@link` indirection before delivering values:

```tsx
import { MentionableArraySchema } from "../../core/mentionable.ts";

// In MentionController (used by cf-prompt-input):
this._mentionableTyped = this._mentionable.asSchema<MentionableArray>(
  MentionableArraySchema,
);
this._mentionableTyped.subscribe(() => {
  this.host.requestUpdate();
});

// In cf-code-editor (in willUpdate):
this.mentionable = this.mentionable.asSchema(MentionableArraySchema);
```

Without `asSchema()`, `.get()` on array entries returns `CellHandle` objects
(the raw `@link` references) instead of the actual mentionable data.

### Resolving stable entity IDs

Sub-cell IDs like `/of:parentId/internal/mentionable/0` are array indices, not
stable entity references. To get the real piece cell ID, use `resolveAsCell()`:

```tsx
const resolved = await subCell.resolveAsCell();
const stableId = resolved.ref().id; // e.g., "of:fid1:abc123"
```

**Important:** `CellHandle.id()` returns the FULL schemed URI (`of:fid1:...`) —
the URI scheme is part of the identity (a `computed:` cell is not its `of:`
sibling), so programmatic surfaces keep it. The bare, `of:`-stripped form is a
ROUTING/EMBED convenience produced at the edges: `PageHandle.id()` for routing
pieceIds, and `mentionIdFromCellId` (`src/v2/utils/mention-id.ts`) for wiki-link
embeds — the latter throws on `computed:` ids, which the bare embed format
cannot represent.

## Link Formats

The system uses two link formats for mentions, depending on context:

| Format        | Example                   | Used by                                      |
| ------------- | ------------------------- | -------------------------------------------- |
| Markdown link | `[Note](/of:fid1:abc123)` | `cf-prompt-input`, LLM dialog, `cf-markdown` |
| Wiki-link     | `[[Note (fid1:abc123)]]`  | `cf-code-editor`, `note-md.tsx`              |

### Markdown links (`/of:...`)

These follow the LLM-friendly link format from `link-types.ts`. Path segments
are encoded per RFC 6901 (JSON Pointer): `~` becomes `~0`, `/` becomes `~1`.

`cf-markdown` converts rendered `<a href="/of:...">` elements into interactive
`<cf-cell-link>` components.

### Wiki-links (`[[Name (id)]]`)

These use bare CIDs without the `of:` prefix — the embed passes through
`mentionIdFromCellId`, which strips `of:` and REJECTS `computed:` ids (the
scheme is part of the identity, and the renderer unconditionally re-adds `/of:`,
so a computed id would silently alias its `of:` sibling; if mentionables ever
include computed cells, the embed format must carry the scheme). `note-md.tsx`
converts them to markdown links for display:

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
             cf-prompt-input  cf-code-editor
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
                              cf-markdown renders
                              as cf-cell-link
```
