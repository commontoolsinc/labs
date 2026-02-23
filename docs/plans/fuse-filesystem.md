# Implementation Plan: FUSE Filesystem for Common Tools

**Spec:** [`docs/specs/fuse-filesystem/`](../specs/fuse-filesystem/README.md)
**Status:** Draft

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

- [ ] **0.1 FFI spike** — Validate Deno FFI to libfuse
  - [ ] `ffi.ts`: `Deno.dlopen()` for libfuse (`libfuse.dylib` / `libfuse3.so`)
  - [ ] `ffi-types.ts`: C struct layouts (`fuse_lowlevel_ops`, `stat`,
    `fuse_entry_param`, `fuse_file_info`)
  - [ ] Register `Deno.UnsafeCallback` for `lookup`, `getattr`, `readdir`,
    `read`, `open`, `release`
  - [ ] Hardcode a static tree (one dir, one file), mount, verify `ls`+`cat`
  - [ ] **Key risk:** Do callbacks work? Does single-threaded mode work?
    Does `fuse_reply_*` work from within the callback?
  - [ ] If spike fails: pivot to `npm:fuse-native` or Rust sidecar
- [ ] **0.2 In-memory tree** — `tree.ts` module
  - [ ] `FsTree` class: inode allocation, lookup by path, lookup by inode
  - [ ] `FsNode` union type: `Directory | File | Symlink`
  - [ ] Wire FUSE callbacks to read from tree instead of hardcoded values
  - [ ] `tree-builder.ts`: convert JSON value to `FsTree` subtree
    (object->dir, scalar->file, array->dir with numeric entries)
  - [ ] Mount a tree from a JSON literal, browse with `ls`/`cat`
- [ ] **0.3 Connect to live cells** — `cell-bridge.ts`
  - [ ] Reuse `loadManager()` from `packages/cli/lib/piece.ts`
  - [ ] Fetch piece list, build tree under `<space>/pieces/`
  - [ ] Lazy-load cell values on first access
  - [ ] `result.json` / `input.json` serve serialized cell data
  - [ ] `result/` / `input/` directories serve exploded JSON tree
  - [ ] `ls home/pieces/` shows real pieces, `cat .../result.json` returns
    real data

## Phase 1: Full Read Support

**Goal:** Complete read-only filesystem with subscriptions and multi-space.

- [ ] **1.1 `.json` siblings**
  - [ ] Synthesize `.json` file for every directory node
  - [ ] Handle in `lookup`, `getattr`, `read`
  - [ ] Nested: `result/items.json`, `result/items/0.json`, etc.
- [ ] **1.2 Multi-space root**
  - [ ] Mount root lists `home/` (always present)
  - [ ] `lookup` resolves any space name via `createSession({ spaceName })`
  - [ ] `lookup` resolves raw DIDs (`did:key:...`)
  - [ ] Lazy session creation per space (connect on first access)
  - [ ] `.spaces.json` at root: known name->DID mapping
- [ ] **1.3 Subscriptions and cache invalidation**
  - [ ] Subscribe to cell changes via WebSocket on first access
  - [ ] On change, rebuild affected subtree in in-memory tree
  - [ ] `fuse_lowlevel_notify_inval_inode` / `notify_inval_entry` for kernel
    cache invalidation
  - [ ] Unsubscribe after inactivity timeout
- [ ] **1.4 Extended attributes**
  - [ ] `getxattr` callback for `user.json.type` per node
    (`string`, `number`, `boolean`, `null`, `object`, `array`)
- [ ] **1.5 Symlinks for cell references (read)**
  - [ ] Detect sigil links (`{ "/": { "link@1": ... } }`) in cell values
  - [ ] Map `id` + `path` + `space` to relative filesystem paths
  - [ ] Handle same-space (relative to entity dir), cross-space (up to mount
    root), and self-referencing (id omitted) cases
  - [ ] Create symlink `FsNode`s in the in-memory tree
  - [ ] `readlink` callback returns the computed target path
- [ ] **1.6 Metadata files**
  - [ ] `meta.json` per piece (read-only): ID, pattern name, connections
  - [ ] `space.json` per space: DID, space name
  - [ ] `pieces/.index.json`: name-to-ID mapping
