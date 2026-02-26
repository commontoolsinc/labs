# 5. Architecture

## System Overview

```
                    macOS / Linux
                         |
                  FUSE kernel module
                   (macFUSE / FUSE-T / Linux FUSE)
                         |
                    /dev/fuse fd
                         |
              +---------------------------+
              |      Deno Process          |   packages/fuse/
              |                            |
              |  libfuse (via Deno.dlopen) |
              |   - single-threaded mode   |
              |   - session fd polling     |
              |                            |
              |  In-memory FS tree         |
              |   - inode management       |
              |   - JSON-to-tree mapping   |
              |   - write buffering        |
              |                            |
              |  Session / Runtime         |
              |   - PieceManager           |
              |   - Cell read/write        |
              |   - Subscriptions          |
              +---------------------------+
                         |
                    HTTP / WebSocket
                         |
              +---------------------------+
              |      Toolshed API          |   (existing)
              +---------------------------+
```

## Single-Process FFI Approach

The filesystem runs as a single Deno process that calls libfuse via
`Deno.dlopen()`. All logic — FUSE operations, cell access, caching, inode
management — lives in TypeScript.

### Why Single-Process?

- **One language, one build system.** No Rust toolchain, no Cargo, no
  cross-language data duplication. Everything stays in the Deno monorepo.
- **No IPC overhead.** The in-memory tree is directly accessible from FUSE
  callbacks. No serialization, no Unix sockets, no JSON-RPC protocol to
  design and debug.
- **Simpler deployment.** `ct fuse mount` runs one process. No coordinating
  startup/shutdown of two daemons.
- **Easier debugging.** Single stack trace, single log stream, standard Deno
  debugging tools.

### How FFI Works

libfuse provides a C API where you register callback functions for each
filesystem operation. Deno's FFI (`Deno.dlopen`) can load libfuse and
register `Deno.UnsafeCallback` instances as those callbacks.

#### Threading Model

libfuse normally uses a thread pool, but FUSE callbacks from non-main threads
cannot safely access the Deno JS heap. Two viable approaches:

**Option A — Single-threaded mode (recommended for v1):**

libfuse supports single-threaded operation (`-s` flag / `FUSE_SINGLE_THREAD`).
In this mode, all FUSE requests are dispatched sequentially on one thread. We
use `fuse_session_fd()` to get the FUSE file descriptor and integrate it with
Deno's event loop:

```typescript
const fuseSessionFd = fuse_session_fd(session);

// Poll the FUSE fd alongside Deno's event loop
while (mounted) {
  // Process pending FUSE requests (non-blocking)
  fuse_session_process_buf(session, buf);

  // Yield to Deno event loop for async work (subscriptions, etc.)
  await new Promise((resolve) => setTimeout(resolve, 0));
}
```

All FUSE callbacks run on the main thread and can directly access the
in-memory tree. No thread safety concerns. The tradeoff is no parallelism
for FUSE operations, which is fine for this use case — we're serving `cat`
and `ls` against cached JSON, not high-throughput I/O.

**Option B — Worker threads with SharedArrayBuffer:**

For higher throughput, the in-memory tree could be backed by a
`SharedArrayBuffer` that FUSE worker threads read from. Writes and cache
updates still go through the main thread. This is significantly more
complex and only worth pursuing if single-threaded mode proves too slow.

### FFI Surface

The FFI layer needs to bind a relatively small subset of libfuse:

```typescript
// Core session lifecycle
fuse_session_new(args, ops, ops_size, userdata): FuseSession
fuse_session_mount(session, mountpoint): number
fuse_session_unmount(session): void
fuse_session_destroy(session): void
fuse_session_fd(session): number
fuse_session_exited(session): boolean

// Request processing
fuse_session_process_buf(session, buf): void
fuse_session_receive_buf(session, buf): number

// Reply functions (called from within callbacks)
fuse_reply_entry(req, entry): number
fuse_reply_attr(req, attr, timeout): number
fuse_reply_readlink(req, link): number
fuse_reply_open(req, fi): number
fuse_reply_write(req, count): number
fuse_reply_buf(req, buf, size): number
fuse_reply_err(req, errno): number
```

