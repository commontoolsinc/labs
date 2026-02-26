# Implementation Plan: FUSE Filesystem for Common Tools

**Spec:** [`docs/specs/fuse-filesystem/`](../specs/fuse-filesystem/README.md)
**Status:** Phase 0–3 complete, Phase 4 in progress

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

---

## Phase 0: Proof of Concept

**Goal:** Mount a directory, `ls` shows hardcoded entries, `cat` reads a
hardcoded file. Validates that Deno FFI to libfuse works at all.

- [x] **0.1 FFI spike** — Validate Deno FFI to libfuse
  - [x] `ffi.ts`: `Deno.dlopen()` for FUSE-T (primary) / macFUSE (fallback)
  - [x] `ffi-types.ts`: C struct layouts (`fuse_lowlevel_ops`, `stat`,
    `fuse_entry_param`, `fuse_file_info`)
  - [x] Register `Deno.UnsafeCallback` for `lookup`, `getattr`, `readdir`,
    `read`, `open`, `release`
  - [x] Hardcode a static tree (one dir, one file), mount, verify `ls`+`cat`
  - [x] **Key risk:** Validated — callbacks work via `nonblocking: true` on
    `fuse_session_loop()` + `UnsafeCallback.threadSafe()`
  - [x] ~~If spike fails: pivot~~ — Not needed, FFI works
- [x] **0.2 In-memory tree** — `tree.ts` module
  - [x] `FsTree` class: inode allocation, lookup by path, lookup by inode
  - [x] `FsNode` union type: `Directory | File | Symlink`
  - [x] Wire FUSE callbacks to read from tree instead of hardcoded values
  - [x] `tree-builder.ts`: convert JSON value to `FsTree` subtree
    (object->dir, scalar->file, array->dir with numeric entries)
  - [x] Circular reference handling via `safeStringify()` / WeakSet
  - [x] 11 unit tests passing (`tree-builder.test.ts`)
  - [x] Mount a tree from a JSON literal, browse with `ls`/`cat`
- [x] **0.3 Connect to live cells** — `cell-bridge.ts`
  - [x] Reuse `loadManager()` from `packages/cli/lib/piece.ts`
  - [x] Fetch piece list, build tree under `<space>/pieces/`
  - [ ] Lazy-load cell values on first access (deferred — currently eager)
  - [x] `result.json` / `input.json` serve serialized cell data
  - [x] `result/` / `input/` directories serve exploded JSON tree
  - [x] `ls <space>/pieces/` shows real pieces, `cat .../result.json` returns
    real data

## Phase 1: Full Read Support

**Goal:** Complete read-only filesystem with subscriptions and multi-space.

- [x] **1.1 `.json` siblings**
  - [x] Synthesize `.json` file for every directory node
  - [x] Handle in `lookup`, `getattr`, `read`
  - [x] Nested: `result/items.json`, `result/items/0.json`, etc.
- [x] **1.2 Multi-space root**
  - [x] Mount root lists `home/` (always present)
  - [x] `lookup` resolves any space name via `connectSpace()`
  - [x] `lookup` resolves raw DIDs (`did:key:...`) — works via `connectSpace()` + `loadManager`
  - [x] Lazy session creation per space (connect on first access)
  - [x] `.spaces.json` at root: known name->DID mapping
- [x] **1.3 Subscriptions and cache invalidation**
  - [x] Subscribe to cell changes via `cell.sink()` on load
  - [x] On change, rebuild affected subtree in in-memory tree
  - [x] `fuse_lowlevel_notify_inval_entry` for kernel cache invalidation
  - [x] Fallback to short timeouts if FUSE-T doesn't support notify
  - [ ] Unsubscribe after inactivity timeout (deferred)
- [x] **1.4 Extended attributes**
  - [x] `getxattr` callback for `user.json.type` per node
    (`string`, `number`, `boolean`, `null`, `object`, `array`)
  - [x] `listxattr` callback lists available xattrs
- [x] **1.5 Symlinks for cell references (read)**
  - [x] Detect sigil links (`{ "/": { "link@1": ... } }`) in cell values
  - [x] Map `id` + `path` + `space` to relative filesystem paths
  - [x] Handle same-space (relative to entity dir), cross-space (up to mount
    root), and self-referencing (id omitted) cases
  - [x] Create symlink `FsNode`s in the in-memory tree
  - [x] `readlink` callback returns the computed target path
- [x] **1.6 Metadata files**
  - [x] `meta.json` per piece (read-only): ID, entityId, pattern name
  - [x] `space.json` per space: DID, space name
  - [x] `pieces/.index.json`: name-to-ID mapping
  - [x] `entities/` directory for direct cell access by entity ID
- [x] **1.7 Event loop integration**
  - [x] Already solved by `nonblocking: true` + `threadSafe` callbacks
  - [x] WebSocket subscriptions + FUSE requests serviced concurrently

## Phase 2: Write Support

**Goal:** Write to files, create/delete entries. Full read-write filesystem.

- [x] **2.1 Write buffering**
  - [x] Track open file handles with per-handle write buffers
  - [x] `write` callback: append to buffer
  - [x] `flush`/`release`: process buffer, send cell write
