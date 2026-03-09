# Compilation Cache Design

**Status**: Draft
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
  └─ CompilationCache.get(programHash, fingerprint)
       │
       ├─ persistent cache hit? → evaluate JsScript → Pattern
       │
       └─ cache miss → Engine.compile(program) → JsScript
                          │
                          ├─ CompilationCache.set(programHash, fingerprint, jsScript)
                          └─ evaluate JsScript → Pattern
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
fingerprint = hash(HEAD_sha + sorted_hash(dirty .ts file contents))
```

Specifically:
1. `git rev-parse HEAD` — captures all committed changes.
2. `git diff --name-only HEAD` — lists uncommitted changed files (staged and
   unstaged) vs the current commit.
3. `git ls-files --others --exclude-standard '*.ts'` — lists untracked `.ts`
   files (new files not yet committed).
4. Filter both lists to `.ts` files, read their contents, sort by path, and
   hash.
5. Concatenate HEAD SHA + dirty file hash → final fingerprint.

This covers:
- `git pull` with new commits → HEAD changes → cache invalidated.
- Uncommitted edits to any `.ts` file → dirty hash changes → cache invalidated.
- New untracked `.ts` files → included in dirty hash → cache invalidated.
- Clean working tree → fingerprint = hash(HEAD) → stable across restarts.

Computed once at process startup. Cost is negligible: one `git` invocation plus
reading a handful of dirty files (typically 0-5 in practice).

```typescript
// Server fingerprint computation (Deno)
async function computeGitFingerprint(): Promise<string> {
  const head = await exec("git rev-parse HEAD");
  const dirty = await exec("git diff --name-only HEAD");
  const untracked = await exec(
    "git ls-files --others --exclude-standard '*.ts'"
  );
  const dirtyTs = [...dirty.split("\n"), ...untracked.split("\n")]
    .filter((f) => f.endsWith(".ts"))
    .sort();
  let contentHash = "";
  if (dirtyTs.length > 0) {
    const contents = await Promise.all(
      dirtyTs.map((f) => Deno.readTextFile(f))
    );
    contentHash = await sha256(contents.join(""));
  }
  return sha256(head + contentHash);
}
```

**Disabling the cache**: If no fingerprint is available (e.g., `buildHash` not
provided in `InitializationData`, or no git repo on the server), simply don't
construct a `CachedCompiler`. All cache code paths are guarded by
`if (this.cachedCompiler)` checks, so the absence of the object means no
caching — identical to today's behavior. An environment variable
(`COMPILATION_CACHE=off`) can also force this.

#### CompilationCacheStorage (interface)

```typescript
// packages/runner/src/compilation-cache/storage.ts

import { JsScript } from "@commontools/js-compiler";

interface CompilationCacheEntry {
  /** Full JsScript including source maps. We cache source maps alongside
   *  compiled JS — they're valuable for debugging and the space overhead
   *  is manageable (see Cache Size Estimation). */
  jsScript: JsScript;
  fingerprint: string;
  /** Timestamp for diagnostics / TTL eviction. */
  cachedAt: number;
}

interface CompilationCacheStorage {
  get(programHash: string): Promise<CompilationCacheEntry | undefined>;
  set(programHash: string, entry: CompilationCacheEntry): Promise<void>;
  /** Delete all entries not matching the given fingerprint. */
  evictStale(currentFingerprint: string): Promise<void>;
  /** Delete all entries. */
  clear(): Promise<void>;
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
  // cacheDir could be:
  //   - An env var (COMPILATION_CACHE_DIR)
  //   - A default like ${XDG_CACHE_HOME}/commontools/compiled/
  //   - A temp dir relative to the toolshed data directory
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
  ) {}

  /**
   * Returns cached JsScript for the given program, or undefined on miss.
   * Caller is responsible for compilation on miss and calling set().
   */
  async get(programHash: string): Promise<JsScript | undefined> {
    const entry = await this.cache.get(programHash);
    if (entry && entry.fingerprint === this.fingerprint) {
      return entry.jsScript;
    }
    return undefined;
  }

  async set(programHash: string, jsScript: JsScript): Promise<void> {
    await this.cache.set(programHash, {
      jsScript,
      fingerprint: this.fingerprint,
      cachedAt: Date.now(),
    });
  }

  /** Evict entries from previous compiler versions. */
  async evictStale(): Promise<void> {
    await this.cache.evictStale(this.fingerprint);
  }
}
```

Construction differs per environment, but the `CachedCompiler` itself is
environment-agnostic:

```typescript
// Browser (in RuntimeProcessor.initialize):
const cachedCompiler = data.buildHash
  ? new CachedCompiler(new IDBCompilationCache(), data.buildHash)
  : undefined;

