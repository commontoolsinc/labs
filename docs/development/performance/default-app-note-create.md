# Default-app note create: profile, hotspots, benchmarks

First end-to-end measurement of a real user flow for the
[Performance Program](../PERFORMANCE_PROGRAM.md): the **default-app shell
integration test** (`packages/patterns/integration/default-app.test.ts`),
which creates notes through the shell UI against a local toolshed with the
runtime in a browser web-worker.

**Scope: steady-state note creation.** Pattern compilation is explicitly out
of scope (note 1 of each run is compile-dominated and excluded everywhere
below). Measured June 2026 on an Apple M3 Max, local stack, emulated user via
Astral/CDP.

## How to reproduce

Start the local stack, then run the test with the capture env vars:

```bash
./scripts/start-local-dev.sh --port-offset=73

cd packages/patterns
API_URL=http://localhost:8073 HEADLESS=1 LOG_LEVEL=warn \
CF_NOTE_CREATE_TIMING_SERIES=5 \
CF_CAPTURE_NOTE_CREATE_PROFILE_SERIES=5 \
CF_CAPTURE_NOTE_CREATE_CPUPROFILE_SERIES=3 \
CF_CPUPROFILE_DIR=/tmp/cf-profiles \
deno test --v8-flags=--max-old-space-size=4096 -A \
  --filter "default-app flow test" ./integration/default-app.test.ts
```

- `CF_NOTE_CREATE_TIMING_SERIES=N` — wall-clock timing for N note creates.
- `CF_CAPTURE_NOTE_CREATE_PROFILE_SERIES=N` — logger timing stats
  (`focusTiming`/`topTiming`/settle history) per note, via
  `commonfabric.rt.getLoggerCounts()` IPC.
- `CF_CAPTURE_NOTE_CREATE_CPUPROFILE_SERIES=N` — **new**: V8 sampling
  profiles of the runtime web-worker for notes 2..N+1, written as
  `.cpuprofile` (loadable in Chrome DevTools / speedscope) plus a ranked
  self-time report. Implemented by `packages/integration/cdp-profiler.ts`
  (`CdpWorkerProfiler`), which attaches a second CDP client to the Astral
  browser (`ShellIntegration.wsEndpoint()`), auto-attaches to the page's
  dedicated workers via flattened sessions, and drives `Profiler.start/stop`
  on the `worker-runtime` target. Note-1 profiles are skipped: they are
  compile-dominated and big enough to break the CDP websocket message limit.

## Wall-clock: beware the test's 500 ms poll quantum

The test reports ~1.15 s per note create (createToView ~520 ms, returnToHome
~630 ms), but `waitFor` in `@commonfabric/integration` polls every **500 ms**,
so each phase is quantized up to the next poll. Subtracting the quantum, the
real runtime cost is roughly **150–300 ms per note** — consistent with the
~200 ms of worker CPU the logger measures, plus IPC and main-thread render.
Don't use the test's wall numbers as an optimization target without fixing
the poll delay (or use the logger/profile numbers below).

## Logger measurements (steady state, per note create)

Per-note deltas are stable from note 2 on (5-note series):

| Key | Count/note | ms/note |
|---|---|---|
| `scheduler/execute` (settle-loop entries) | 14 | ~183 |
| `scheduler/execute/settle` | 14 | ~130 |
| `scheduler/run` (action runs) | 61 | ~115 |
| `scheduler/run/action` (action bodies) | 61 | ~96 |
| `traverse` | **+41/note growth** (362 → 485) | ~70 |
| `scheduler/execute/collectDirtyDependencies` | **+28/note growth** (810 → 894) | ~25 |
| `raw/run/wish` | 5 | ~26 |
| `scheduler/execute/event/handlerAction` | 4 | ~20 |

Two clear **O(existing-note-count) growth seams**: `traverse` call count and
dirty-dependency visits grow linearly with list size on every create, i.e.
quadratic accumulated cost as a space fills up.

Of the wish cost, the `#notebook` hashtag query dominates:
`wish/phase-query/send-shared-hashtag/#notebook` is ~15 ms per call (6 calls
across the run) — almost all of the shared-hashtag resolver's `sendResult`.

## Worker CPU profiles (notes 2–4 aggregated, 1446 ms busy)

Profiles taken at 250 µs sampling; analysis maps bundle frames back to source
files via `worker-runtime.js.map`. "Busy" excludes `(program)`/idle (the
worker idles between test polls).

### By phase (top-level dispatch)

| Phase | Share of busy CPU | What it is |
|---|---|---|
| `handleVDomMount` | **37%** | `WorkerReconciler.mount` — re-mounting the home view's vdom on navigation back; per-child cell subscribe + render |
| `runPullSettleOrder` | 21% | settle-loop action runs (lifts, maps, wish) |
| (other) | 17% | GC (5% of busy) + worker IPC encode/decode + misc |
| `execute` (scheduler) | 11% | dependency collection, scheduling, traverse machinery |
| `runCommitCallbacks` | 11% | post-commit runner starts; ~24% of this phase is the verified-bindings walk (`seedVerifiedLoadIds`, `verifiedWalkChildValues`, `collectAssociatedFunctions`) |
| `handleRequest` | 2% | direct IPC requests |

### By subsystem (cross-cutting, share of busy CPU)

