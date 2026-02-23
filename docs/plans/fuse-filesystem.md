# Implementation Plan: FUSE Filesystem for Common Tools

**Spec:** [`docs/specs/fuse-filesystem/`](../specs/fuse-filesystem/README.md)
**Status:** Draft
**Estimated effort:** Large (multi-week)

## Architecture Decision

**Recommended: Single Deno process with libfuse FFI**

One process, one language, one build system. Deno calls libfuse via
`Deno.dlopen()`, using single-threaded FUSE mode with the session fd
integrated into Deno's event loop. The in-memory filesystem tree, inode
management, cell access, and subscriptions all live in TypeScript.

Rationale: the two-process Rust+IPC approach adds significant complexity
(second language, IPC protocol, data duplication, two-process lifecycle) for
a performance benefit that doesn't matter here. FUSE operations serve cached
JSON for `cat` and `ls` — not high-throughput I/O. The hot path (`getattr`,
`lookup`, `readdir`) reads from an in-memory `Map` regardless of architecture;
the single-process version just skips the IPC hop.

Fallback: if FFI proves too fragile (libfuse C struct layouts, macOS/Linux
compat), consider Rust FUSE daemon + IPC as an escape hatch, or try
`npm:fuse-native` via Deno's npm compat.

## Phases

### Phase 0: Proof of Concept (1-2 weeks)

**Goal:** Mount a directory, `ls` shows hardcoded entries, `cat` reads a
hardcoded file. Validates that Deno FFI to libfuse works at all.

#### 0.1 — FFI spike

Create `packages/fuse/` with minimal libfuse bindings.