// Server (in toolshed startup):
const fingerprint = await computeGitFingerprint();
const cachedCompiler = new CachedCompiler(
  new FileSystemCompilationCache(cacheDir),
  fingerprint,
);
```

### Engine Refactor

`Engine.process()` currently interleaves compilation and evaluation. To allow
the cache to intercept compilation without infecting Engine internals, we split
`process()` into two phases:

```typescript
// New method: compile only, no evaluation
async compile(
  program: RuntimeProgram,
  options?: TypeScriptHarnessProcessOptions,
): Promise<JsScript> {
  const id = options?.identifier ?? computeId(program);
  const filename = options?.filename ?? `${id}.js`;
  const mappedProgram = pretransformProgram(program, id);
  const resolver = new EngineProgramResolver(mappedProgram, this.ctRuntime.staticCache);
  const { compiler } = await this.getInternals();
  const resolvedProgram = await this.resolve(resolver);

  const diagnosticMessageTransformer = new OpaqueRefErrorTransformer({
    verbose: options?.verboseErrors,
  });

  return compiler.compile(resolvedProgram, {
    filename,
    noCheck: options?.noCheck,
    injectedScript: INJECTED_SCRIPT,
    runtimeModules: Engine.runtimeModuleNames(),
    bundleExportAll: true,
    getTransformedProgram: options?.getTransformedProgram,
    diagnosticMessageTransformer,
    beforeTransformers: (program) => {
      const pipeline = new CommonToolsTransformerPipeline();
      return {
        factories: pipeline.toFactories(program),
        getDiagnostics: () => pipeline.getDiagnostics(),
      };
    },
  });
}

// New method: evaluate pre-compiled JS
async evaluate(
  program: RuntimeProgram,
  jsScript: JsScript,
  options?: TypeScriptHarnessProcessOptions,
): Promise<{ main?: Exports; exportMap?: Record<string, Exports> }> {
  const { isolate, runtimeExports, exportsCallback } = await this.getInternals();
  const result = isolate.execute(jsScript).invoke(runtimeExports).inner();
  // ... handle exports mapping (existing code from process()) ...
}

// Existing method: refactored to use compile + evaluate
async process(program, options) {
  const output = await this.compile(program, options);
  if (!options?.noRun) {
    const { main, exportMap } = await this.evaluate(program, output, options);
    return { output, main, exportMap };
  }
  return { output };
}
```

This refactor is valuable independent of caching — it makes the compilation
pipeline more testable and composable.

### Integration with PatternManager

The cache integrates at `PatternManager.compilePattern()`, which currently calls
`this.runtime.harness.run(program)`:

```typescript
async compilePattern(input: string | RuntimeProgram): Promise<Pattern> {
  let program: RuntimeProgram = /* normalize input */;
  const programHash = createRef({ src: program }, "pattern source").toString();

  // Check persistent cache
  if (this.cachedCompiler) {
    const cached = await this.cachedCompiler.get(programHash);
    if (cached) {
      // Skip compilation, go straight to evaluation
      const { main } = await this.runtime.harness.evaluate(program, cached);
      const pattern = main![program.mainExport ?? "default"] as Pattern;
      pattern.program = program;
      return pattern;
    }
  }

  // Cache miss: full compile + evaluate
  const { output, main } = await this.runtime.harness.process(program);
  const pattern = main![program.mainExport ?? "default"] as Pattern;
  pattern.program = program;

  // Persist to cache
  if (this.cachedCompiler) {
    // Fire-and-forget: don't block on cache write
    this.cachedCompiler.set(programHash, output).catch((err) =>
      logger.warn("compilation-cache", "Failed to write cache", err)
    );
  }

  return pattern;
}
```

Note: `compileOrGetPattern()` continues to check the in-memory LRU first. The
persistent cache is only consulted on an in-memory miss. This means the hot
path (same pattern used multiple times in a session) never touches IndexedDB.

### Harness Interface Change

`Engine` is the only `Harness` implementation in the codebase, so adding methods
to the interface is safe. The `Harness` interface (`harness/types.ts`) gains
`compile` and `evaluate` methods:

```typescript
interface Harness extends EventTarget {
  run(source: RuntimeProgram, options?: TypeScriptHarnessProcessOptions): Promise<Pattern>;
  resolve(source: ProgramResolver): Promise<Program>;

