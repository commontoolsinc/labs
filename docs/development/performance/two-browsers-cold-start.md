# Two-browsers cold start: where the time goes

An investigation, for the [Performance Program](../PERFORMANCE_PROGRAM.md), into
the runtime of the multi-browser CFC group-chat test
(`packages/patterns/integration/cfc-group-chat-demo-two-browsers.test.ts`). That
test drives two real headless browser profiles against one toolshed and prints
its own step timings plus per-browser IPC and worker breakdowns.

**Scope: cold start.** Every test run uses a fresh random space, so each run
cold-compiles the space-root and home patterns and pays first-load storage I/O.
Warm-reload caching gains are explicitly out of scope here — the goal is to make
the cold path itself faster.

## How to reproduce, and a measurement trap

Start the local stack at some copy's offset `N` (toolshed then listens on
`8000 + N`), then run the one test:

```bash
./scripts/start-local-dev.sh --port-offset=N

cd packages/patterns
FRONTEND_URL=http://localhost:$((5173 + N)) API_URL=http://localhost:$((8000 + N)) \
  HEADLESS=1 LOG_LEVEL=warn \
  deno test --v8-flags=--max-old-space-size=4096 -A \
  integration/cfc-group-chat-demo-two-browsers.test.ts
```

The trap: the toolshed store (`packages/toolshed/cache/memory`) grows across
runs and, once it reaches a few GB, inflates cold start by roughly a second (a
fresh `getSpaceRoot` went from ~3.0s on an empty store to ~3.8s against a 2.8GB
store). It is not the compiled-payload size that grows the per-commit cost — it
is the store the server scans. So before each measurement, wipe the store **and**
restart toolshed; otherwise the numbers drift and small changes look significant
when they are not. This is the same hazard that confounds pattern-integration
bisects.

## Baseline (clean store)

Measured on a wiped store, runner unmodified, six runs, taking medians:

- Wall time of the test process: ~9.3s (the first run on a freshly started dev
  server is ~12.3s because the dev server compiles the worker bundle on first
  request).
- The test's own step-timing total: ~4.3s.
- `pattern:getSpaceRoot` and `runtime:ensureHomePatternRunning`: ~3.3s **each**,
  and they finish at the same instant.

## Why it is slow

The two cold-start IPC calls report identical durations because they are
independent (different spaces) yet both wait on the same single-threaded worker
draining its cold-start queue, and on the same single toolshed connection. The
worker already handles IPC requests concurrently
(`packages/runtime-client/backends/web-worker/index.ts`), so this is genuine
shared-resource contention — one CPU thread, one storage connection — not a
fixable serialization bug. The first save (`vdom:event` ~1.9s) is slow for the
same reason: it lands while the worker is still saturated.

That ~3.3s of worker cold start is, roughly:

1. **~0.8s of TypeScript compilation** (`engine/compileToRecordGraph`). This is
   irreducible by the obvious levers. The CommonFabric transformer pipeline
   (`packages/ts-transformers`) needs a full `ts.Program` — it calls
   `getTypeChecker`, `getSymbolAtLocation`, `getTypeAtLocation` — so
   `ts.transpileModule` cannot be substituted. `noCheck` does not help either:
   skipping `typeCheck()` just moves the same type-resolution cost into
   `declarationCheck()`, and the emit re-resolves types through the transformers
   regardless.

2. **~2.5s of serialized toolshed round-trips**: the compile-cache read (a
   guaranteed miss on a fresh space), the compile-cache write-back, the
   piece-creation commit, and the repeated `synced()` barriers in
   `ensureDefaultPattern` (`packages/piece/src/ops/pieces-controller.ts`). These
   are gated by `synced()` → `storageManager.synced()`, which waits for every
   pending push to the space. The write-back commit is the largest single one
   because its payload is large, but its cost is dominated by the per-transaction
   round-trip, not the byte count (see below).

## What was tried, and measured neutral

All measured on a clean store; each landed within run-to-run noise of the 9.3s /
4.3s baseline:

- **Compile-cache write-back made fire-and-forget.** Neutral: `synced()` (which
  `ensureDefaultPattern` awaits) re-awaits the in-flight write, so this
  reschedules the work rather than removing it.