- `ffi.ts`: `Deno.dlopen()` for libfuse (macFUSE's `libfuse.dylib` or
  Linux's `libfuse3.so`)
- `ffi-types.ts`: C struct layouts (`fuse_lowlevel_ops`, `stat`, `fuse_entry_param`,
  `fuse_file_info`) as `Deno.UnsafeCallback` definitions and `ArrayBuffer`
  views
- Register callbacks for `lookup`, `getattr`, `readdir`, `read`, `open`,
  `release`
- Hardcode a static tree: one directory with one file
- Mount, verify `ls` and `cat` work

**Key risk to validate:** Can `Deno.UnsafeCallback` be used as libfuse
operation callbacks? Does single-threaded mode work? Does `fuse_reply_*`
work from within the callback?

If this spike fails (FFI too painful, callbacks don't work right), pivot to
`npm:fuse-native` or Rust sidecar.

Deliverable: `deno run --allow-ffi --allow-read fuse/mod.ts /tmp/mnt` mounts
a static filesystem.

#### 0.2 — In-memory tree

Build the `tree.ts` module:

- `FsTree` class with inode allocation, lookup by path, lookup by inode
- `FsNode` type: `Directory | File | Symlink`
- Wire FUSE callbacks to read from the tree instead of hardcoded values
- `tree-builder.ts`: function to convert a JSON value into a `FsTree`
  subtree (object -> dir, scalar -> file, etc.)

Deliverable: mount a tree built from a JSON literal, browse it with `ls`/`cat`.

#### 0.3 — Connect to live cells

- `cell-bridge.ts`: reuse `loadManager()` from `packages/cli/lib/piece.ts`
  to connect to a real space
- Fetch piece list, build tree under `pieces/`
- Fetch cell values on first access (lazy loading)
- `result.json` and `input.json` files serve serialized cell data
- `result/` and `input/` directories serve the exploded JSON tree

Deliverable: `ls pieces/` shows real pieces, `cat pieces/<name>/result.json`
returns real data.

### Phase 1: Full Read Support (1-2 weeks)

**Goal:** Complete read-only filesystem with subscriptions.

#### 1.1 — `.json` siblings

For every directory node, synthesize a corresponding `.json` file that
returns the full JSON-serialized subtree. Handle it in `lookup`, `getattr`,
`read`.

#### 1.2 — Subscriptions and cache invalidation

- Subscribe to cell changes via existing WebSocket mechanism
- On change notification, rebuild affected subtree in the in-memory tree
- Use `fuse_lowlevel_notify_inval_inode` / `fuse_lowlevel_notify_inval_entry`
  to invalidate kernel caches (if kernel caching is enabled)

#### 1.3 — Extended attributes

Implement `getxattr` callback to report `user.json.type` for each node.

#### 1.4 — Symlinks for cell references

Detect sigil links (`{ "/": { "link@1": ... } }`) in cell values. Create
symlink nodes pointing to the target entity's path within the filesystem.

#### 1.5 — Metadata files

- `meta.json` per piece (read-only): ID, pattern name, connections
- `space.json` at root: DID, space name
- `pieces/.index.json`: name-to-ID mapping

#### 1.6 — Event loop integration

Integrate FUSE session fd with Deno's event loop properly:

- Use `Deno.watchFd()` or poll-based approach to avoid busy-waiting
- Ensure subscriptions (WebSocket) and FUSE requests are serviced
  concurrently without blocking each other

### Phase 2: Write Support (1-2 weeks)

**Goal:** Write to files, create/delete entries. Full read-write filesystem.

#### 2.1 — Write buffering

- Track open file handles with write buffers
- On `write` callback: append to buffer
- On `flush`/`release`: process the buffer

#### 2.2 — Scalar writes

- Infer JSON type from written bytes (see spec section 3)
- Construct cell write at the appropriate JSON path
- Call `cell.set()` / `cell.update()` via PieceManager
- Update in-memory tree optimistically

#### 2.3 — JSON writes

- Writes to `.json` files: parse as JSON, replace entire subtree
- Rebuild affected tree nodes

#### 2.4 — Handler invocation

- Writes to `handlers/<name>`: parse as JSON, call `stream.send()`
- Fire-and-forget semantics

#### 2.5 — Create and delete

- `create` (new file in object dir): add key to parent object
- `mkdir` (new dir in object dir): add key with `{}` value
- `unlink` / `rmdir`: remove key, re-index arrays for array parents
- Implement `rename`: remove old key + set new key, `EXDEV` for cross-cell

### Phase 3: CLI Integration (1 week)

**Goal:** `ct fuse mount/unmount/status` commands.

#### 3.1 — CLI commands

Add `packages/cli/commands/fuse.ts`:

- `ct fuse mount <mountpoint> [options]` (all spaces under one mountpoint)
- `ct fuse unmount <mountpoint>` (calls `fusermount -u` or equivalent)
- `ct fuse status` (list active mounts from PID files)

#### 3.2 — Process management

- `--foreground` mode: run in current process (default for now)
- Background mode: spawn detached Deno process, write PID to
  `~/.ct/fuse/<mountpoint-hash>.pid`
- `unmount`: read PID file, send SIGTERM, call `fusermount -u`, clean up

### Phase 4: Polish (1-2 weeks)

#### 4.1 — Graceful degradation

- Serve stale cache on toolshed disconnect
- Background reconnection
- `.status` virtual file at root

#### 4.2 — Performance tuning

- Profile `getattr` latency
- Consider enabling kernel page cache (`-o auto_cache`) with active
  invalidation via `notify_inval_*`
- Tune subscription scope (subscribe/unsubscribe based on access patterns)

#### 4.3 — Entity view

Implement `entities/` subtree for direct entity ID access.

#### 4.4 — Testing

- Unit tests: `tree-builder.ts` (JSON -> tree -> JSON round-trips)
- Unit tests: `cell-bridge.ts` (mock PieceManager)
- Integration tests: mount real filesystem, verify ops (requires FUSE in
  test env)
- Fuzz: random JSON -> tree -> filesystem reads -> compare

#### 4.5 — Documentation

- `packages/fuse/README.md`
- `ct fuse --help` with examples
- Troubleshooting: macFUSE/FUSE-T install, permissions, common errors

## Dependencies

### External

| Dependency | Purpose | Notes |
|------------|---------|-------|
| libfuse (C library) | FUSE implementation | macFUSE/FUSE-T on macOS, libfuse3 on Linux |
| macFUSE or FUSE-T | macOS FUSE provider | User must install; FUSE-T preferred (no kext) |

No Rust, no Cargo, no npm native addons.

### Internal

| Package | Usage |
|---------|-------|
| `@commontools/identity` | Session creation, UCAN auth |
| `@commontools/runner` | Runtime, Cell types, StorageManager |
| `@commontools/piece` | PieceManager, PiecesController |
| `@commontools/cli` (lib) | `loadManager()`, `inspectPiece()`, etc. |

## Risks

| Risk | Mitigation |
|------|------------|
| Deno FFI to libfuse doesn't work | Phase 0.1 is a spike to validate this first. Fallback: npm:fuse-native or Rust sidecar |
| C struct layouts differ across platforms | Abstract behind `ffi-types.ts`, test on macOS + Linux early |
| macFUSE installation friction | Document FUSE-T as preferred (no kext); add install instructions |
| Single-threaded FUSE too slow | Unlikely for this workload. Escape hatch: SharedArrayBuffer + worker threads, or Rust sidecar |
| Deno event loop + FUSE fd integration | Phase 1.6 addresses this explicitly. Worst case: busy-poll with short sleep |
| CI testing (FUSE requires privileges) | Docker with `--cap-add SYS_ADMIN --device /dev/fuse`, or unit-test the tree logic and skip mount tests in CI |
| Cell write conflicts | Same last-write-wins as browser/CLI — no special handling needed |

## File Listing (New)

```
packages/
  fuse/                              # NEW — single Deno package
    deno.json
    mod.ts                           # Entry point (mount, event loop)
    ffi.ts                           # Deno.dlopen() bindings to libfuse
    ffi-types.ts                     # C struct layouts, callback types
    fs.ts                            # FUSE operation handlers (getattr, read, write, ...)
    tree.ts                          # In-memory FsTree + inode management
    tree-builder.ts                  # JSON value -> FsNode conversion
    cell-bridge.ts                   # PieceManager -> FUSE tree updates
    types.ts                         # FsNode, JsonType, etc.
    cli.ts                           # CLI integration (mount/unmount/status)
    tests/
      tree-builder.test.ts
      cell-bridge.test.ts
      fs.test.ts
  cli/
    commands/fuse.ts                 # NEW — ct fuse subcommand
```