The `fuse_lowlevel_ops` struct contains function pointers for each operation.
We populate it with `Deno.UnsafeCallback` instances for the operations we
support.

### Platform Differences

| | macOS | Linux |
|---|-------|-------|
| Provider | macFUSE or FUSE-T | Native kernel FUSE |
| Library | `libfuse.dylib` (v2.9) | `libfuse3.so` (v3) |
| API | FUSE v2 low-level | FUSE v3 low-level |
| xattr errors | `ENOATTR` | `ENODATA` |
| Install | User installs macFUSE/FUSE-T | Usually pre-installed |

The FFI bindings need a thin compatibility layer to handle v2 vs v3
differences. FUSE-T is preferred on macOS (no kernel extension required).

## Alternative: Rust FUSE Daemon + IPC

If FFI proves too limiting (e.g., threading becomes necessary, or libfuse's
C API is too painful to bind), a fallback architecture splits the work:

```
              +---------------------+
              |   Rust FUSE Layer   |   packages/fuse-daemon/
              |   (fuser crate)     |
              +---------------------+
                         |
                    IPC (JSON-RPC over Unix socket)
                         |
              +---------------------+
              |   Deno Service      |   packages/fuse/
              +---------------------+
```

The Rust layer (`fuser` crate) handles FUSE operations from its own in-memory
tree. The Deno layer handles all cell/space logic and pushes updates via
JSON-RPC over a Unix socket.

**When to consider this:**
- Single-threaded FUSE can't keep up with the workload
- libfuse FFI bindings are too fragile across macOS/Linux
- The C struct layouts are too painful to maintain by hand

**Cost:**
- Second language and build system (Cargo)
- IPC protocol design and maintenance
- Data duplication (tree in both processes)
- Two-process lifecycle management

## Alternative: npm:fuse-native

Deno supports npm packages via `npm:` specifiers. `fuse-native` provides
N-API bindings to libfuse with multithreaded support:

```typescript
import Fuse from "npm:fuse-native";
```

**When to consider this:** If it works out of the box with Deno's npm compat.
Worth a quick spike before committing to raw FFI.

**Risk:** N-API native addon compatibility with Deno is not guaranteed.
`fuse-native` is a C++ addon that may not load. The SageMath fork
(`@sagemathinc/fuse-native`) is the most actively maintained version.

## Package Structure

```
packages/
  fuse/                          # Deno package (new)
    deno.json
    mod.ts                       # Entry point
    ffi.ts                       # libfuse FFI bindings
    ffi-types.ts                 # C struct definitions for Deno FFI
    fs.ts                        # FUSE operation handlers
    tree.ts                      # In-memory filesystem tree + inode mgmt
    tree-builder.ts              # JSON value -> FsNode conversion
    cell-bridge.ts               # Maps FUSE ops to cell ops
    types.ts                     # Shared types
    cli.ts                       # CLI command handlers (mount/unmount)
    tests/
      tree-builder.test.ts
      cell-bridge.test.ts
      fs.test.ts
  cli/
    commands/fuse.ts             # ct fuse subcommand (new)
```

## CLI Integration

The FUSE filesystem is accessed via the existing `ct` CLI:

```bash
ct fuse mount <mountpoint> [options]
ct fuse unmount <mountpoint>
ct fuse status
```

Options:
- `--api-url <url>` — toolshed API URL
- `--identity <keyfile>` — identity for authentication
- `--foreground` — run in foreground (don't daemonize)
- `--debug` — enable FUSE debug logging
- `--read-only` — mount as read-only

All accessible spaces are exposed under the single mountpoint. The home space
is always listed; other spaces are accessible by name or DID on demand (see
[Path Scheme](./2-path-scheme.md#listing-vs-lookup)).

The `mount` command:
1. Connects to toolshed, loads identity
2. Loads libfuse via `Deno.dlopen()`
3. Registers FUSE callbacks
4. Mounts the filesystem
5. Enters the FUSE event loop (integrated with Deno's event loop)
6. Daemonizes (unless `--foreground`)

Sessions for individual spaces are created lazily on first access.

---

**Previous:** [Read/Write Semantics](./4-read-write.md) | **Next:** [Reactivity and Caching](./6-reactivity.md)