- **gzip-compressing the compiled-document payload (~4x smaller).** Neutral: the
  commit cost is per-transaction, not per-byte — the same ~500KB body committed
  raw or compressed took the same wall time.
- **Skipping the cold read-miss.** Neutral: the read overlaps the compile, so
  removing it frees no wall time on the critical path.
- **Dropping the cache write-back entirely** does cut `getSpaceRoot` by ~1.3s,
  but it breaks the test: the second browser then cannot load the pattern the
  first browser created. The write-back is load-bearing for that cross-browser
  hand-off, so it cannot simply be removed.

## What was landed

`inlineSources: false` in `packages/js-compiler/typescript/options.ts`. The
source-map *mappings* are load-bearing; the embedded `sourcesContent` had no
live reader and only duplicated the authored source the cache already stores
elsewhere.

Tracing the consumers confirms this:

- The only code that reads `sourcesContent` is `composeBundleSourceMap`
  (`packages/js-compiler/source-map.ts`), which copies it forward into the maps
  the engine registers with the SES runtime (`engine.ts`, `loadSourceMap`),
  intended "so DevTools can show the authored text."
- But everything that consumes those registered maps —
  `SourceMapParser.mapFrame` / `mapPosition` — resolves positions through
  `originalPositionFor`, i.e. the line/column **mappings only**; it never reads
  `sourcesContent`. So stack-trace frame rewriting and `fn.src` / CFC
  verified-source resolution are coordinate-based. (The warm-cache path already
  proves this: it builds an `identitySourceMap` with no `sourcesContent`, and
  verified-binding passes off it.)
- The eval'd module bodies are tagged with `//# sourceURL=` but there is no
  `//# sourceMappingURL=` anywhere, so a browser/Deno debugger never auto-loads
  these per-pattern maps — the "DevTools shows authored text" path is not wired,
  and stepping through eval'd pattern code shows compiled JS regardless of this
  flag. (The runtime's own debuggability comes from the felt/esbuild build map,
  not these compiler options, so it is untouched.)
- The authored source is still cached — as the separate `pattern:<identity>`
  source documents (`loadSourceClosure` / `loadVerifiedSourceClosure`), which
  the cross-session recompile-from-source path reads — and is also on the
  toolshed and in the authored files. Nothing that needs the source text lost
  it; it just stopped being duplicated inside every module's map.

Measured on the group-chat bundle (5 modules), toggling only this flag: the
per-bundle source-map payload drops from ~110KB to ~38.5KB — about 65% smaller,
with the saved bytes being exactly the duplicated source. Larger system patterns
save proportionally more. This is a compile-cache footprint and sync-bandwidth
reduction, not a wall-time fix: it does not move this test, because the test is
bound by per-transaction round-trips and compilation rather than payload size.
The js-compiler source-map and compiler unit tests, and the two-browsers test
itself (which runs under CFC `enforce-explicit` and exercises verified-source
resolution), all still pass with it.

If a debugger is ever wired to these maps (a `//# sourceMappingURL` on the eval,
or feeding the composed map to DevTools over CDP), re-attach `sourcesContent`
from the source documents at that point rather than flipping this flag back on,
which would re-duplicate the source into every cached map.

## What would actually halve it

Each remaining lever is architectural, not a surgical edit:

- **Take the compile-cache write-back off the `synced()` critical path.** The
  write is safe to defer (fire-and-forget keeps the test passing), but every
  space write currently shares one sync barrier. A storage-layer "background
  write" that durability-syncs lazily would let `getSpaceRoot` return about a
  second sooner without losing the cross-browser hand-off.
- **Offload compilation to a worker pool** so the space-root and home patterns
  compile in parallel instead of serializing on one thread.
- **Batch the cold-start commits** (cache write-back, source documents, piece
  creation) into fewer toolshed transactions — the per-transaction round-trip is
  the unit cost.
- **Ship the fixed system patterns (`home.tsx`, `default-app.tsx`)
  precompiled** so a cold space never compiles them. This removes the ~0.8s
  compile per browser and its cache I/O, but it spans the build and the server,
  not just the runtime.

The first two together are the most likely path to a 50% reduction; no single
one of them gets there alone.
