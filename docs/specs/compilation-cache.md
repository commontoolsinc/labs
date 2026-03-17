# Compilation Cache Design

**Status**: Implemented
**Author**: Mike
**Date**: 2026-03-09

## Problem

Pattern compilation (TypeScript → JavaScript) is expensive: type-checking, AST
transforms, and AMD bundling take 100–500ms per pattern. Compiled JS was never
persisted — it lived only in an in-memory LRU cache (max 100 entries). Every
page reload, process restart, or cache eviction triggered a full recompilation
from source.

The in-memory cache provides single-flight deduplication and within-session
reuse, but the dominant cost is the first compilation of each pattern after a
page load. For pages that reference many patterns, this adds up to seconds of
blocking work in the runtime worker.

## Goals

1. **Survive page reloads**: A pattern compiled 5 minutes ago should not be
   recompiled after a reload.
2. **Correct invalidation**: When the compiler pipeline changes (transformers,
   type libs, bundler), stale cached JS must not be served.
3. **Isolation from compiler code**: Caching logic must not leak into the
   compiler, transformer, or bundler packages. The compiler should remain a pure
   `(Program, Options) → JsScript` function.
4. **Simple to disable**: A single configuration option turns off caching
   entirely, for debugging or rollback.
5. **Per-user scope**: Cache is not shared across users.

## Non-Goals

- Sharing compiled output across users (security boundary).
- Offline-first / service-worker caching (future work).
- Caching the evaluated `Pattern` object (it contains closures and is not
  serializable).

## Background

### Compilation Pipeline

`Engine` (`packages/runner/src/harness/engine.ts`) executes three steps for
each pattern:

```
1. Resolve     pretransformProgram() + EngineProgramResolver
               Adds file prefixes, injects helper imports, resolves .d.ts types
               ~5% of total time

2. Compile     TypeScriptCompiler.compile()
               Type-checking, CommonToolsTransformerPipeline, TS emit, AMD bundling
               ~90% of total time → produces JsScript { js, sourceMap, filename }

3. Evaluate    isolate.execute(jsScript).invoke(runtimeExports)
               Runs the compiled JS, triggers builder side-effects, produces Pattern
               ~5% of total time
```

**The cache targets step 1+2**: given the same input program and compiler
configuration, produce the same `JsScript` without re-running the TypeScript
compiler. Step 3 (evaluation) must always run because `Pattern` objects are
constructed as side-effects of executing the builder functions.

### Where Compilation Runs

The same `Engine` class runs in both environments:
- **Browser**: Inside a Web Worker, bundled by Felt/esbuild alongside the shell.
- **Server**: Inside the toolshed Deno process.

Both environments benefit from caching. The browser uses IndexedDB; the server
uses filesystem storage. Both share the same `CompilationCacheStorage` interface
and `CachedCompiler` orchestration — only the storage backend differs.

## Design

### Architecture Overview

```
PatternManager.compileOrGetPattern(program)
  │
  ├─ in-memory LRU hit? → return cached Pattern
  │
  └─ compilePattern(program)
       │
       └─ CachedCompiler.get(programHash)
            │
            ├─ cache hit? → CompileResult → evaluateToPattern() → Pattern
            │
            └─ cache miss → Engine.compile(program) → CompileResult
                              │
                              ├─ CachedCompiler.set(programHash, CompileResult)
                              └─ evaluateToPattern() → Pattern
```

Two components, external to the compiler:

1. **`CompilationCacheStorage`** — persistent key-value store for compiled JS.
2. **`CachedCompiler`** — orchestration layer that ties storage and a
   fingerprint string together, sitting between PatternManager and Engine.

The hot path (same pattern used multiple times in a session) hits the in-memory
LRU and never touches persistent storage.

### Cache Key

The `programHash` is the content hash of the input `RuntimeProgram`, computed
via `createRef({ src: program }, "pattern source")`.

`pretransformProgram()` adds a content-derived prefix (via `refer()`) to
filenames before compilation. Since both the cache key and the prefix are derived
from the same hash function, if `refer()` behavior ever changes, the cache key
changes too — resulting in a cache miss, not a stale hit. This is safe by
construction.

### Engine Refactor: compile() + evaluate()

`Engine.process()` originally interleaved compilation and evaluation. To allow
the cache to intercept compilation without infecting Engine internals, we split
it into `compile()` and `evaluate()`.

