# Compilation Cache Design

**Status**: Implemented
**Author**: Mike
**Date**: 2026-03-09

## Problem

Pattern compilation (TypeScript → JavaScript) is expensive: type-checking, AST
transforms, and AMD bundling take 100–500ms per pattern. Today, compiled JS is
never persisted — it lives only in an in-memory LRU cache
(`PatternManager.patternIdMap`, max 100 entries). Every page reload, process
restart, or cache eviction triggers a full recompilation from source.

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
   `(Program, Options) → JsScript` function. The build tool (Felt) does gain a
   small addition (manifest generation) to support fingerprinting — this is an
   accepted tradeoff for correct local-dev invalidation.
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

`Engine.process()` (`packages/runner/src/harness/engine.ts`) executes three
steps for each pattern:

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

### Existing Caching

`PatternManager` already provides:
- **In-memory LRU** (`patternIdMap`): maps `patternId` → compiled `Pattern`,
  max 100 entries. Keyed by content hash of the source program via `createRef()`.
- **Single-flight dedup** (`inProgressCompilations`): concurrent requests for
  the same pattern share one compilation promise.
- **Persistent metadata** (`PatternMeta` cells): stores source code in the
  user's memory space, but *not* compiled output.

### Existing Build Hash Infrastructure

`COMMIT_SHA` is already injected at build time:
- **CI**: GitHub Actions sets `COMMIT_SHA=${{ github.sha }}`
- **Build**: `tasks/build-binaries.ts` passes it as an env var
- **Bundle**: `felt.config.ts` maps it to esbuild define `$COMMIT_SHA`
- **Runtime**: Available as `COMMIT_SHA` in `packages/shell/src/lib/env.ts`
- **Worker**: The runtime worker is bundled by the same Felt pipeline, so the
  define is available there too.

For local dev builds, `COMMIT_SHA` falls back to the build mode string
(`"development"` or `"production"`).

### Where Compilation Runs

The same `Engine` class runs in both environments:
- **Browser**: Inside a Web Worker (`runtime-client/backends/web-worker/`),
  bundled by Felt/esbuild alongside the shell.
- **Server**: Inside the toolshed Deno process (`packages/toolshed/index.ts`).

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

Two new components, all external to the compiler:

1. **`CompilationCacheStorage`** — persistent key-value store for compiled JS.
2. **`CachedCompiler`** — orchestration layer that ties storage and a
   fingerprint string together, sitting between PatternManager and Engine.

### Component Design

#### Fingerprint

The fingerprint is a plain string, computed once at startup, that answers one
question: **"did any code I'm running change?"**

