# 6. Reactivity and Caching

## Change Propagation

When a cell value changes (from the browser, another CLI session, or the
runtime itself), the filesystem must reflect the update.

### Flow

1. The Deno process subscribes to cell changes via the existing subscription
   mechanism (WebSocket to toolshed).
2. On change notification, rebuild the affected piece property. The rebuild
   builds the new subtree under a staging name and reconciles it onto the live
   subtree in place (`FsTree.transplantSubtree`), so a path that still exists
   keeps its inode. The whole swap is synchronous, so no filesystem request
   observes a half-rebuilt tree.
3. Invalidate the kernel caches the rebuild actually made stale via
   `fuse_lowlevel_notify_inval_inode` / `fuse_lowlevel_notify_inval_entry`.

### Kernel Cache Invalidation

The FUSE protocol supports `notify_inval_inode` and `notify_inval_entry` to
tell the kernel that cached data is stale. A rebuild reports the exact caches
it invalidated, and only those are dropped:

- `notify_inval_inode(inode, offset, len)` — invalidates cached file data, for
  each surviving inode whose file data, symlink target or callable script
  changed.
- `notify_inval_entry(parent_inode, name)` — invalidates a directory entry, for
  each child name that appeared, disappeared, or now points at a different
  inode.

A path that kept its inode and content is invalidated by neither, so a client
that walked into a piece keeps its cached lookups when an unrelated rebuild
runs. A removed subtree needs no per-descendant inode
invalidation: dropping the parent's directory entry is enough, and because
inode numbers are only ever allocated upward and never reused, a stale cache
for a freed inode number can never be observed.

This ensures that subsequent reads from userspace processes get fresh data
without requiring the process to close and reopen files.

### Subscription Scope

Not every cell in the space needs an active subscription. The Deno service
subscribes lazily:

1. Connecting a space obtains only the identifier snapshot when the server
   supports it. Identifier stubs do not subscribe to entity values.
2. Opening `pieces/` for the first time materializes and subscribes to
   `allPieces`; a mount that only uses `entities/` does not load it.
3. Access below an entity stub loads and projects the requested entity's
   current input and result values. Named projections under `pieces/`
   subscribe to their projected input and result cells.
4. Identifier discovery is refreshed when a new `entities/` directory handle
   is prepared. Continuation reads on one handle do not poll the server.

The distinction between identifier refresh and entity-value subscription is
specified in
[Entity Lookup, Enumeration, and Performance](./11-entity-lookup-enumeration.md).

## Caching Strategy

### In-Memory Tree

The Deno process maintains an in-memory tree that is the source of truth for
all FUSE operations:

```typescript
// Shown for illustration only.
class FsTree {
  inodes: Map<bigint, FsNode>;
  byPath: Map<string, bigint>;
  nextInode: bigint;
}

type FsNode =
  | { type: "directory"; children: Map<string, bigint> }
  | { type: "file"; content: Uint8Array; jsonType: JsonType }
  | { type: "symlink"; target: string };
```

This tree is updated when cell subscriptions fire. FUSE callbacks read
directly from it — no IPC, no async hop for cached data.

### Kernel Cache Settings

| Cache | TTL | Rationale |
|-------|-----|-----------|
| Attribute cache | 1s | Short — sizes change when cells update |
| Entry cache | 1s | Short — directory entries change when cells update |
| Page cache | Disabled (`direct_io`) | Data changes externally; kernel can't know |

`direct_io` mode bypasses the kernel page cache entirely, ensuring every
read goes to the FUSE daemon. This is necessary because cell data can change
at any time from external sources.

For read-heavy workloads where latency matters more than freshness, a
`--cache` flag could enable kernel caching with longer TTLs and rely on
`notify_inval_*` for invalidation.

### Write Buffering

Writes are buffered in the Rust layer per file handle:

1. `open()` — allocate a write buffer
2. `write()` — append to buffer
3. `flush()` / `release()` — send buffer to Deno service for cell write
4. On success, update the in-memory tree

This batching is important because tools like `vim` may issue many small
writes for a single save operation.

## Consistency Model

The filesystem provides **eventual consistency** with respect to the
underlying cell data:

- **Reads**: Served from the in-memory tree, which lags behind actual cell
  state by the subscription latency (typically <100ms on localhost).
- **Writes**: Synchronous from the FUSE perspective — `flush()` blocks
  until the cell write is acknowledged. The in-memory tree is updated
  optimistically on write, then corrected if the subscription brings a
  different value (e.g., if a computed cell transforms the input).
- **No read-your-writes guarantee across files**: Writing to `input/title`
  and immediately reading `result/count` may not reflect the computed
  update yet. The runtime needs to schedule and execute the pattern first.

For scripts that need to wait for computed results after a write, a special
file could be provided:

```bash
echo -n "new title" > input/title
cat .sync    # blocks until all pending computations complete
cat result/count  # now reflects the update
```

## Filesystem Events

Tools like `fswatch`, `inotifywait`, and `watchman` monitor filesystem
changes. The FUSE daemon can support this by:

1. Updating the in-memory tree on cell changes.
2. Using `notify_inval_*` to trigger kernel-level change events.
3. Watchers see the change as if the file was modified locally.

This enables workflows like:

```bash
# Watch for changes to a piece's result
fswatch ~/mnt/myspace/pieces/todo-app/result.json | while read; do
  echo "Result changed!"
  cat ~/mnt/myspace/pieces/todo-app/result.json | jq .
done
```

---

**Previous:** [Architecture](./5-architecture.md) | **Next:** [Open Questions](./7-open-questions.md)
