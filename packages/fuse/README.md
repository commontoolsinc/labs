# @commontools/fuse

Mount Common Tools spaces as a FUSE filesystem. Pieces appear as directories
with their cell data exploded into files and subdirectories — browse with `ls`,
read with `cat`, write with `echo`, and link pieces together with `ln -s`.

## Prerequisites

Install [FUSE-T](https://www.fuse-t.org/) (preferred) or
[macFUSE](https://osxfuse.github.io/) on macOS.

## Quick Start

```bash
# Mount your home space
ct fuse mount /tmp/ct

# In another terminal, explore
ls /tmp/ct/home/pieces/
cat /tmp/ct/home/pieces/todo-app/result.json
cat /tmp/ct/home/pieces/todo-app/result/items/0/text

# Unmount
ct fuse unmount /tmp/ct
```

## Filesystem Layout

```
/tmp/ct/                              # mount root
  home/                               # space (connected on demand)
    pieces/
      todo-app/                       # piece directory
        result.json                   # full result cell as JSON
        result/                       # exploded JSON tree
          title                       # file: My Todos
          count                       # file: 3
          items/                      # array → directory with numeric keys
            0/
              text                    # file: Buy milk
              done                    # file: false
            1/
              text                    # file: Walk dog
              done                    # file: true
          items.json                  # [{"text":"Buy milk","done":false}, ...]
          addItem.handler             # write-only stream cell
        input.json                    # full input cell as JSON
        input/                        # exploded input tree
        meta.json                     # piece ID, entity, pattern name
      .index.json                     # piece name → entity ID mapping
    entities/                         # entity hash → ../pieces/<name> symlinks
    space.json                        # { did, name }
  .spaces.json                        # known space name → DID mapping
```

### JSON Mapping

| JSON Type | Filesystem   | Content                   |
| --------- | ------------ | ------------------------- |
| `string`  | Regular file | Raw UTF-8 (no quotes)     |
| `number`  | Regular file | Decimal string            |
| `boolean` | Regular file | `true` or `false`         |
| `null`    | Regular file | Empty (0 bytes)           |
| `object`  | Directory    | Keys become child entries |
| `array`   | Directory    | `0`, `1`, ... entries     |

Every directory also has a `.json` sibling (e.g., `result/items.json`) that
returns the subtree as JSON.

## Walkthrough

### Reading

```bash
# List all pieces in a space
ls home/pieces/

# Read the full result cell as JSON (pipe to jq for pretty printing)
cat home/pieces/todo-app/result.json | jq .

# Read individual fields
cat home/pieces/todo-app/result/title
# => My Todos

cat home/pieces/todo-app/result/items/0/text
# => Buy milk

# Read a nested subtree as JSON
cat home/pieces/todo-app/result/items.json
# => [{"text":"Buy milk","done":false},{"text":"Walk dog","done":true}]

# Check the JSON type via extended attributes
xattr -p user.json.type home/pieces/todo-app/result/count
# => number

# View piece metadata
cat home/pieces/todo-app/meta.json
# => {"id":"of:ba4j...","entityId":"ba4j...","patternName":"todo-app"}
```

### Writing

```bash
# Write a scalar value (type is inferred: number, boolean, or string)
echo -n "Updated title" > home/pieces/todo-app/result/title
echo -n "42" > home/pieces/todo-app/result/count      # writes number 42
echo -n "true" > home/pieces/todo-app/result/done      # writes boolean true

# Replace an entire subtree via .json file
echo '{"text":"New item","done":false}' > home/pieces/todo-app/result/items/0.json

# Replace the whole result cell
echo '{"title":"Fresh","items":[],"count":0}' > home/pieces/todo-app/result.json

# Invoke a stream handler (fire-and-forget)
echo '{"text":"Buy oat milk"}' > home/pieces/todo-app/result/addItem.handler
```

### Creating and Deleting

```bash
# Create a new key (empty string value)
touch home/pieces/todo-app/result/newField

# Create a new nested object
mkdir home/pieces/todo-app/result/metadata

# Delete a key
rm home/pieces/todo-app/result/oldField

# Delete an array element (re-indexes remaining elements)
rm -r home/pieces/todo-app/result/items/0

# Rename a key
mv home/pieces/todo-app/result/oldName home/pieces/todo-app/result/newName
```

### Symlinks (Cell References)

Cell references (sigil links) appear as symlinks. Creating a symlink writes a
sigil link into the parent cell.

```bash
# Link a field to another piece's input
ln -s ../../other-piece/input/foo home/pieces/todo-app/result/ref

# See where a reference points
ls -l home/pieces/todo-app/result/related
# => related -> ../../entities/ba4jcbvpq3k5.../
```

### Multiple Spaces

Spaces are connected on demand — just `cd` into any space name:

```bash
ls home/pieces/          # connects "home" space automatically
ls work/pieces/          # connects "work" space on first access
cat .spaces.json         # shows all connected spaces
```

You can also access spaces by DID:

```bash
ls "did:key:z6Mkk.../pieces/"
```

## CLI Commands

```bash
# Mount (foreground — Ctrl+C to unmount)
ct fuse mount /tmp/ct

# Mount in background
ct fuse mount /tmp/ct --background

# Check active mounts
ct fuse status

# Unmount
ct fuse unmount /tmp/ct

# With explicit connection settings
ct fuse mount /tmp/ct --api-url http://localhost:8000 --identity ./my.key
```

Environment variables `CT_API_URL` and `CT_IDENTITY` are also supported.

## Architecture

Single Deno process using FFI to libfuse. FUSE callbacks are registered via
`Deno.UnsafeCallback` with `nonblocking: true` on the session loop, so WebSocket
subscriptions and FUSE requests run concurrently on Deno's event loop.

Cell data is cached in an in-memory tree (`FsTree`). Subscriptions rebuild
affected subtrees on cell changes and invalidate the kernel cache via
`fuse_lowlevel_notify_inval_entry`.

Writes are fire-and-forget: the FUSE reply is sent before the cell write
completes, so subscription rebuilds don't block the callback chain (required to
avoid FUSE-T crashes from `notify_inval_entry` during callbacks).

## Direct Invocation

You can also run the FUSE filesystem directly without the CLI:

```bash
deno run --unstable-ffi --allow-ffi --allow-read --allow-write --allow-env --allow-net \
  packages/fuse/mod.ts /tmp/ct --api-url http://localhost:8000
```