We treat the compiler as incompatibly different on any code change — we do not
try to distinguish compiler-affecting changes from non-compiler changes. This
over-invalidates slightly (e.g., a Cell.ts change busts the cache even though it
doesn't affect compilation), but the cost is just one recompilation pass —
equivalent to today's behavior with no cache. The benefit is zero risk of stale
output.

The mechanism differs per environment, but the semantics are identical:

**Browser (worker bundle hash)**:

The runtime worker is bundled by Felt/esbuild into a single JS file that
includes all dependencies — compiler, transformers, type libs, runtime, and
everything else. If any source file changes, the bundle changes.

After Felt builds the output, it computes SHA-256 of each output file and writes
a small manifest (`dist/build-manifest.json`). The shell reads this manifest at
startup, extracts the worker bundle hash, and passes it to the worker via
`InitializationData.buildHash`. The worker uses this as its fingerprint.

```json
// dist/build-manifest.json (generated by Felt post-build)
{
  "scripts/worker-runtime.js": "a1b2c3..."
}
```

This requires a small addition to Felt's `Builder.build()`: after writing output
files, compute and write the manifest. No build splitting needed. The manifest
generation, the `buildHash` field on `InitializationData`, and the manifest
fetch in the shell exist solely to support compilation cache invalidation.
Each touch point should reference this spec in code comments so they can be
cleanly removed if the caching mechanism changes.

**Server (git state hash)**:

The server runs Deno directly from source (no bundle). At process startup,
compute a fingerprint from the git state:

```
fingerprint = hash(HEAD_sha + sorted_hash(dirty file contents))
```

Specifically:
1. `git rev-parse HEAD` — captures all committed changes.
2. `git diff --name-only HEAD` — lists uncommitted changed files (staged and
   unstaged) vs the current commit. This includes modified, added, and deleted
   files.
3. `git ls-files --others --exclude-standard` — lists untracked files (new
   files not yet committed).
4. For each dirty/untracked file that still exists on disk, read its contents.
   For deleted files, include the path name in the hash (the deletion itself is
   a change). Sort all entries by path for determinism.
5. Concatenate HEAD SHA + dirty file hash → final fingerprint.

We do not filter by file extension — consistent with the design principle that
any code change invalidates the cache. A change to `deno.json`, `.tsx`, or any
other file type is treated as potentially output-affecting.

This covers:
- `git pull` with new commits → HEAD changes → cache invalidated.
- Uncommitted edits to any file → dirty hash changes → cache invalidated.
- New untracked files → included in dirty hash → cache invalidated.
- Deleted files → path included in hash → cache invalidated.
- Clean working tree → fingerprint = hash(HEAD) → stable across restarts.
- **Library dependencies**: `deno.lock` is committed to the repo, so any
  dependency version change (add, update, or remove) changes either HEAD or the
  dirty file set — no special handling needed.

Computed once at process startup. Cost is negligible: one `git` invocation plus
reading a handful of dirty files (typically 0-5 in practice).

If git is not available (e.g., Docker deployment with no `.git` directory),
`computeGitFingerprint()` returns `undefined`. No fallback — the cache is
simply disabled for that process. This is the correct behavior: without git
we have no way to detect code changes, so we shouldn't serve cached output.

```typescript
// Server fingerprint computation (Deno)
// Returns undefined when not in a git repository.
async function computeGitFingerprint(): Promise<string | undefined> {
  try {
    const head = await exec("git rev-parse HEAD");
    const dirty = await exec("git diff --name-only HEAD");
    const untracked = await exec(
      "git ls-files --others --exclude-standard"
    );
    const dirtyFiles = [...dirty.split("\n"), ...untracked.split("\n")]
      .filter((f) => f.length > 0)
      .sort();
    let contentHash = "";
    if (dirtyFiles.length > 0) {
      const parts: string[] = [];
      for (const f of dirtyFiles) {
        try {
          parts.push(f + ":" + await Deno.readTextFile(f));
        } catch {
          // File was deleted — include path so deletion changes the hash
          parts.push(f + ":DELETED");
        }
      }
      contentHash = await sha256(parts.join("\n"));
    }
    return sha256(head + contentHash);
  } catch {
    // Not in a git repository — cache disabled
    return undefined;
  }
}
```

**Disabling the cache**: Two independent env flags control caching, both
defaulting to `false` (off):

- `COMPILATION_CACHE_SERVER=true` — enables server-side caching in toolshed.
- `COMPILATION_CACHE_CLIENT=true` — enables client-side caching in the browser
  (injected at build time via esbuild define in `felt.config.ts`).

If no fingerprint is available (e.g., `buildHash` not provided in
`InitializationData`, or no git repo on the server), the cache is also disabled
even if the flag is set. All cache code paths are guarded by
`if (this.cachedCompiler)` checks, so the absence of the object means no
caching — identical to today's behavior.

#### CompilationCacheStorage (interface)

```typescript
// packages/runner/src/compilation-cache/storage.ts

import { JsScript } from "@commontools/js-compiler";

interface CompilationCacheEntry {
  /** Content-derived id used as the filename prefix during compilation.
   *  Must be passed to evaluate() so it can correctly strip the prefix
   *  from export map keys. */
  id: string;
  /** Full JsScript including source maps. */
  jsScript: JsScript;
  fingerprint: string;
  /** Timestamp for diagnostics / count-based eviction. */
  cachedAt: number;
}

interface CompilationCacheStorage {
  get(programHash: string): Promise<CompilationCacheEntry | undefined>;
  set(programHash: string, entry: CompilationCacheEntry): Promise<void>;
  /** Delete all entries not matching the given fingerprint. Returns number evicted. */
  evictStale(currentFingerprint: string): Promise<number>;
  /** Delete oldest entries until at most `keepCount` remain. Returns number evicted. */
  evictOldest(keepCount: number): Promise<number>;
  /** Delete all entries. */
  clear(): Promise<void>;
  /** Return the number of entries in the cache. */
  count(): Promise<number>;
}
```

The `programHash` is the content hash of the input `RuntimeProgram`, computed
the same way PatternManager already does (`createRef({ src: program }, ...)`).

Note: `pretransformProgram()` adds a content-derived prefix (via `refer()`) to
filenames before compilation. Since both the cache key and the prefix are derived
from the same hash function, if `refer()` behavior ever changes, the cache key
changes too — resulting in a cache miss, not a stale hit. This is safe by
construction.

The `fingerprint` is stored alongside the entry so that `get()` can verify
freshness: if the stored fingerprint doesn't match the current one, it's a
miss.

**IndexedDB implementation** (implement now):

```typescript
class IDBCompilationCache implements CompilationCacheStorage {
  // Uses a dedicated IndexedDB database (not the runtime storage IDB)
  // to avoid coupling and allow independent schema evolution.
  //
  // Object store: "compiled"
  //   key: programHash (string)
  //   value: CompilationCacheEntry
  //   index: "by-fingerprint" on fingerprint field (for evictStale)
}
```

Uses a separate IndexedDB database (e.g., `ct-compilation-cache`) rather than
the existing runtime storage IDB, to keep the cache independently evictable
and avoid schema migration coordination.

**Filesystem implementation** (for toolshed / Deno server):

```typescript
class FileSystemCompilationCache implements CompilationCacheStorage {
  // Writes JSON files to a cache directory, keyed by programHash.
  // e.g., ${cacheDir}/${programHash}.json
  //
  // cacheDir is configured via COMPILATION_CACHE_FS_DIR env var
  // (default: /tmp/ct-compilation-cache). In multi-process environments
  // (e.g. common-cluster), use distinct directories per process.
  //
  // evictStale(): iterate directory, read fingerprint from each entry,
  //   delete non-matching files.
}
```

Simple flat directory of JSON files. No database dependency. The filesystem
naturally handles concurrent reads. For concurrent writes from multiple
processes, we rely on atomic rename (write to temp, rename into place).

**In-memory implementation** (for tests):

```typescript
class MemoryCompilationCache implements CompilationCacheStorage {
  private store = new Map<string, CompilationCacheEntry>();
  // ...
}
```

#### CachedCompiler (orchestration)

```typescript
// packages/runner/src/compilation-cache/mod.ts

class CachedCompiler {
  constructor(
    private cache: CompilationCacheStorage,
    private fingerprint: string,
    maxEntries?: number,        // default 500
    evictionInterval?: number,  // default 50 (writes between count checks)
  ) {}

  /**
   * Returns cached CompileResult for the given program, or undefined on miss.
   * Caller is responsible for compilation on miss and calling set().
   * Tracks miss reasons: notFound vs fingerprintMismatch.
   */
  async get(programHash: string): Promise<CompileResult | undefined> {
    const entry = await this.cache.get(programHash);
    if (!entry) {
      this.stats.misses++;
      this.stats.missReasons.notFound++;
      return undefined;
    }
    if (entry.fingerprint !== this.fingerprint) {
      this.stats.misses++;
      this.stats.missReasons.fingerprintMismatch++;
      return undefined;
    }
    this.stats.hits++;
    return { id: entry.id, jsScript: entry.jsScript };
  }

  async set(programHash: string, result: CompileResult): Promise<void> {
    // Logs errors internally via logger.warn — caller swallows rejection.
    await this.cache.set(programHash, {
      id: result.id,
      jsScript: result.jsScript,
      fingerprint: this.fingerprint,
      cachedAt: Date.now(),
    });
    this.stats.writes++;
    this.maybeEvictByCount();  // fire-and-forget count-based eviction
  }

  /** Evict entries from previous compiler versions. Call on startup. */
  async evictStale(): Promise<void> { ... }

  /** Get current stats snapshot. */
  getStats(): Readonly<CachedCompilerStats> { ... }

  /** Get the fingerprint in use. */
  getFingerprint(): string { ... }
}
```

Construction differs per environment, but the `CachedCompiler` itself is
environment-agnostic. Both are gated on opt-in env flags:

```typescript
// Browser (in RuntimeProcessor.initialize):
// Only constructed when COMPILATION_CACHE_CLIENT=true AND buildHash is present.
const cachedCompiler = data.buildHash
  ? new CachedCompiler(new IDBCompilationCache(), data.buildHash)
  : undefined;

// Server (in toolshed startup):
// Only constructed when COMPILATION_CACHE_SERVER=true AND git fingerprint available.
const fingerprint = await computeGitFingerprint();
const cachedCompiler = fingerprint
  ? new CachedCompiler(
      new FileSystemCompilationCache(env.COMPILATION_CACHE_FS_DIR),
      fingerprint,
    )
  : undefined;
```

### Engine Refactor

`Engine.process()` originally interleaved compilation and evaluation. To allow
the cache to intercept compilation without infecting Engine internals, we split
`process()` into two phases that return a `CompileResult`:

```typescript
/** Result of compile(): the compiled JS and the id used for prefix stripping. */
interface CompileResult {
  /** Content-derived id used as the filename prefix during compilation.
   *  Must be passed to evaluate() so it can correctly strip the prefix
   *  from export map keys. */
  id: string;
  jsScript: JsScript;
}

// Compile only, no evaluation. Returns CompileResult (id + jsScript).
async compile(
  program: RuntimeProgram,
  options?: TypeScriptHarnessProcessOptions,
): Promise<CompileResult> {
  const id = options?.identifier ?? computeId(program);
  // ... resolve, transform, compile ...
  return { id, jsScript };
}

// Evaluate pre-compiled JS.
// `id` and `files` are the values from compilation — pass them through.
async evaluate(
  id: string,
  jsScript: JsScript,
  files: Source[],
): Promise<{ main?: Exports; exportMap?: Record<string, Exports> }> {
  // ... execute jsScript, build export map, strip id prefix ...
}

// TODO(@mpsalisbury): run() and process() are no longer called by
// PatternManager — it now uses compile() + evaluate() directly.
// Remove from Engine and Harness interface.
```

The `id` field is critical: `compile()` derives a content-based id (via
`refer()`) that becomes a filename prefix in the compiled output.
`evaluate()` needs this same id to strip the prefix from export map keys.
Caching `CompileResult` (not just `JsScript`) ensures the id travels with the
compiled output and is never recomputed — avoiding mismatches if the hash
function changes.

This refactor is valuable independent of caching — it makes the compilation
pipeline more testable and composable.

### Integration with PatternManager

The cache integrates at `PatternManager.compilePattern()`. Both the cache-hit
and cache-miss paths use the same `evaluateToPattern()` helper, which calls
`harness.evaluate()` and extracts the named export:

```typescript
async compilePattern(input: string | RuntimeProgram): Promise<Pattern> {
  let program: RuntimeProgram = /* normalize input */;

  const { cachedCompiler } = this.runtime;
  if (cachedCompiler) {
    const programHash = createRef({ src: program }, "pattern source").toString();
    let compileResult = await cachedCompiler.get(programHash);
    if (!compileResult) {
      compileResult = await this.runtime.harness.compile(program);
      // Fire-and-forget cache write.
      // CachedCompiler.set() logs errors internally via logger.warn,
      // so the caller swallows the rejection silently.
      cachedCompiler.set(programHash, compileResult).catch(() => {});
    }
    return this.evaluateToPattern(compileResult, program);
  }

  // No persistent cache — compile and evaluate directly
  const compileResult = await this.runtime.harness.compile(program);
  return this.evaluateToPattern(compileResult, program);
}

private async evaluateToPattern(
  { id, jsScript }: CompileResult,
  program: RuntimeProgram,
): Promise<Pattern> {
  const { main } = await this.runtime.harness.evaluate(
    id, jsScript, program.files,
  );
  const exportName = program.mainExport ?? "default";
  if (main && !(exportName in main)) {
    throw new Error(`No "${exportName}" export found in compiled pattern.`);
  }
  const pattern = main![exportName] as Pattern;
  pattern.program = program;
  return pattern;
}
```

**Call chain**: `compileOrGetPattern()` checks the in-memory LRU first. On a
miss, it calls `compilePattern()`, which is where the persistent cache lives.
So the full lookup order is:

1. `compileOrGetPattern()` — in-memory LRU hit? → return cached `Pattern`
2. `compilePattern()` — persistent cache hit? → `evaluate()` → `Pattern`
3. `compilePattern()` — persistent cache miss → `Engine.compile()` → cache →
   `evaluate()` → `Pattern`

The hot path (same pattern used multiple times in a session) never touches
IndexedDB.

### Compatibility with compile-and-run Builtin

The `compileAndRun` builtin (`packages/runner/src/builtins/compile-and-run.ts`)
uses its own `refer(program)` hash (line 136) to avoid re-triggering compilation
when the same inputs arrive. This is a higher-level dedup — it short-circuits
before calling `compileOrGetPattern()` at all. The compilation cache sits inside
`compilePattern()`, which is called by `compileOrGetPattern()` on an in-memory
miss. These two dedup mechanisms are independent and compose correctly:

1. `compileAndRun` dedup: "have I already dispatched this program?" → skip
2. `compileOrGetPattern` in-memory LRU: "is the Pattern in memory?" → return it
3. `compilePattern` persistent cache: "is the JsScript on disk?" → evaluate it

No changes needed to `compile-and-run.ts`.

### Harness Interface Change

`Engine` is the only `Harness` implementation in the codebase, so adding methods
to the interface is safe. The `Harness` interface (`harness/types.ts`) gains
`compile` and `evaluate` methods:

```typescript
interface Harness extends EventTarget {
  // TODO(@mpsalisbury): No longer called — remove from interface and Engine.
  run(source: RuntimeProgram, options?: TypeScriptHarnessProcessOptions): Promise<Pattern>;

  // Compile without evaluation — returns CompileResult { id, jsScript }
  compile(source: RuntimeProgram, options?: TypeScriptHarnessProcessOptions): Promise<CompileResult>;
  // Evaluate pre-compiled JS — id and files from compile(), not recomputed
  evaluate(id: string, jsScript: JsScript, files: Source[]): Promise<{ main?: Exports; exportMap?: Record<string, Exports> }>;

  resolve(source: ProgramResolver): Promise<Program>;
  invoke(fn: () => any): any;
  getInvocation(source: string): HarnessedFunction;
}
```

### InitializationData Change

Add a `buildHash` field to `InitializationData` (in
`runtime-client/protocol/types.ts`). The shell reads the worker bundle hash from
the build manifest and passes it to the worker during initialization:

```typescript
export interface InitializationData {
  // ... existing fields ...
  /** Content hash of the worker bundle, used for compilation cache
   *  invalidation. If absent, the compilation cache is disabled. */
  buildHash?: string;
}
```

If `buildHash` is present, the worker constructs a `CachedCompiler` with it. If
absent, no `CachedCompiler` is created — caching is simply not active (graceful
degradation, identical to today's behavior).

### Cache Lifecycle

1. **Initialization**: The `CachedCompiler` is created externally (in toolshed
   startup or the runtime worker) and passed to `Runtime` via the
   `cachedCompiler` option. `Runtime` stores it and makes it available to
   `PatternManager` via `this.runtime.cachedCompiler`.
2. **Eager eviction**: The `Runtime` constructor fires `evictStale()` as a
   fire-and-forget promise. Errors are logged via `console.warn` but do not
   block startup. This clears entries from previous compiler versions.
3. **Reads**: On every `compilePattern()` call, check persistent cache after
   in-memory miss.
4. **Writes**: After successful compilation, write to cache (fire-and-forget).
   `CachedCompiler.set()` logs write errors internally via `logger.warn`.
5. **Size management**: See [Eviction Strategy](#eviction-strategy).

### Eviction Strategy

Neither IndexedDB nor a filesystem cache directory have built-in size limits, so
we manage our own. The strategy is the same for both backends:

- **Fingerprint-based eviction**: On startup, delete all entries whose
  fingerprint doesn't match the current one. This is the primary invalidation
  mechanism.
- **Count-based cap**: `CachedCompiler` checks the entry count every N writes
  (default 50, configurable via constructor). If the cache exceeds the max
  entries (default 500, configurable via constructor), it first tries stale
  eviction, then evicts oldest entries by `cachedAt` via `evictOldest()`.
  Every count-based eviction is logged at `warn` level with the number of
  entries evicted and the current cap.
- **Manual clear**: Expose a `clearCompilationCache()` for debugging. Could be
  wired to a dev tools button in the browser, or a CLI command for the server.

No TTL-based eviction for now. The fingerprint is the source of truth for
freshness. If the fingerprint matches, the entry is valid regardless of age.

### Disabling the Cache

The cache is disabled by not constructing a `CachedCompiler`. Both environments
require an explicit opt-in env flag (defaulting to `false`):

- **Browser**: Set `COMPILATION_CACHE_CLIENT=true` to enable. The flag is
  injected at build time via esbuild define in `felt.config.ts`. Even when
  enabled, if `InitializationData.buildHash` is absent (no build manifest),
  no cache is created.
- **Server**: Set `COMPILATION_CACHE_SERVER=true` to enable. Even when enabled,
  if no git fingerprint is available, no cache is created. The cache directory
  is configurable via `COMPILATION_CACHE_FS_DIR` (default:
  `/tmp/ct-compilation-cache`).
- **Tests**: Don't provide a `CachedCompiler` to the Runtime — tests run with
  no persistent cache by default (same as today).

### Observability

Cache state must not be invisible. `CachedCompiler` tracks stats internally
and exposes them via `getStats()`:

```typescript
interface CachedCompilerStats {
  hits: number;
  misses: number;
  missReasons: { notFound: number; fingerprintMismatch: number };
  writes: number;
  writeErrors: number;
  countEvictions: number;
}
```

On startup, `evictStale()` logs a one-line summary at `info` level:
```
[compilation-cache] fingerprint=a1b2c3 entries=142 evicted=38
```

Both client and server log whether the cache is enabled or disabled at startup:
```
Compilation cache enabled (server), fingerprint=a1b2c3d4
Compilation cache disabled (client): COMPILATION_CACHE_CLIENT not set
```

Future work: expose stats via `RuntimeTelemetryMarker` events for the scheduler
inspector UI and dashboards.

### Error Caching

Compilation errors are not cached. Errors may be transient (e.g., type
definition loading race), and the cost of a redundant failed compilation is
bounded. Caching a failure risks masking an error that would succeed on retry.

### Cache Size Estimation

Rough estimate: A typical compiled pattern produces ~10-50KB of JS + source map.
At 500 entries, that's 5-25MB of IndexedDB storage. Well within browser quotas
(typically 50MB+ per origin). Actual size should be tracked via the
observability stats above so growth can be monitored.

## Implementation Plan

All phases are complete.

### Phase 1: Engine Refactor (no caching yet) -- DONE

1. Split `Engine.process()` into `compile()` + `evaluate()`.
2. Update `Harness` interface with `CompileResult` type.
3. `run()` and `process()` remain but are marked for removal (TODO).
4. All existing tests pass.

### Phase 2: Cache Infrastructure -- DONE

1. `CompilationCacheStorage` interface with `evictStale`, `evictOldest`, `count`.
2. `CachedCompiler` with stats tracking, count-based eviction, miss reasons.
3. `IDBCompilationCache` (browser).
4. `FileSystemCompilationCache` (server / Deno).
5. `MemoryCompilationCache` (for tests).
6. `computeGitFingerprint()` for server-side fingerprint.

### Phase 3: Browser Fingerprint -- DONE

1. Post-build manifest generation in Felt's `Builder.build()`.
2. `buildHash` field on `InitializationData`.
3. Shell reads manifest at startup, passes hash to worker.

### Phase 4: Integration -- DONE

1. `CachedCompiler` wired into `PatternManager` via `Runtime.cachedCompiler`.
2. `compilePattern()` uses unified `compile()` + `evaluateToPattern()` flow.
3. Startup eviction via fire-and-forget `evictStale()` in Runtime constructor.
4. Opt-in env flags: `COMPILATION_CACHE_SERVER`, `COMPILATION_CACHE_CLIENT`.
5. Startup logging on both client and server.
6. Integration tests for cache hit/miss and fingerprint mismatch.

## File Layout

```
packages/runner/src/compilation-cache/
  mod.ts                 # CachedCompiler, re-exports
  storage.ts             # CompilationCacheStorage interface
  idb-storage.ts         # IndexedDB implementation (browser)
  fs-storage.ts          # Filesystem implementation (server / Deno)
  memory-storage.ts      # In-memory implementation (tests)
  git-fingerprint.ts     # computeGitFingerprint() for server
```