  // New: compile without evaluation
  compile(source: RuntimeProgram, options?: TypeScriptHarnessProcessOptions): Promise<JsScript>;
  // New: evaluate pre-compiled JS
  evaluate(source: RuntimeProgram, jsScript: JsScript, options?: TypeScriptHarnessProcessOptions): Promise<{ main?: Exports; exportMap?: Record<string, Exports> }>;

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

1. **Initialization**: When the runtime starts, compute the fingerprint string
   and create `CachedCompiler` with the appropriate storage backend. If no
   fingerprint is available, skip — no `CachedCompiler` means no caching.
2. **Eager eviction**: On startup, call `evictStale()` to clear entries from
   previous compiler versions. This is async and non-blocking — compilation can
   proceed while eviction runs.
3. **Reads**: On every `compilePattern()` call, check persistent cache after
   in-memory miss.
4. **Writes**: After successful compilation, write to cache (fire-and-forget).
5. **Size management**: See [Eviction Strategy](#eviction-strategy).

### Eviction Strategy

Neither IndexedDB nor a filesystem cache directory have built-in size limits, so
we manage our own. The strategy is the same for both backends:

- **Fingerprint-based eviction**: On startup, delete all entries whose
  fingerprint doesn't match the current one. This is the primary invalidation
  mechanism.
- **Count-based cap**: If the cache exceeds N entries (default 500, configurable
  via `COMPILATION_CACHE_MAX_ENTRIES`), delete the oldest by `cachedAt`. This
  prevents unbounded growth from accumulating many distinct patterns over time.
  Every count-based eviction is logged at `warn` level with the number of entries
  evicted and the current cap. A per-session counter tracks total count-based
  evictions; if it exceeds a threshold (e.g., 50), log a prominent warning
  suggesting the cap may need to be increased. This makes it easy to notice when
  the working set has outgrown the cache.
- **Manual clear**: Expose a `clearCompilationCache()` for debugging. Could be
  wired to a dev tools button in the browser, or a CLI command for the server.

No TTL-based eviction for now. The fingerprint is the source of truth for
freshness. If the fingerprint matches, the entry is valid regardless of age.

### Disabling the Cache

The cache is disabled by not constructing a `CachedCompiler`:

- **Browser**: If `InitializationData.buildHash` is absent, no cache is created.
  This happens naturally if the Felt manifest hasn't been set up yet.
- **Server**: Set `COMPILATION_CACHE=off` in the environment to skip cache
  construction.
- **Tests**: Don't provide a `CachedCompiler` to the Runtime — tests run with
  no persistent cache by default (same as today).

### Observability

Cache state must not be invisible. The `CachedCompiler` tracks the following
stats and exposes them via `RuntimeTelemetry` events:

- **Hits / misses / miss reason** (fingerprint mismatch vs not found)
- **Time saved** (estimated: hits × average compilation time)
- **Current entry count** and **storage size estimate**
- **Count-based evictions** this session (with warning if excessive)
- **Fingerprint** in use (for debugging "which build am I running?")

These stats are reported as `RuntimeTelemetryMarker`s so they're available to
any subscriber — the existing scheduler inspector UI, browser console, or future
dashboards. On each cache hit or miss, emit a telemetry event. On startup (after
eviction), emit a summary event with entry count and fingerprint.

Additionally, log a one-line summary at `info` level on startup:
```
[compilation-cache] fingerprint=a1b2c3 entries=142 evicted=38
```

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

### Phase 1: Engine Refactor (no caching yet)

1. Split `Engine.process()` into `compile()` + `evaluate()`.
2. Update `Harness` interface.
3. Refactor `process()` and `run()` to use the new methods.
4. Verify all existing tests pass — this is a pure refactor.

### Phase 2: Cache Infrastructure

1. Define `CompilationCacheStorage` interface.
2. Implement `CachedCompiler` (takes a storage backend + fingerprint string).
3. Implement `IDBCompilationCache` (browser).
4. Implement `FileSystemCompilationCache` (server / Deno).
5. Implement `MemoryCompilationCache` (for tests).
6. Implement `computeGitFingerprint()` for server-side fingerprint.

### Phase 3: Browser Fingerprint

1. Add post-build manifest generation to Felt's `Builder.build()`.
2. Add `buildHash` field to `InitializationData`.
3. Shell reads manifest at startup, passes hash to worker.

### Phase 4: Integration

1. Wire `CachedCompiler` into `PatternManager` (optional dependency).
2. Integrate cache checks into `compilePattern()`.
3. Add startup eviction.
4. Add logging/metrics (cache hit rate, time saved).

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