The cache stores `CompileResult { id, jsScript }` — not just `JsScript`. The
`id` field is critical: `compile()` derives a content-based id (via `refer()`)
that becomes a filename prefix in the compiled output. `evaluate()` needs this
same id to strip the prefix from export map keys. Caching `CompileResult`
ensures the id travels with the compiled output and is never recomputed —
avoiding mismatches if the hash function changes.

### Fingerprint

The fingerprint is a plain string, computed once at startup, that answers one
question: **"did any code I'm running change?"**

We treat the compiler as incompatibly different on any code change — we do not
try to distinguish compiler-affecting changes from non-compiler changes. This
over-invalidates slightly (e.g., a Cell.ts change busts the cache even though it
doesn't affect compilation), but the cost is just one recompilation pass —
equivalent to today's behavior with no cache. The benefit is zero risk of stale
output.

**Browser**: The runtime worker is bundled by Felt/esbuild into a single JS file
that includes all dependencies. If any source file changes, the bundle changes.
Felt computes SHA-256 of each output file and writes a manifest
(`dist/build-manifest.json`). The shell reads this at startup and passes the
worker bundle hash to the worker as the fingerprint.

**Server**: `computeGitFingerprint()` computes a fingerprint with this priority:

1. **`TOOLSHED_GIT_SHA`** env var — returned as-is. Used in Docker/binary
   deployments where the operator declares the deployed commit.
2. **Clean git repo** — returns HEAD SHA as-is.
3. **Dirty git repo** — returns `sha256(head + contentHash)` (opaque, since it
   combines HEAD with dirty file contents).
4. **No git, no env var** — returns `undefined`, cache is disabled.

In production and clean-tree scenarios (1, 2), the fingerprint is a recognizable
commit SHA — useful for tracing which server version compiled a cached entry.
Only during active local editing (3) is it an opaque hash. The explicit SHA
takes priority because when set, the operator is declaring the code identity.

### Key Design Decisions

**No error caching.** Compilation errors are not cached. Errors may be transient
(e.g., type definition loading race), and the cost of a redundant failed
compilation is bounded. Caching a failure risks masking an error that would
succeed on retry.

**No TTL.** The fingerprint is the source of truth for freshness. If the
fingerprint matches, the entry is valid regardless of age.

**Fingerprint-based eviction on startup.** On startup, `evictStale()` deletes
all entries whose fingerprint doesn't match the current one. This is the primary
invalidation mechanism.

**Count-based cap.** The cache checks entry count periodically and evicts the
oldest entries when it exceeds the limit (default 500). This prevents unbounded
growth in IndexedDB or the filesystem.

**Separate IndexedDB database.** The browser cache uses `ct-compilation-cache`,
not the runtime storage IDB, to keep the cache independently evictable and avoid
schema migration coordination.

**Atomic filesystem writes.** The server cache writes to a temp file then
renames into place, so concurrent reads never see partial entries.

### Disabling the Cache

Two independent env flags control caching, both defaulting to `true`:

- `COMPILATION_CACHE_SERVER` — controls server-side caching in toolshed.
- `COMPILATION_CACHE_CLIENT` — controls client-side caching in the browser
  (injected at build time via esbuild define in `felt.config.ts`).

```sh
# Disable server-side cache only
COMPILATION_CACHE_SERVER=false deno task dev-local

# Disable client-side cache only
COMPILATION_CACHE_CLIENT=false deno task dev-local

# Disable both
COMPILATION_CACHE_SERVER=false COMPILATION_CACHE_CLIENT=false deno task dev-local
```

If no fingerprint is available (e.g., no build manifest in the browser, or no
git/env var on the server), the cache is also disabled even if the flag is set.

## Implementation

```
packages/runner/src/compilation-cache/
  mod.ts                 # CachedCompiler orchestration, re-exports
  storage.ts             # CompilationCacheStorage interface
  idb-storage.ts         # IndexedDB implementation (browser)
  fs-storage.ts          # Filesystem implementation (server / Deno)
  memory-storage.ts      # In-memory implementation (tests)
  git-fingerprint.ts     # computeGitFingerprint() for server
```

Integration points:
- `packages/runner/src/pattern-manager.ts` — cache check in `compilePattern()`
- `packages/runner/src/runtime.ts` — `cachedCompiler` option, startup eviction
- `packages/toolshed/index.ts` — server-side construction
- `packages/runtime-client/backends/runtime-processor.ts` — browser-side construction
- `packages/felt/builder.ts` — build manifest generation
- `packages/shell/src/lib/runtime.ts` — manifest fetch, `buildHash` passthrough