- [x] **2.2 Scalar writes**
  - [x] Infer JSON type from written bytes (`true`->bool, `42`->number, etc.)
  - [x] Construct cell write at appropriate JSON path
  - [x] `cell.set()` / `cell.update()` via PieceManager
  - [x] Update in-memory tree optimistically
- [x] **2.3 JSON writes**
  - [x] `.json` file writes: parse as JSON, replace entire subtree
  - [x] Validate JSON before writing; `EINVAL` on parse failure
  - [x] Rebuild affected tree nodes
- [x] **2.4 Handler invocation**
  - [x] `result/<name>.handler` files: parse written JSON, call `stream.send()`
  - [x] Fire-and-forget (return success after send)
- [x] **2.5 Symlink writes (sigil links)**
  - [x] `symlink` callback: parse target path to `(space, id, path)` tuple
  - [x] Construct `SigilLink` JSON: `{ "/": { "link@1": { id, path, space } } }`
  - [x] Write sigil link at symlink location in parent cell
  - [x] Omit fields matching current context (same space, no path, etc.)
  - [x] Return `EINVAL` for targets that don't resolve within mountpoint
  - [ ] Writing sigil link JSON to `.json` files also produces symlinks
- [x] **2.6 Create and delete**
  - [x] `create` (new file in object dir): add key to parent
  - [x] `mkdir`: add key with `{}` value
  - [x] `unlink`/`rmdir`: remove key; re-index for array parents
  - [x] `rename`: remove old key + set new key; `EXDEV` for cross-cell
- [x] **2.7 Write reliability (bug fixes)**
  - [x] Fix `fuse_file_info.fh` offset: 24 bytes, not 16 (macOS 64-bit struct)
  - [x] Fix setattr truncation: NFS/FUSE-T sends `setattr(size=0)` without fh;
    truncate all open handles by inode
  - [x] Reject `._*` macOS resource fork files in `create` callback
  - [x] Defer subscription rebuilds via `setTimeout(0)` to prevent FUSE-T crash
    from `notify_inval_entry` during callbacks
  - [x] Fire-and-forget writes: reply to FUSE before `writeValue()` completes,
    so subscription rebuilds don't block the callback chain
  - [x] Optimistic tree updates: create/mkdir/symlink add nodes to tree before
    writing to cell; unlink/rmdir/rename remove from tree before cell write

## Phase 3: CLI Integration

**Goal:** `ct fuse mount/unmount/status` commands.

- [x] **3.1 CLI commands** — `packages/cli/commands/fuse.ts`
  - [x] `ct fuse mount <mountpoint> [--api-url, --identity, --space,
    --background, --debug]`
  - [x] `ct fuse unmount <mountpoint>`
  - [x] `ct fuse status` (list active mounts)
- [x] **3.2 Process management**
  - [x] Foreground: run in current process (default), Ctrl+C propagates
  - [x] Background (`--background`): spawn detached Deno process, PID file in
    `~/.ct/fuse/<hash>.json`
  - [x] `unmount`: SIGTERM + `umount`/`fusermount -u` fallback + cleanup
  - [x] `mod.ts` reads `CT_API_URL`/`CT_IDENTITY` env var fallbacks

## Phase 4: Polish

- [ ] **4.1 Graceful degradation**
  - [ ] Serve stale cache on toolshed disconnect
  - [ ] Background reconnection
  - [x] `.status` virtual file at root (apiUrl, startedAt, spaces + piece counts)
- [ ] **4.2 Performance tuning**
  - [ ] Profile `getattr` latency (target <1ms from cache)
  - [ ] Consider kernel page cache (`-o auto_cache`) with active invalidation
  - [ ] Tune subscription scope (subscribe/unsubscribe by access pattern)
- [x] **4.3 Entity view**
  - [x] `entities/` on-demand resolution: access any known entity by ID
  - [x] Both `<hash>` and `of:<hash>` forms supported
- [ ] **4.4 Testing**
  - [x] Unit: `tree-builder.ts` (36 tests — JSON types, circular refs, symlinks,
    handlers, stream values, sigil links)
  - [ ] Unit: `cell-bridge.ts` (mock PieceManager)
  - [ ] Integration: mount, perform ops, verify (requires FUSE in test env)
  - [ ] Fuzz: random JSON -> tree -> reads -> compare
- [ ] **4.5 Documentation**
  - [x] `packages/fuse/README.md` (210 lines — layout, usage, architecture)
  - [x] `ct fuse --help` with examples
  - [x] Troubleshooting: FUSE install, stale mounts, permissions, debug mode

---

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
| Deno FFI to libfuse doesn't work | Phase 0.1 is a spike to validate first. Fallback: npm:fuse-native or Rust sidecar |
| C struct layouts differ across platforms | Abstract behind `ffi-types.ts`, test on macOS + Linux early |
| macFUSE installation friction | Document FUSE-T as preferred (no kext); add install instructions |
| Single-threaded FUSE too slow | Unlikely for this workload. Escape hatch: SharedArrayBuffer + worker threads, or Rust sidecar |
| Deno event loop + FUSE fd integration | Phase 1.7 addresses explicitly. Worst case: busy-poll with short sleep |
| CI testing (FUSE requires privileges) | Docker with `--cap-add SYS_ADMIN --device /dev/fuse`, or skip mount tests in CI |
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
