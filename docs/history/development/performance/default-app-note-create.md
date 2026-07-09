---
status: historical
created: 2026-06-10
archived: 2026-07-08
reason: "Profiling snapshot of steady-state note creation, measured June 2026."
---

# Default-app note create: profile, hotspots, benchmarks

First end-to-end measurement of a real user flow for the
[Performance Program](../../../development/PERFORMANCE_PROGRAM.md): the **default-app shell
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

## Optimization round 1 (June 2026): candidates #3, #5, #2

Landed on `perf/selector-schema-standardization`:

1. **SelectorTracker schema standardization** (candidate #3's top seam,
   ~210 ms of 574 ms attributable hash/freeze time): content-hash LRU beside
   the frozen-identity WeakMap in `getStandardSchema` (mutable schemas pay
   exactly one content hash per call, preserving the edited-in-place contract),
   memoized `$defs`-stripped comparison hashes, hoisted `findRefs`.
   `selector-tracker.bench.ts` (new): warm lookup 466→225 µs, subset path
   1.8→0.8 ms.
2. **CFC schema-ref memoization** (candidate #5): `resolveCfcSchemaRef` +
   `findCfcSchemaRefs` cached per deep-frozen schema identity; resolution
   results are now identity-stable, restoring downstream cache hits.
   Reconciler mount bench: ~20% faster across sizes (@32: 83.9→67.5 ms).
3. **`cfc.schemaAtPath` memo** (candidate #2 groundwork): cached per frozen
   schema identity × path × boolean flags; serves the per-element write-diff
   calls and selector sub-schema derivations.

**End-to-end (worker busy CPU, notes 2–4 of the integration test):
1446 ms → 1182 ms (−18%).** `handleVDomMount` 540→406 ms (−25%);
`feedPlainObject` fell from top frame (92.6 ms in mount) to 20 ms;
deep-freeze and schema-ref frames left the top-12 entirely.

**Candidate #2 status:** measured single-child update is already O(1) in
list size (300 updates: ~1.5 s @8 / ~1.6 s @32 / ~2.0 s @128 children); the
~5 ms/update constant decomposes into commit hashing, `normalizeAndDiff`
write-diff, sink re-subscription (largely server-side graph re-extension in
the emulated bench), and read-back traverse/freeze. No single reconciler-side
lever exists.

**Next levers, in rough order of leverage:**
- **Intern/freeze cell schemas at the `getCell`/`asSchema` seam.** Several
  identity-keyed caches (schemaAtPath, value-hash, schema-refs) are gated on
  `isDeepFrozen` and stay cold because cell schema literals are mutable
  objects. Interning once at the seam would make them hit everywhere.
- `decodeJsonPointer` showed up at 23 ms in the post-optimization mount
  profile — trivially memoizable.
- Keep reconciler mounts alive across navigation (candidate #1, untouched:
  re-mount still pays full price by design of `handleVDomMount`).
- Skip sink re-subscription bookkeeping when the read set is unchanged.
- Value-graph identity reuse (freeze + reuse query results) — the remaining
  big hashing/freeze lever.

## Optimization round 2 (June 2026): remount hashing + poll fix

Branch `perf/reconciler-remount` (stacked on round 1). Two changes from the
follow-up session:

**Test poll quantization fixed.** `waitFor`'s default poll interval dropped
500ms → 50ms (`CF_WAITFOR_DELAY_MS` to override). The timing series now
measures reality: per-note totals reported ~1147ms before, **~409ms** after
(createToView ~294ms, returnToHome ~116ms) on the optimized stack.

**Remount made ~5× cheaper for all complex UIs** (investigated per the
"don't keep mounts alive, make mounting fast" directive). Profiling 100
mount/unmount rounds @32 children showed **58% of busy CPU was content
hashing**: five seams rebuilt fresh-but-structurally-equal schema/selector
objects per mount, and `hashOf`/`internSchema` caches key on object identity
at entry only — a fresh wrapper re-walks the whole embedded vdom schema.
The seams (each now memoized/canonicalized, gated on deep-frozen inputs):

1. `asCellCompoundSchemaForValue` rebuilt + interned every anyOf branch per
   read of every vdom node → candidate list cached per schema identity.
2. Created child cells got a fresh stripped-`asCell` schema per
   materialization (re-hashed at `resolveLink`'s exit intern on every
   `isStream`) → `unwrapAsCellSchema` memoized + interned.
3. `internPathSelector` canonicalized the schema but not the selector
   wrapper → now returns a canonical selector instance per (schema, path).
4. `pull`'s sync dedup key hashed a fresh wrapper embedding the selector
   schema → key composed from per-part cached hashes.
5. `cfc.schemaAtPath`'s cache was per-instance while pull/watch/traversal
   create a fresh `ContextualFlowControl` per call (permanently cold) →
   module-level, results interned. Plus `checkAnyOf`'s per-item comparison
   hashes cached per frozen identity.

Numbers:

| Gauge | Baseline | Round 1 | Round 2 |
|---|---|---|---|
| 100 mount/unmount rounds @32 children (in-process) | 7511ms* | — | **1828ms** |
| Reconciler bench: mount+unmount @128 | 344.7ms | 265.0ms | **69.3ms** |
| Reconciler bench: re-mount unchanged @32 | 171.5ms | 117.7ms | **33.8ms** |
| Reconciler bench: single-child update @32 | 6.7ms | 5.1ms | **3.7ms** |
| Integration: worker busy CPU, notes 2–4 | 1446ms | 1182ms | **742ms (−49%)** |
| Integration: `handleVDomMount` phase | 540ms (37%, #1) | 406ms | **110ms (15%, #5)** |

*measured at round-1 state; the profile target didn't exist at baseline.

Diagnosis method worth keeping: when profile attribution plateaued,
temporarily instrumenting `internSchemaReturningSchemaAndHash` misses with
sampled stacks (`__internMiss` counter) found the exact fresh-object seams in
minutes — profiles alone couldn't separate "hash of what, built where".

Remaining (smaller) hash consumers in the settle phase: `resolveLink` under
query-proxy reads and `resolveSchema` under `validateAndTransform` — both
downstream of read-path value materialization (the value-graph identity reuse
lever), plus the schema-interning-at-getCell seam for caller literals.

## Optimization round 3 (June 2026): schema interning at the cell seam

The "schema-interning-at-getCell" lever from round 2's remaining list.
Schemas attached to cell links via `runtime.getCell` / `getCellFromLink` /
`getImmutableCell` and `cell.asSchema` are now interned
(`internCellLinkSchema` in cell.ts): deep-frozen in place and collapsed to
one canonical instance per structure, so every identity-keyed schema cache
(`cfc.schemaAtPath`, schema-ref memos, selector standardization, value-hash)
keys off the canonical instance from cell creation onward — including
`key()` subschema derivation, which hits the `schemaAtPath` memo from the
first access. In-place freezing is the same contract `resolveSchema()`
already applies to cell schemas on every read/write-policy path; a caller
sweep found no code mutating a schema after passing it to these APIs.

Two carve-outs surfaced during implementation:

1. **Query-result-proxy schemas must not be frozen in place.** The wish
   builtin's `schema` argument is read through a query-result proxy;
   `Object.freeze` forwards through the proxy and freezes the underlying
   stored value, violating the proxy's object invariants (caught by the
   pattern-scope wish-scope test as an `ownKeys` invariant TypeError).
   `internCellLinkSchema` JSON-round-trips proxy-containing schemas first,
   per the existing convention for proxy-wrapped schemas.
2. **`TransformObjectCreator.mergeMatches` rebuilt its combined anyOf/allOf
   cell schema fresh per matched cell** (the round-2 instrumentation
   technique attributed 100% of intern misses during re-mount to this one
   site). Each fresh build paid a full content hash at the new `asSchema`
   seam: interning alone regressed re-mount @32 from ~34ms to ~46ms (+32%).
   Memoized per frozen compound-schema identity × the match's `asCell`
   values (module-level, mutable schemas never cached — same shape as the
   round-2 seam memos), which recovers it fully and makes the output
   identity-stable.

**Bench effect (interleaved A/B vs the round-2 base): neutral to slightly
positive.** Note-create @32 pull 24.4→22.7ms, selector subset path
623→598µs, reconciler mount/re-mount/update all within run noise. The
steady-state benches reuse stable module-level schema literals that
`resolveSchema()` already interned in place on first use, so their identity
caches were warm either way. The seam change is coverage and determinism
groundwork: canonical link schemas from creation (not from first
resolveSchema encounter), and structurally-equal-but-distinct schema objects
(fresh pattern-JSON parses, cross-module duplicate literals, derived
schemas) collapsing to one instance. The browser CDP pass confirms
neutrality: worker busy CPU for notes 2–4 measured 741ms on this branch vs
742ms on main (post-round-2), test green, per-note wall within noise.

## Optimization round 4 (June 2026): the remaining candidates, in order

Branch `perf/read-path-identity`. All four remaining candidates from the
round-2/3 lists, tackled in priority order:

**4a — read-path hashing eliminated.** Post-round-3 profiles showed ONE seam
holding ~97% of remaining hash time: `resolveCfcSchemaRefs` (the plural
follow-the-chain resolver; round 1 only memoized the singular) rebuilds a
fresh `{...resolved, ...rest, $defs}` spread whenever a `$ref` schema carries
extra keys — every `validateAndTransform` read of a vdom node. Memoized per
(frozen schemaObj, frozen fullSchema) pair with interned results. Also:
`selectorPathKey` ran on every `internPathSelector` call (>100ms self time)
— now cached per frozen path-array identity. Remount loop: 1888 → 1045ms;
hashing no longer appears in the remount profile's top frames at all.

**4b — trigger-index rebuild skipped on unchanged reads.**
`replaceActionTriggerPaths` cleared + re-added the per-entity trigger index
on every action re-run; now it remembers the last-registered (reads,
shallowReads) per action and returns the existing registration when equal.
Update loop A/B: ~4%; removes O(read-entities) churn from every steady-state
settle re-run.

**4c — verified-load-id seeding memoized.** `seedVerifiedLoadIds` re-walked
the full frozen pattern graph on every by-identity cache hit (every
map/filter op resolve; ~24% of the commit-callback phase in the original
profile). Seeded (root, loadId) pairs now skip.

**4d — shared-hashtag wish send halved.** The ~17ms per `#notebook` query
was `schemaAsCell` JSON-round-tripping the schema through its query-result
proxy — every property access pays full cell-read machinery — and being
called TWICE with identical input. Single materialization + content-keyed
parse/intern cache: **16.9 → 7.8ms avg** in the browser integration. The
remaining ~8ms is the one unavoidable stringify-through-proxy walk; reading
the schema slot without proxying (a concrete recursive JSON schema instead
of `schema: true` in TARGET_SCHEMA, or raw reads with link detection) is the
documented next step if it matters.

| Gauge | Round 3 / main | Round 4 |
|---|---|---|
| Remount loop, 100×(mount+unmount) @32 (in-process) | 1888ms | **1045ms** |
| Reconciler bench: mount+unmount @128 | 69.3ms | **47.6ms** |
| Integration: worker busy CPU, notes 2–4 | 742ms | **726ms** (pre-4d) |
| Integration: `#notebook` wish send | 16.9ms avg | **7.8ms avg** |
| Macro note-create @128 (pull) | 52.0ms | **49.8ms** |

Observed for a future round: `getCfcState` (~139ms self in the remount loop)
is now the largest single JS frame after GC.