- [ ] **1.7 Event loop integration**
  - [ ] Integrate FUSE session fd with Deno event loop (no busy-wait)
  - [ ] `Deno.watchFd()` or poll-based approach
  - [ ] WebSocket subscriptions + FUSE requests serviced concurrently

## Phase 2: Write Support

**Goal:** Write to files, create/delete entries. Full read-write filesystem.

- [ ] **2.1 Write buffering**
  - [ ] Track open file handles with per-handle write buffers
  - [ ] `write` callback: append to buffer
  - [ ] `flush`/`release`: process buffer, send cell write
- [ ] **2.2 Scalar writes**
  - [ ] Infer JSON type from written bytes (`true`->bool, `42`->number, etc.)
  - [ ] Construct cell write at appropriate JSON path
  - [ ] `cell.set()` / `cell.update()` via PieceManager
  - [ ] Update in-memory tree optimistically
- [ ] **2.3 JSON writes**
  - [ ] `.json` file writes: parse as JSON, replace entire subtree
  - [ ] Validate JSON before writing; `EINVAL` on parse failure
  - [ ] Rebuild affected tree nodes
- [ ] **2.4 Handler invocation**
  - [ ] `handlers/<name>` files: parse written JSON, call `stream.send()`
  - [ ] Fire-and-forget (return success after send)
- [ ] **2.5 Symlink writes (sigil links)**
  - [ ] `symlink` callback: parse target path to `(space, id, path)` tuple
  - [ ] Construct `SigilLink` JSON: `{ "/": { "link@1": { id, path, space } } }`
  - [ ] Write sigil link at symlink location in parent cell
  - [ ] Omit fields matching current context (same space, no path, etc.)
  - [ ] Return `EINVAL` for targets that don't resolve within mountpoint
  - [ ] Writing sigil link JSON to `.json` files also produces symlinks
- [ ] **2.6 Create and delete**
  - [ ] `create` (new file in object dir): add key to parent
  - [ ] `mkdir`: add key with `{}` value
  - [ ] `unlink`/`rmdir`: remove key; re-index for array parents
  - [ ] `rename`: remove old key + set new key; `EXDEV` for cross-cell

## Phase 3: CLI Integration

**Goal:** `ct fuse mount/unmount/status` commands.

- [ ] **3.1 CLI commands** — `packages/cli/commands/fuse.ts`
  - [ ] `ct fuse mount <mountpoint> [--api-url, --identity, --foreground,
    --debug, --read-only]`
  - [ ] `ct fuse unmount <mountpoint>`
  - [ ] `ct fuse status` (list active mounts)
- [ ] **3.2 Process management**
  - [ ] `--foreground`: run in current process (default for now)
  - [ ] Background: spawn detached Deno process, PID file in
    `~/.ct/fuse/<hash>.pid`
  - [ ] `unmount`: SIGTERM + `fusermount -u` + cleanup

## Phase 4: Polish

- [ ] **4.1 Graceful degradation**
  - [ ] Serve stale cache on toolshed disconnect
  - [ ] Background reconnection
  - [ ] `.status` virtual file at root
- [ ] **4.2 Performance tuning**
  - [ ] Profile `getattr` latency (target <1ms from cache)
  - [ ] Consider kernel page cache (`-o auto_cache`) with active invalidation
  - [ ] Tune subscription scope (subscribe/unsubscribe by access pattern)
- [ ] **4.3 Entity view**
  - [ ] `entities/` subtree for direct entity ID access
- [ ] **4.4 Testing**
  - [ ] Unit: `tree-builder.ts` (JSON -> tree -> JSON round-trips)
  - [ ] Unit: `cell-bridge.ts` (mock PieceManager)
  - [ ] Integration: mount, perform ops, verify (requires FUSE in test env)
  - [ ] Fuzz: random JSON -> tree -> reads -> compare
- [ ] **4.5 Documentation**
  - [ ] `packages/fuse/README.md`
  - [ ] `ct fuse --help` with examples
  - [ ] Troubleshooting: macFUSE/FUSE-T install, permissions, common errors

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
