# 3. JSON-to-Filesystem Mapping

The core design problem: cells contain arbitrary JSON. The filesystem must
represent this as files and directories.

## Mapping Rules

| JSON Type  | Filesystem Representation | Content Format           |
| ---------- | ------------------------- | ------------------------ |
| `string`   | Regular file              | Raw UTF-8 string (no quotes, no newline) |
| `number`   | Regular file              | Decimal string representation |
| `boolean`  | Regular file              | `true` or `false`        |
| `null`     | Regular file              | Empty file (0 bytes)     |
| `object`   | Directory                 | Keys become child entries |
| `array`    | Directory                 | Indices (`0`, `1`, ...) become child entries |

### Scalars as Files

Scalar values are stored as their natural string representation without JSON
encoding. This makes `cat` output human-readable:

```bash
cat result/title    # => My Todos     (not "My Todos")
cat result/count    # => 42           (not 42 — same either way)
cat result/done     # => true
cat result/empty    # => (empty)
```

Strings do **not** include a trailing newline. This preserves round-trip
fidelity: the bytes in the file are exactly the string value. Tools that
add newlines (like `echo`) require `-n` for correct writes.

### Objects as Directories

Each key becomes a child entry. The entry is a file or subdirectory depending
on the value type:

```
result/            # {"title": "My Todos", "count": 3, "meta": {"v": 1}}
  title            # file: My Todos
  count            # file: 3
  meta/            # directory
    v              # file: 1
```

### Arrays as Directories

Array indices become numeric directory entries:

```
result/items/      # [{"text": "Buy milk"}, {"text": "Walk dog"}]
  0/
    text           # file: Buy milk
  1/
    text           # file: Walk dog
```

## The `.json` Sibling Convention

Every directory (object or array) has a corresponding `.json` file that provides
the full JSON representation of that subtree. This is essential for:

- Reading an entire object/array as structured data
- Writing structured data back atomically
- Tools that expect JSON input (`jq`, programmatic access)

### Rules

1. For any path `P` that resolves to an object or array, `P.json` returns
   the JSON-serialized value.
2. For the root of a cell, the `.json` file lives alongside the directory:
   - `result.json` — full JSON of the result cell
   - `result/` — directory view of the same data
3. For nested paths, `.json` is a virtual file inside the parent:
   - `result/items.json` — JSON array of all items
   - `result/items/` — directory with `0/`, `1/`, etc.
4. Writing to a `.json` file replaces the entire subtree with the parsed
   JSON value.

### Example

```
pieces/todo-app/
  result.json              # {"items":[...],"count":3}
  result/
    items.json             # [{"text":"Buy milk","done":false},...]
    items/
      0.json               # {"text":"Buy milk","done":false}
      0/
        text               # Buy milk
        done               # false
    count                  # 3
```

### Reading

```bash
# Structured access
cat result.json | jq '.items[0].text'

# Leaf access
cat result/items/0/text
```

### Writing

```bash
# Replace entire result
echo '{"items":[],"count":0}' > result.json

# Replace a single item
echo '{"text":"Updated","done":true}' > result/items/0.json

# Replace a leaf
echo -n "Updated text" > result/items/0/text
```

## Type Preservation on Write

When writing to a scalar file, the filesystem must infer the JSON type:

1. If the content is valid JSON and parses to a non-string type, use that type.
   - `true` / `false` -> boolean
   - `null` -> null
   - Numeric string -> number (if valid finite JSON number)
2. Otherwise, treat as string.

This means:
- `echo -n "42" > count` sets the JSON value to `42` (number)
- `echo -n "hello" > title` sets it to `"hello"` (string)
- `echo -n "true" > done` sets it to `true` (boolean)
- `echo -n '"quoted"' > title` sets it to `"quoted"` (string, quotes stripped)

The `.json` files bypass inference entirely — content is parsed as JSON.

## Type Disambiguation

When reading, the JSON type is not always obvious from the file content. The
filesystem exposes type information via **extended attributes** (xattrs):

```bash
xattr -p user.json.type result/count        # => number
xattr -p user.json.type result/title        # => string
xattr -p user.json.type result/done         # => boolean
xattr -p user.json.type result/items        # => array
xattr -p user.json.type result/items/0      # => object
```

On macOS, use `xattr -p` to read these. On Linux, use `getfattr`.

## Special Values

### Cell References (Sigil Links)

When a cell value contains a reference to another cell (`{ "/": { "link@1": ... } }`),
the filesystem represents it as a **symlink** pointing to the referenced
entity's path within the filesystem:

```
result/related -> ../../entities/ba4jcbvpq3k5.../
```

If the reference includes a path, the symlink targets that subpath. If the
target is in a different space, the symlink target includes the space prefix
(which may not be mounted, resulting in a broken symlink — this is informative
rather than an error).

### Stream Markers

Stream cells (`{ $stream: true }`) appear as write-only files in the
`handlers/` directory. Reading them returns empty content. Writing sends an
event.

---

**Previous:** [Path Scheme](./2-path-scheme.md) | **Next:** [Read/Write Semantics](./4-read-write.md)