| Subsystem | Share | Hot functions |
|---|---|---|
| Value hashing | **~29%** | `feedPlainObject` 12%, wasm SHA-256 5%, `feedObjectValue` 3%, `internSchema` 2%, hasher/encoding rest |
| Deep-freeze | **~12%** | `deepFreezeInProgress` 8%, `checkValue` 3% |
| Link resolution + schema traverse | ~9% | `resolveLink` 4.3%, `traverseWithSchema` et al. |
| Storage selector/tx | ~8% | `selector-tracker.ts` 3%, `v2-transaction.ts` 2.8%, `cache.get` 2% |
| CFC schema refs | ~7.5% | `resolveCfcSchemaRef` 3.5%, `findCfcSchemaRefs` 2.2%, `schemaAtPathInternal` 1.4% |
| Verified-bindings walk | ~5% | `seedVerifiedLoadIds`, `verifiedWalkChildValues` (CT-1665 machinery) |
| GC | ~5% | allocation pressure from the above walks |

Both hashing (`hashOf`) and deep-freeze (`isDeepFrozen`) cache **by object
identity** (WeakMap/WeakSet). Every fresh-identity but structurally-equal
value — query results, vdom, specs rebuilt per render — pays a full O(tree)
walk. That's why these two top the chart despite their caches.

## Benchmarks (new)

Each hotspot now has a benchmark that reproduces the integration shape
in-process, so it can be optimized without a browser:

1. **`packages/runner/test/default-app-note-create.bench.ts`** — macro bench:
   home doc with linked note docs, lifted derived view, live sink, event
   handler creating/removing a note. Covers event → preflight → handler →
   commit → settle → recompute, including the growth seams. Baseline:

   | Existing notes | create+remove cycle (pull) |
   |---|---|
   | 0 | 14.3 ms |
   | 32 | 24.1 ms |
   | 128 | 59.7 ms |

   Clear O(n): ~0.36 ms per existing note per create.

2. **`packages/html/bench/worker-reconciler-mount.bench.ts`** — the 37%
   phase: mounts a list vdom whose children are real cells (like piece `[UI]`
   links) through `rendererVDOMSchema`. Baseline:

   | Case | time |
   |---|---|
   | mount+unmount @8 children | 21.9 ms |
   | mount+unmount @32 children | 83.9 ms |
   | mount+unmount @128 children | 344.7 ms |
   | re-mount unchanged tree @32 | 171.5 ms (= 2× first mount: nothing is reused) |
   | single-child update under live mount @32 | 6.7 ms |

   ~2.7 ms **per child** to mount; a re-mount of an unchanged tree pays full
   price, and even a one-child update costs milliseconds.

3. **`packages/data-model/bench/value-identity-shapes.bench.ts`** — the
   identity-cache gap behind the hashing/freeze numbers. Baseline:

   | Case | time |
   |---|---|
   | `hashOf` deep-frozen doc, same identity | ~10 ns |
   | `hashOf` fresh-identity note doc (~30 nodes) | ~5 µs |
   | `hashOf` fresh-identity home doc @128 notes | **2.1 ms** |
   | `isDeepFrozen` frozen-but-uncached note doc | 19 µs |
   | `deepFreeze` fresh home doc @128 notes | 402 µs |

Existing related benches: `scheduler-event-preflight.bench.ts` (the 30-note
preflight shape), `push-pull-patterns.bench.ts` (map/filter machinery),
`traverse-replay` harness + `link-resolution.bench.ts`.

## Optimization candidates (ranked by measured impact)

1. **Don't re-mount the home view from scratch on navigation** (37% phase +
   main-thread twin). Keep the reconciler mount alive across view switches,
   or memoize per-child render state keyed by cell identity + version so an
   unchanged child re-mount is O(1). The re-mount bench is the regression
   guard.
2. **Make the single-child update path O(1).** 6.7 ms for one chip update at
   32 children means updates re-read far more than the changed subtree.
3. **Structural (content) caching for `hashOf`/`isDeepFrozen`**, or freeze +
   reuse canonical value graphs so the identity caches actually hit. The
   2.1 ms home-doc hash is paid multiple times per create. Same family as the
   schema canonicalization win in #3948 (8.4× traverse) — values, not schemas.
4. **Bound the O(n)-per-create growth** (traverse +41/note, dirty-visits
   +28/note): incremental list diffing instead of whole-list re-reads in the
   derived home view. Guarded by the macro bench's @0/@32/@128 spread.
5. **Memoize CFC schema-ref resolution** (`resolveCfcSchemaRef` /
   `findCfcSchemaRefs`, 7.5%) — these re-walk schemas that `internSchema`
   already canonicalizes.
6. **Cache the verified-bindings commit walk** (`seedVerifiedLoadIds` /
   `verifiedWalkChildValues`, ~5%, 24% of commit callbacks) per executable +
   value identity (CT-1665 follow-up).
7. **Shared-hashtag wish `sendResult`** (~15 ms per `#notebook` query):
   profile what `sharedWishCellValue` → `sendResult` rewrites each time the
   resolver is already shared.

Follow-up measurement gaps (not covered here): main-thread (page) profile of
the same flow (the reconciler has a DOM-applying twin), storage server time,
and a benchmark for per-note pattern instantiation (`startWithTx` in commit
callbacks; the macro bench uses plain docs, not running patterns).
