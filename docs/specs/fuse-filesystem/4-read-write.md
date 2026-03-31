# 4. Read/Write Semantics

## Read Path

### `getattr` (stat)

Every path must resolve to a valid `stat` result:

| Path Type | Mode | Size |
|-----------|------|------|
| Root, `pieces/`, `entities/` | `drwxr-xr-x` (0755) | 0 (synthetic) |
| Piece directory | `drwxr-xr-x` (0755) | 0 |
| Object/array value | `drwxr-xr-x` (0755) | 0 |
| Scalar value file | `-rw-rw-r--` (0664) | byte length of string repr |
| `.json` file | `-rw-rw-r--` (0664) | byte length of JSON |
| `meta.json` | `-r--r--r--` (0444) | byte length |
| `.handler` file | `-rw-r--r--` (0644) | byte length of shebang text |
| `.tool` file | `-r--r--r--` (0444) | byte length of shebang text |
| Symlink (cell ref) | `lrwxrwxrwx` | target path length |

**Timestamps**: `mtime` reflects the cell's last modification time (from the
`since` lamport clock, mapped to wall-clock time if available, or mount time
as fallback). `ctime` = `mtime`. `atime` = current time or mount time (atime
tracking is expensive and not useful here).

**Inode assignment**: Inodes are assigned from a counter, keyed by
`(entity_id, path)`. The same logical cell always gets the same inode within
a mount session.

### `readdir`

Returns the appropriate entries based on the JSON structure at that path.
Always includes `.` and `..`.

For object values: keys become entries, plus any `.json` siblings.
For array values: indices become entries, plus `.json` sibling.

Piece directories always contain `input.json`, `input/`, and `meta.json`.
For pieces without `[FS]`, they also contain `result.json` and `result/`;
callable files appear under `result/`. For pieces with `[FS]`, `result/` is
replaced by `index.md` or `index.json`, and callable files appear at the
piece root. All pieces have a `.handlers` file at the piece root.

### `read`

1. Resolve the path to a cell reference + JSON path.
2. `cell.get()` (or `cell.sample()` if reading from cache).
3. Navigate the JSON path.
4. Serialize the value:
   - string repr for scalars
   - JSON for `.json` files
   - synthetic shebang text for `.handler` / `.tool` files
5. Return the requested byte range (offset + size from the read call).

Mounted callable reads return synthetic text whose first line is:

```text
#!<stable-ct-shim> exec
```

This is display-only for this change. The supported execution contract is
`ct exec <mounted-callable-file> ...`.

Reads are served from a cache. The cache is populated eagerly for subscribed
cells and lazily for others.

### `readlink`

