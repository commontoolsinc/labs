# 2. Path Scheme and Filesystem Layout

## Addressing Model

The fundamental address of a cell in Common Tools is:

```
(space: MemorySpace, entity: URI, path: string[])
```

The FUSE filesystem maps this to:

```
<mountpoint>/<space>/<entity-id>[/<json-path>...]
```

However, raw entity IDs (`of:ba4jcbvpq3k5soo...`) are not ergonomic for
filesystem navigation. The primary interface uses **pieces** as the organizing
concept, since pieces are how users think about their data.

## Filesystem Layout

The mount root contains spaces. Each space contains pieces and entities.

```
<mountpoint>/
  <space>/                            # Space by name or DID
    pieces/                           # Piece-centric view (primary)
      <piece-name-or-id>/
        input.json                    # Full input cell as JSON
        input/                        # Input cell fields as directory tree
          <field>/...
        input/*.handler              # Top-level mounted handlers
        input/*.tool                 # Top-level mounted pattern tools
        result.json                   # Full result cell as JSON
        result/                       # Result cell fields as directory tree
          <field>/...
        result/*.handler             # Top-level mounted handlers
        result/*.tool                # Top-level mounted pattern tools
        meta.json                     # Read-only piece metadata
    entities/                         # Raw entity view (advanced)
      <entity-id>/
        .json                         # Full entity value
        <field>/...                   # JSON path traversal
    space.json                        # Space metadata (DID, name, etc.)
  .spaces.json                        # Known space name -> DID mapping
```

## Space Directory

Spaces are the top-level directories under the mountpoint. They can be
accessed by **name** or by **DID**:

```
<mountpoint>/
  home/                    # The home space (always listed)
  my-space/                # A named space
  did:key:z6Mkk.../        # Direct DID access
```

### Listing vs Lookup

`readdir` (i.e. `ls`) at the mount root and `lookup` (i.e. `cd`, `cat`)
behave differently:

- **`readdir /`** returns only **discoverable** spaces: `home` is always
  present. Once the home space exposes a space list, those spaces appear too.
  Until then, `ls` at root may show only `home/`.

- **`lookup /<name>`** succeeds for **any valid space name**. The filesystem
  resolves it on demand via `createSession({ spaceName })`, which
  deterministically derives a DID from the name. You don't need the name to
  appear in `ls` to access it.

- **`lookup /did:key:...`** works for direct DID access.

This is a standard FUSE pattern — like `/proc` where `readdir` shows known
PIDs but `lookup` resolves any valid one.

### The `home` Space

`home` is a well-known alias for the user's home space. It is always listed
in `readdir` at the mount root. The actual DID is resolved from the session's
identity.

### Space Name Resolution

Space names are resolved by `createSession({ spaceName })`, which
deterministically derives a DID:

```
Identity.fromPassphrase("common user").derive(spaceName) -> DID
```

This means any string is a valid space name — it will always resolve to a
DID. The filesystem does not validate whether a space "exists" (has data);
an empty space simply has no pieces.

DIDs (`did:key:...`, `did:ucan:...`) are used as-is without derivation.

### Space Index

A `.spaces.json` file at the mount root exposes the known name-to-DID
mapping:

```json
{
  "home": "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi",
  "my-space": "did:key:z7Nll..."
}
```

This file is updated as new spaces are discovered (accessed by name, or
listed by the home space once that capability exists).

## Piece Directory

Each piece gets a directory named by its display name (if set) or a
shortened entity ID. Name collisions are resolved by appending a numeric
suffix: `todo-app`, `todo-app-2`, etc.

```
home/pieces/todo-app/
  input.json          # {"title": "My Todos", "maxItems": 100}
  input/
    title             # file containing: My Todos
    maxItems          # file containing: 100
  result.json         # {"items": [...], "count": 3}
  result/
    items/
      0/
        text          # file containing: Buy milk
        done          # file containing: false
      1/
        text          # ...
        done          # ...
    count             # file containing: 3
    addItem.handler   # readable+writable mounted handler
    search.tool       # readable mounted pattern tool
  meta.json           # {"id": "of:ba4j...", "patternName": "todo-app", ...}
```

Only top-level callable children under `input/` and `result/` are surfaced as
`*.handler` and `*.tool`. These callable files are readable; the first line is
a stable `ct exec` shebang, and the same paths are valid under both
`pieces/<piece-name>/...` and `entities/<piece-id>/...`. Tool internals such as
`pattern/` and `extraParams/` do not appear as ordinary mounted directories.

## Name Resolution

Piece names are derived from:

1. `piece.name()` if set (the user-visible display name)
2. Pattern name from metadata
3. Shortened entity ID (first 12 chars) as fallback

Names are sanitized for filesystem safety:
- Replace `/` with `_`
- Replace null bytes
- Trim to 255 bytes (filesystem limit)
- Ensure uniqueness within the directory

A symlink or index file maps human names back to canonical entity IDs:

```
pieces/.index.json    # {"todo-app": "of:ba4jcbvpq3k5soo...", ...}
```

## Entity Directory

The `entities/` subtree provides direct access by entity ID for programmatic
use or when piece names are ambiguous:

```
entities/
  of:ba4jcbvpq3k5soo.../
    .json             # Full entity value
    input/addItem.handler
    result/search.tool
    items/
      0/
        text          # Leaf value
```

Entity IDs are truncated in the directory listing but can be accessed by prefix
match (the filesystem resolves the shortest unambiguous prefix).

Mounted callable paths accepted by `ct exec` are limited to the top-level
callable forms:

```text
<space>/pieces/<piece-dir>/<input|result>/<name>.handler
<space>/pieces/<piece-dir>/<input|result>/<name>.tool
<space>/entities/<entity-id>/<input|result>/<name>.handler
<space>/entities/<entity-id>/<input|result>/<name>.tool
```

## Path Encoding

JSON object keys become directory/file names. Array indices become numeric
directory/file names (`0`, `1`, `2`, ...).

Special characters in JSON keys are percent-encoded for filesystem safety:
- `/` -> `%2F`
- `\0` -> `%00`
- `.` prefix -> `%2E` prefix (to avoid hidden files from keys starting with `.`)

The `.json` suffix is reserved for aggregate access (see
[JSON Mapping](./3-json-mapping.md)).

---

**Previous:** [Overview](./1-overview.md) | **Next:** [JSON Mapping](./3-json-mapping.md)