For symlinks (cell references), return the relative path to the target entity
within the filesystem. The target is constructed from the sigil link's `id`,
`path`, and `space` fields (see
[JSON Mapping](./3-json-mapping.md#reading-sigil-link---symlink)).

## Write Path

### `symlink` (Create Symlink)

Creating a symlink writes a sigil link into the parent cell:

1. Parse the target path to extract `(space, id, path)` tuple.
2. Construct a `SigilLink`: `{ "/": { "link@1": { id, path, space } } }`.
3. Set the value at the symlink's location in the parent cell.
4. The in-memory tree node at that path becomes a symlink.

If the target path cannot be parsed (doesn't resolve to a valid entity
path within the mountpoint), return `EINVAL`.

See [JSON Mapping](./3-json-mapping.md#writing-symlink---sigil-link) for
target path parsing rules and examples.

### `write` to Scalar File

1. Buffer writes until `flush` or `release`.
2. On flush: parse the buffer to determine JSON type (see type inference in
   [JSON Mapping](./3-json-mapping.md#type-preservation-on-write)).
3. Construct a cell write: navigate to the parent object/array, set the
   key/index to the new value.
4. Execute via `cell.set()` or `cell.update()`.
5. Wait for the write to be acknowledged before returning from `flush`.

### `write` to `.json` File

1. Buffer writes until `flush` or `release`.
2. On flush: parse the buffer as JSON.
3. If the path is `result.json`, replace the entire result cell.
4. If the path is `result/items/0.json`, replace just that subtree.
5. Execute via `cell.set()` at the appropriate path.

### `write` to `.handler` File

1. Buffer writes until `flush` or `release`.
2. On flush: parse the buffer as JSON (the event payload).
3. Route the payload to the same top-level piece property path used by mounted
   handler writes elsewhere in FUSE.
4. Deduplicate `flush`/`release` so one buffered write triggers one handler
   invocation.
5. Return success after the write has been handed to the runtime.

Handlers remain writable so legacy flows like
`echo '{"message":"hi"}' > result/addItem.handler` keep working.

### `write` to `index.md` or `index.json` (`[FS]` Projection)

When a piece uses the `[FS]` projection, writing to `index.md` or
`index.json` parses the content and writes back to the corresponding cells:

**`index.md`**: The file is parsed as YAML frontmatter + markdown body.
- Each frontmatter key (except `entityId`, which is read-only) is written to
  its corresponding cell via the `$FS.frontmatter.<key>` path.
- The body is written to the `$FS.content` cell.
- Invalid YAML frontmatter is silently skipped.

**`index.json`**: Parsed as a JSON object.
- Each key (except `entityId`) is written to `$FS.content.<key>`.
- Keys present in the cell but absent from the file are removed (deleted keys
  are cleared).
- Invalid JSON returns `EINVAL`.

`entityId` is always read-only and cannot be changed by writing to either
file.

### `read` from `.handlers`

`.handlers` is a read-only dot file at the piece root. It is generated
automatically when the piece is loaded and updated when the result cell
changes. Writing to `.handlers` fails with `EACCES`.

### `write` to `.tool` File

Mounted `.tool` files are read-only. Writes fail with `EACCES`. Execute them
through `ct exec <mounted-tool-file> [run] [flags]` instead.

Mounted handler and tool files are both accepted by `ct exec` from either the
`pieces/` or `entities/` view. Top-level `ct exec <file> --help` always prints
callable help; after the verb, schema-derived flags own the namespace.

### `create` (New File)

Creating a new file in an object directory sets a new key on the object:

```bash
echo -n "value" > result/newField
# equivalent to: result.newField = "value"
```

Creating a `.json` file at a path that was previously a scalar promotes
it — the old scalar is replaced with the parsed JSON structure.

### `mkdir` (New Directory)

Creating a directory in an object directory sets a new key to an empty object:

```bash
mkdir result/metadata
# equivalent to: result.metadata = {}
```

### `unlink` / `rmdir` (Delete)

Deleting a file or directory removes the corresponding key from the parent
object, or the element from the parent array:

```bash
rm result/items/0/text
# equivalent to: delete result.items[0].text

rm -r result/items/0
# equivalent to: result.items.splice(0, 1) — removes and re-indexes
```

Array deletion re-indexes: removing index 0 shifts 1->0, 2->1, etc.

### `rename` (Move)

Renaming a file or directory is equivalent to removing the old key and setting
the new key:

```bash
mv result/oldName result/newName
# equivalent to: result.newName = result.oldName; delete result.oldName;
```

Cross-cell renames (moving between `input/` and `result/`) are rejected with
`EXDEV`.

### `truncate`

Truncating a file to 0 bytes sets the value to an empty string (`""`).
Truncating a `.json` file to 0 is an error (`EINVAL`).

## Atomicity

Individual file writes (flush) are atomic at the cell transaction level.
Writing to a `.json` file replaces the entire subtree atomically.

There is no cross-file transaction support. Writing to `result/items/0/text`
and `result/items/0/done` are two separate transactions. For atomic multi-field
updates, write to the appropriate `.json` file instead.

## Error Mapping

| Cell/Runtime Error | FUSE errno |
|-------------------|------------|
| Entity not found | `ENOENT` |
| Path not found in JSON | `ENOENT` |
| Permission denied | `EACCES` |
| Write to read-only cell | `EROFS` |
| Invalid JSON on write | `EINVAL` |
| Cross-cell rename | `EXDEV` |
| Network/timeout | `EIO` |
| Space not available | `ENOENT` |

---

**Previous:** [JSON Mapping](./3-json-mapping.md) | **Next:** [Architecture](./5-architecture.md)
