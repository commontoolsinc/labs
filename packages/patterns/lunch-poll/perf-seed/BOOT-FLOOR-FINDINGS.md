# Pattern initial-load — the per-piece runtime **boot floor** (current main, 2026-06-30)

**Status:** measured & attributed on current `main`, no fix applied yet. The #1
lever is being mapped to source.

**Supersedes [`SLOW-LOAD-FINDINGS.md`](./SLOW-LOAD-FINDINGS.md)**, which
measured the _old_ lunch-poll (pre web-search/art removal, pre storm/VDOM/resume
fixes) and is now stale — its lunch-poll-specific drivers are fixed or gone.

---

## TL;DR

The "lunch poll takes ~1s to load" is **~92% a generic per-piece boot floor that
every pattern pays**, not the lunch poll. A trivial 1-`div` pattern loads in
**~662ms**; an empty lunch poll **~678ms**; the full 10-option/35-vote/4-user
poll **~738ms** (the pattern's own data adds **~60ms**; inline art adds
**~0ms**, re-confirming the old art exoneration). The floor is the runtime
**evaluating the module graph inside a SES Compartment** — for a trivial user
pattern it is all runtime + **system-app** machinery (`default-app.tsx` +
`notebook/note/
summary-index/backlinks-index` are loaded at boot). The time is
in `worker-runtime.js` (~578ms of a ~640ms busy worker), in a handful of
per-module / per-primitive buckets. **The top single lever is eager
per-`lift`/`handler` debug-metadata source annotation (~100ms,
`getLineAndColumnAtOffset`)** — the same function the old doc flagged as an
"unexplained anomaly."

This is a **runtime / ts-transformers / SES** finding. Optimizing pattern code
(tally fan-out, per-option cards, vote-commit churn) would move load by ~8%.

---

## 1. Method (all client-side, read-only)

- Isolated offset-20 toolshed with `--inspect`
  (`start-local-dev.sh
  --port-offset 20 --inspect`), **isolated
  `CACHE_DIR`/`MEMORY_DIR`** so it does not share the default `:8000` instance's
  SQLite store (the start script offsets ports but **not** the data dir — a real
  footgun).
- Deploy/seed current main via [`seed.sh`](./seed.sh)
  (`--empty | --no-art |
  full`).
- `agent-browser` (`/opt/homebrew/bin`): `--session` with Import-CLI-Key auth,
  `eval` for the page `commonfabric` debug API, `trace`, and `profiler`.
- **Settle wall-time** = `commonfabric.viewSettled()` (resolves on
  `getRt().idle()`) measured via `performance.now()` after `location.reload()`
  (identity persists).
- **Worker attribution** = `agent-browser profiler` — note its output is a
  _trace_ with `ProfileChunk` events (spans navigation, covers workers), not a
  flat `.cpuprofile`. The runtime worker's samples land on a `v8:ProfEvntProc`
  thread; parse by isolate and pick the one whose frames are in
  `worker-runtime.js`. Parser: [`cpuprof4.py`](./cpuprof4.py) (self +
  inclusive + caller chains via the node `parent` field).

**Instrument note (validate before trusting):** the old doc's
`commonfabric.rt.getGraphSnapshot()` **no longer exists**; `commonfabric.rt` is
now just an event bridge. Current API: `getLoggerCountsBreakdown`,
`getTimingStatsBreakdown`, `viewSettled`, `vdom`, `detectNonIdempotent`,
`watchWrites`, `explainTriggerTrace`.

**Worker warm/cold bimodality — critical for any boot re-measure (2026-07-01,
bucket #2 thread).** The runtime worker's evaluated module graph is _reused_
across rapid same-page reloads, so reloads are **bimodal**: a **cold**
first-boot re-evaluates the graph and pays the full floor (trivial settle
~620–640ms; `evaluateCachedModules` + `buildRecordsFromCompiled` run), while a
**warm** reload reuses the live worker and skips module eval entirely (trivial
settle ~195ms; the boot buckets don't run). The "~662ms cold reloads" above are
all cold boots. Consequences for measuring any bucket fix:

- **A fix's win only shows on a _cold_ boot** — a warm reload shows nothing
  because the bucket never ran. The idle→cold threshold is **noisy** (~35s idle
  can stay warm, ~55s can go cold; tight back-to-back reloads stay warm), so
  don't trust wall-time settle alone.
- **`agent-browser close` nukes the CF identity** (it lives in IndexedDB; close
  tears the context down → login screen). Never `close`; reload/navigate within
  the live session. `--profile <dir>` is silently ignored if a daemon is already
  running.
- **Most reliable signal = direct in-worker instrumentation, which self-gates
  cold.** Add a `console.warn` inside the bucket's function (absent on warm
  boots). Forward the worker console to the page by setting
  `localStorage["forwardWorkerConsole"]="true"` (persists across reload; the
  shell seeds the worker with forwarding on _at creation_, so the boot-time log
  is captured — set it on the login page pre-auth to catch the very first cold
  boot) or `commonfabric.forwardWorkerConsole(true)`, then read with
  `agent-browser console`. A runner edit needs a **shell restart** to rebuild
  `worker-runtime.js`; verify the rebuild with
  `curl .../scripts/worker-runtime.js | grep <marker>`.

## 2. The reframe — load is a fixed floor, not scale/art

| load                                | settle (3 cold reloads) | Δ                       |
| ----------------------------------- | ----------------------- | ----------------------- |
| trivial 1-`div` pattern             | 656 / 656 / 675 (~662)  | —                       |
| empty lunch poll (0/0/0)            | 599 / 730 / 705 (~678)  | +16 over trivial        |
| 10 opt / 35 votes / 4 users, no art | 700 / 756 / 757 (~738)  | **+60 (pattern data)**  |
| + 63 KB inline art payload          | 695 / 758 / 756 (~736)  | **+0 (art exonerated)** |

Document/first-paint is fast (DOMContentLoaded 134ms, FCP 168ms); the ~0.7s is
graph settle _behind_ the paint.

**Vs the stale doc (old pattern):** RunMicrotasks 694ms (was ~2,225), GC ~46ms
(was 600–900), **VDOM apply-batches = 1** (was 117–164). The egregious old
slow-load was real and is fixed (#4360 storm, #4366 VDOM settling, #4367
read-mostly resume, #4325 art, #4326 web-search); the boot floor underneath is
what remains.

## 3. The boot floor, attributed (trivial-pattern worker isolate: ~640ms busy)

Inside `evaluateCachedModules` (~459ms inclusive) → `compartmentImportNow` /
`populateModuleExports` (SES Compartment module eval):

| bucket                                  | ~ms                    | caller chain (top)                                                                                                                                                                  | lever                                                                                                                                                                                                |
| --------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-primitive debug-metadata**        | **~100**               | `getLineAndColumnAtOffset` ← `findMappedLocationInSourceRange` ← `resolveLocationFromFunctionSource` ← `annotateFunctionDebugMetadata` ← `lift`/`handler` ← `populateModuleExports` | **#1: precompute locations at transform time, or defer annotation until a trace needs it**                                                                                                           |
| **Module record extraction (TS parse)** | ~102 → **0 (Fix A+B)** | `parseSourceFile`/`createSourceFile2` ← `extractCompiledExports`/`extractRuntimeImports` ← `buildRecordsFromCompiled` ← `evaluateCachedModules`                                     | **RESOLVED — see §9.** The 9-module system-app closure was parsed **4×**/boot; a body-keyed parse memo (Fix A, #4441) → 1×; persisting the record surface on the compiled doc (Fix B, #4442) → **0** |
| **Per-primitive schema intern+hash**    | ~68                    | `internSchema`/`computeHash`/`joinSchema`×N ← `applyArgumentIfcToResult` ← `createNodeFactory` ← `lift`                                                                             | **PARKED — see §10** (88% redundant hashes, but already-memoized; low ROI)                                                                                                                           |
| **SES harden + lockdown**               | ~50–67                 | `baseFreezeAndTraverse` ← `harden` ← `hardenExportedValue` ← `populateModuleExports` (per export); `lockdown` ← `ensureSESLockdown` (once)                                          | SES-inherent; per-export harden maybe trimmable                                                                                                                                                      |
| **Pattern factory build**               | ~60–100                | `factoryFromPattern`/`pattern`/`trustedPattern` + `sanitizeSchemaForLinks`                                                                                                          | **#5 landed — see §10** (partial-cause O(N) + sanitize memo, #4447)                                                                                                                                  |
| **esbuild CJS→ESM glue**                | ~31                    | `__copyProps` ← `__toESM` ← (root)                                                                                                                                                  | bundling (pure-ESM avoids `__toESM`)                                                                                                                                                                 |
| **quicksort w/ random pivot**           | ~20                    | `randomIntInRange` ← `doQuickSort` (something sorts a largish list at boot)                                                                                                         | investigate — odd                                                                                                                                                                                    |

## 4. The meta-insight

**A trivial pattern pays the full system-app boot.** `default-app.tsx`,
`notebook.tsx`, `note.tsx`, `summary-index.tsx`, `backlinks-index.tsx` all load
at boot; the cost is the runtime's **per-module / per-primitive processing**
(annotate → parse → schema-intern → harden) applied across that whole graph —
the pattern code itself is ~nothing (those files show ≤0.6ms self each). So the
~670ms is "evaluate + annotate + harden the loaded module graph," independent of
the user pattern.

## 5. Top lever — mapped to source

All in **`packages/runner/src/builder/module.ts`**:

- `createNodeFactory` annotates **every** lift/derive/computed
  ([:120](../../../runner/src/builder/module.ts)); handlers at `:410`.
- `annotateFunctionDebugMetadata` (`:552`) → `getExternalSourceLocation`
  (`:192`) captures **`new Error().stack` per primitive**; at module-eval the
  frame points into the bundle and maps to nothing, so it falls back to
  `resolveLocationFromFunctionSource` (`:608`), which does: `fn.toString()` + an
  **`indexOf` of the body across the whole compiled `context.script`**
  (O(script×body)) + **`findMappedLocationInSourceRange` (`:658`) walking
  char-by-char, calling the source-map `mapPosition` at each char** +
  `getLineAndColumnAtOffset` (`:646`) `slice`+`split`. The
  `sourceLocationContext` (the script) is set up per module-eval at
  `harness/engine.ts:930`.

Per-primitive cost = stack capture + full-script string search + per-char
source-map walk + two `fn.toString()`s. Across all system-app + runtime
primitives at boot = ~80–100ms.

**`.src` & identity — resolved with the authors (2026-06-30, seefeld via
Discord).** `fn.src` _used to_ be each builder's stable identity, but **hoisting
changed that**: the per-module content-addressed **`implementationHash`** is now
the preferred fingerprint (`action-run.ts:728` — "`.src` … is the fallback"),
and each hoisted `__cfLift_N` carries a stable module-identity + name. So `.src`
is **no longer needed for identity** and can be made lazy / debug-only.
seefeld's directive: **"remove the fallback and error instead."**

Implementation caveat (flagged back to the authors): `getSchedulerActionId`
(`diagnostics.ts:38`) still returns `.src` first, then **bare `.name`**, which
collides across modules (each re-numbers `__cfLift_1..N`); and
`implementationHashForSource` (`engine.ts:1271`) currently derives the hash by
parsing `.src`. So removing the `.src` fallback safely means **re-rooting the
action id on module-identity + name** (Berni's exact phrasing), not letting it
fall through to bare `.name`. (An earlier note here said "`.src` is
load-bearing, must preserve it" — true of the _current_ code, but superseded by
this direction: re-root identity, then drop `.src` from the hot path.)

### Validation (2026-06-30)

Short-circuiting `annotateFunctionDebugMetadata` entirely (runner edit, rebuilt
`worker-runtime.js`, re-measured) **confirms the lever**:
`getLineAndColumnAtOffset` **80.6ms → absent**, worker busy **640ms → 538ms**,
trivial settle **~662ms → ~579ms (−83ms, reproducible 592/571/574)**. This
proves the cost; it is **not** a valid fix (it drops `.src`, changing action
identity). The achievable win is ~83ms _if `.src` is preserved_.

### Fix — author-settled direction (NOT a transformer change)

Earlier drafts here considered transform-time position injection (and debated
compiled-vs-original positions). **Superseded:** the authors confirmed `.src`
isn't needed for identity, so we don't inject positions at all. The fix is in
the runner:

1. **Re-root `getSchedulerActionId` on module-identity + name**
   (`diagnostics.ts:38`) so the stable action id no longer routes through
   `.src`. (Mind the bare-`.name` cross-module collision above.)
2. **Remove the expensive `resolveLocationFromFunctionSource` fallback**
   (`module.ts:560`) — error/skip instead, per seefeld. → the **~83ms**.
3. **Make `.src` / source-location lazy & debug-only** (compute only when
   debugging is on → cost 0 normally), and **fix the cheap source-map path**
   (`getExternalSourceLocation`) so it yields the location when needed — the
   "source maps broke" thread (Gideon is taking this).
4. **Verify**: action-id + fingerprint stability before/after across
   `pattern-tests` (68) + `generated-patterns` (147), plus the boot re-measure
   (expect ~83ms). The short-circuit experiment (above) is the cost upper-bound.

Separately, the TS-parse (~102ms, `buildRecordsFromCompiled` →
`createSourceFile`) and schema-intern (~68ms) are the same "do it at build, not
boot" shape — later levers behind this one.

## 6. Resolution & implementation plan (authors + spec, 2026-06-30 PM)

### The authoritative spec settles the design

`docs/specs/content-addressed-action-identity.md` (**Phase 4 COMPLETE**: "one
resolution model — content-addressed `{ identity, symbol }`, by identity,
everywhere"):

- **`.src`/`location` is explicitly "debug only" / "inert"** (§1 line 238-240,
  open-Q3 line 609). Identity is `{ identity, symbol }` (module content hash +
  hoisted `__cfLift_N`/export name).
- **The durable path is already migrated**: persisted scheduler observations key
  on content-addressed `implementationHash` (`cf:module/<hash>:line:col`), "no
  `implementationRef` dependence" (spec line 148-150).
- **CFC verified-source** target = a provenance WeakMap keyed by
  `{ moduleIdentity, symbol }` (§3); `.src` is at most a consistency check. The
  spec **mandates a red-team security pass** for CFC identity changes (line
  555).
- **Plumbing exists**: `getArtifactEntryRef(value)` → `{ identity, symbol }`
  (`builder/pattern-metadata.ts:172`), populated by `recordModuleProvenance`
  (`harness/engine.ts:1032`); the scheduler diagnostics already call it
  (`scheduler/diagnostics.ts:183`).

So the lingering `.src`-derivations are the legacy fallback to retire:
`getSchedulerActionId` returns `.src` first (`diagnostics.ts:38`),
`implementationHashForSource` parses `.src` (`engine.ts:1271`),
`identityFromCanonicalSource` parses `.src` (`verified-provenance.ts:96`).

### Blast radius (#2) — resolved

- `getSchedulerActionId` feeds only **in-session** state: the `actionStats` Map
  ("persist across action recreation" _within a session_, `scheduler.ts:311`),
  the breakpoints Set, debounce keys, telemetry. Ephemeral → re-rooting is low
  risk.
- Durable identity already uses content-addressed `implementationHash` / the CFC
  provenance WeakMap. **CFC verified-source is the one security-sensitive
  surface** — spec-gated behind a red-team pass.

### Empirical: the cheap path is broken (Berni point 1) — `cf check` on lunch-poll

- **64 of 82 primitives hit the expensive fallback**; only 18 take the cheap
  stack path.
- The fallback produces **correct** canonical `cf:module/<hash>/path` locations.
- The 18 cheap "successes" return the **wrong** location —
  `runner/src/module.ts:138:10` (the runtime factory frame, identical for all 18
  → they would _collide_ as identities).
  `INTERNAL_SOURCE_LOCATION_FRAME_PATTERNS` (`module.ts:106`) filters
  `factory.ts` but not `module.ts`, and the eval-time stack frames mostly don't
  canonicalize (the CT-1754 mechanism, `engine.ts:900-926`).
- ⟹ The cheap path is frequently-null **and** actively-wrong; the fallback is
  currently the only correct source. **"Remove the fallback" (Berni's "former")
  must wait until the cheap path is fixed** — naive removal would break/collide
  ids.

### The proper set of fixes (sequenced)

- **A — Fix the cheap source-map path** (Berni point 1; Gideon's thread). The
  **safe** ~83ms (preserves `.src` exactly, no identity/CFC change).
  NON-trivial: real bug — the cheap path returns the factory frame and most
  eval-time frames don't canonicalize. Independently shippable. **Recommended
  first win.**
- **B — Re-root identity off `.src`** (Berni's "the latter," architectural).
  `getSchedulerActionId` → `getArtifactEntryRef(factory)`
  `{ identity, symbol }`; `implementationHash` sourced from the content address
  directly; CFC → the provenance WeakMap. The `getActionId` slice is low-risk +
  verifiable (68+147) but needs `getArtifactEntryRef`/patternManager plumbed
  into `getSchedulerActionId` (today `(state, action)`, no runtime handle).
  **The CFC slice is security-gated (red-team pass per spec line 555).**
- **C — `.src` lazy/debug-only + remove fallback + error** (Berni's "former" +
  point 2). Gated on A (cheap path correct) **and** B (no eager identity
  consumer of `.src`). Then `annotateFunctionDebugMetadata` defers
  `.src`/`.preview` behind a debug gate → cost 0. This is what fully banks the
  ~83ms.

### Status (updated 2026-06-30, late session)

**B is now implemented** (action identity re-rooted off `.src` onto
content-addressed `{ identity, symbol }`) and the **full runner suite is green
(721/0)**. The `.src`-derived `implementationHash` leak (the subtle part — see
the handoff's "lesson") is fixed: `applyImplementationHash` now derives from
provenance, and ids flipped `:line:col` → `:symbol`. Remaining: the
`.src`-garbled invariant harness, the 68+147 gate, dead-code cleanup
(`implementationHashForSource`), and the PR (red-team-gated). **Full detail +
resume mechanics:
[`B-IDENTITY-REROOT-HANDOFF.md`](./B-IDENTITY-REROOT-HANDOFF.md).**

A (source-map fix) and C (lazy `.src`) remain as separate, follow-on work; A is
the safe perf win once B makes `.src` non-load-bearing.

## 7. Caveats

- One trivial-boot profile per number (sampling profiler ~1ms granularity +
  profiling overhead). Relative buckets and call chains are unambiguous; exact
  ms have error bars — take 2–3 confirming runs before quoting externally.
- Function names are from bundled `worker-runtime.js`; **§5 mapping pending**.

## 8. Reproduce

```bash
# isolated inspectable toolshed (offset 20), isolated store
CACHE_DIR=$T/cache MEMORY_DIR=file://$T/cache/memory/ \
  ./scripts/start-local-dev.sh --port-offset 20 --inspect
# deploy+seed current main
packages/patterns/lunch-poll/perf-seed/seed.sh --no-art --api-url http://localhost:8020 ...
# agent-browser: Import-CLI-Key auth, then:
agent-browser --session s profiler start
agent-browser --session s eval "location.reload()"; agent-browser --session s wait 2500
agent-browser --session s profiler stop boot.json
python3 packages/patterns/lunch-poll/perf-seed/cpuprof4.py boot.json
# settle wall-time: reload + await commonfabric.viewSettled(), read performance.now()
```

## 9. Bucket #2 — RESOLVED (Fix A: content-addressed parse memo, 2026-07-01)

**Finding (direct in-worker instrumentation, offset-4 rig, current main).** Per
_cold_ boot, `buildRecordsFromCompiled` runs **5×**: 4× over the identical
**522KB / 9-module system-app closure** (one per system pattern loaded by
identity — `default-app` + `notebook`/`note`/`summary-index`/`backlinks-index`,
via `pattern-manager.ts` `loadPatternByIdentity` → `evaluateCachedModules`) plus
1× for the 2-module trivial pattern. Each call re-`createSourceFile`s every body
**twice** (`extractCompiledExports` for the export surface,
`extractRuntimeImports` for the require specifiers). So bucket #2 is **~99%
redundant re-parsing of identical content**, not one unavoidable parse:

| pass over the 9-module closure | pre-fix              | post-fix (Fix A)                 |
| ------------------------------ | -------------------- | -------------------------------- |
| 1st                            | 38.0ms               | 21.5ms (the one real parse)      |
| 2nd / 3rd / 4th                | 19.7 / 18.6 / 18.2ms | **0.0 / 0.0 / 0.0ms** (memo hit) |
| **total**                      | **94.5ms**           | **21.5ms**                       |

**Fix A (shipped — PR #4441).** A content-addressed memo (`exportParseCache` /
`importParseCache`) in `packages/runner/src/sandbox/module-record-compiler.ts`,
**keyed by the compiled body** (not the source `identity`: the same identity can
map to different compiled bytes across compilation modes / runtime versions, so
a body key is exact and cross-contamination is impossible — cf. cubic review).
The derivation is a pure function of the body, so the memo is safe across every
call, closure, and space. Collapses the boot re-parse to **one parse per
distinct body per worker** → **~73ms off the cold floor**. Gate: runner suite
728/0 + `pattern-tests` (68) + `generated-patterns` (147) green; regression
tests in `build-from-compiled.test.ts`.

**Why one parse and not zero.** A SES virtual module record is
`{ imports, exports, execute }` (`sandbox/esm-module-loader.ts`); the linker
needs the export _names_ and import _specifiers_ **before** `execute` runs. The
modules are compiled to CommonJS (no static export syntax), and the
content-addressed cache stores the compiled **code** (+ source map + import
_edges_) but **not** the derived export-name / full-import-specifier lists — so
the record surface is reconstructed by parsing the body on first sight. The one
parse is the cost of _not having persisted the derived record_.

**Fix B (shipped — PR #4442, stacked on #4441).** Persist the derived
`{ exportNames, starTargetSpecs, importSpecs }` onto the compiled document
(`CompiledDoc` in `compilation-cache/cell-cache.ts`), computed at cache-write by
`deriveModuleRecordFields` — the _compiled-JS_ scan, so persisted values are
byte-identical to what the boot parse would produce (handles the `cfc.ts`
ambient-exports divergence: source-analysis over-declares, the compiled scan
does not). `buildRecordsFromCompiled` reads them and parses only as a fallback
for legacy docs → **zero** parses on the warm-cache boot. The fields ride the
existing compiler **integrity atom** (label-based, not value-hashed), so the
integrity gate is unchanged. No manual runtime-version bump: `sandbox/` is in
the compiler fingerprint, so editing `module-record-compiler.ts` moves the
version → the compiled set recompiles once and every doc is rewritten with the
fields. Measured end-to-end (offset-4 rig): the 9-module system-app closure goes
`parsed=9 → parsed=0` on a warm-cache cold boot (the recompile boot writes the
fields; the next boot reads them). Gate: runner 729/0 + `pattern-tests` (68) +
`generated-patterns` (147) green; new test asserts a persisted surface that
disagrees with the body wins.

## 10. Session close (2026-07-01): #3 parked, #5 landed, and THE lever

Remaining floor after the #2 work (sizes from a fresh Fix-A+B cold-boot profile;
±few-ms single-profile noise):

| bucket                          | ~ms | status                                                                                 |
| ------------------------------- | --- | -------------------------------------------------------------------------------------- |
| #1 debug-metadata + source-maps | ~90 | **not ours** — identity/source-map thread (`gideon/content-addressed-action-identity`) |
| #2 TS-parse                     | 0   | **DONE** (§9): #4441 merged, #4442 open                                                |
| #3 schema intern+hash           | ~60 | **PARKED** (below)                                                                     |
| #4 SES harden                   | ~50 | untouched (SES-inherent)                                                               |
| #5 factory build                | ~40 | **partially landed** (#4447, below)                                                    |
| #6 esbuild glue                 | ~31 | untouched                                                                              |
| #7 quicksort                    | ~20 | untouched (still unexplained)                                                          |

**#3 schema intern — PARKED (low ROI).** Cold-boot instrumentation:
`internSchema` is called **54,806×** (88% object-cache hits); of the **5,081**
that hash, **4,463 (88%) are structural duplicates** (`hashOf` runs, then the
`hashToRef` reverse map finds the schema was already interned — same structure,
different object). ~36ms of ~41ms hash time is redundant. BUT the dups are
runtime- **constructed** schemas (ref-resolve, asCell-strip spread, ifc-attach),
not baked literals — so "bake the hash at build" is NOT the lever — and the
schema system is **already heavily memoized** (`traverse.ts` WeakMap ref-cache +
10k-capped string caches, non-thrashing at boot). The residual is diffuse
leakage; the only central lever (a cheaper pre-hash structural dedup in
`internSchema`) sits on CFC-identity- critical `data-model` code for a modest,
risky win. (`hashOf` is a deliberate full-tree walk; reusing sub-object hash
caches would change hash VALUES = identity.)

**#5 factory build — two fixes landed (PR #4447, off `main`).** (1) The
partial-cause dedup in `factoryFromPattern` was **O(N²)** (`deepEqual` scan over
every prior cause per internal cell; anonymous `$generated` causes are unique by
construction, so the scan is pure waste) → replaced with an O(1) `Set` of
canonical cause keys. ~0 at trivial N; a **scaling** fix for large patterns /
repeated instantiation. (2) Memoize `sanitizeSchemaForLinks` by frozen input
identity — deterministically measured **3.4 of 6.7ms** of `recursiveStrip` is on
frozen+repeated inputs (a single CPU profile's noise had masked it, so it was
verified by instrumenting the elidable work, not a profile delta). Also nibbles
#3 (fewer fresh `$defs` schemas to hash). The bigger factory cost —
`toJSONWithLegacyAliases` (~24ms serialization) — has no obvious quick win.

**THE lever (highest leverage, PARKED for Berni ~mid-July 2026):** #3/#4/#5 are
all "per-primitive / per-pattern processing of the **eagerly-loaded system
app**" that a trivial pattern never uses. The root fix is to **defer eager
system-app eval** — don't parse/hash/harden/factory-build the whole system-app
graph for a piece that doesn't need it. It cuts across #3+#4+#5 at once.
Architectural; wants Berni's input on whether eager full-system-app eval is a
deliberate constraint before it's picked up. **Recommended next-session focus
once he's back.**

## 11. Session 2026-07-01/02 (L rig, offset 12): #6 + #8 fixed, #7 dissolved, and the 4× closure-eval bug

Three PRs (independent, compose in any order): **#4455** (sourcemap compose),
**#4459** (defer compiler stack), **#4460** (single-flight by-identity load).
**Floor: ~497ms (that morning's main) → ~206ms with all three** (two profiled
cold boots each, ±2ms/bucket). Fresh table at the bottom.

**#7 "mystery quicksort" never existed as its own bucket.** The
`doQuickSort ← randomIntInRange` frames are mozilla source-map-js's
`parseMappings` sort. Root owners: (a) a slice inside #1's
`originalPositionFor`, (b) the majority under
**`composeBundleSourceMap ←
evaluateGraph ← evaluateCachedModules`** — a **~53ms
bucket ("#8")** the ~20ms attribution had hidden. Every cold boot composed the
closure's maps (engine.ts:878 bundle + :920 per-module, CT-1754 machinery) via a
consumer→generator round-trip (decode all mappings to objects, sort, re-encode,
JSON.parse) — and every registered map was parsed TWICE (compose's consumer +
the registry's lazy one).

**Fix (#4455):** streaming VLQ transcoder in `js-compiler/source-map.ts` —
per-segment integer decode/re-emit with delta rebasing; no objects, no sort, no
generator; legacy path kept as fallback for unprovable shapes (differential
tests incl. hostile streams). ~41 → ~10ms probed; bucket 53 → 16. **Regime
lesson (cost a round):** cached-boot maps are storage-backed PROXIES —
per-segment `.length` reads made v1 ~87ms (worse than legacy). Materialize map
fields into plain locals before hot loops; a proxy-read-budget test pins the
class. Retirement of the fallback is ticketed (CT-1816) gated on the
identity-arc migrations (maps are CFC-identity-load-bearing until then).

**#6 esbuild glue (#4459):** `typescript.js` is **10MB of the 14.3MB worker
bundle** with **~100 static importers** (metafile: 75 ts-transformers, 14
schema-generator, 7 runner, 4 js-compiler); every worker spawn paid the 10MB CJS
factory eval + ~100 × `__toESM`/`__copyProps` (~250k defineProperty) — while the
steady boot never compiles (post-#4441/#4442). Fix: sever all static value edges
— `runner/src/harness/compiler-stack.ts` is the ONLY static importer, behind one
memoized dynamic import (`deferred-compiler-stack.ts`; sync internals via a
THROWING accessor so a missed `ensureCompilerStack()` fails loud); ts-free
subpaths (`js-compiler/{program,specifier,errors}`,
`ts-transformers/runtime-contract`); type-only imports stay put (erased).
Metafile-assert: no static entry→typescript path. Bucket 34 → 0 **plus ~17ms**
hidden factory eval from "(other)" (`__require2` 13.5 → 2.4 self). Bytes still
ship — code-splitting ticketed (CT-1817; worker is already a module worker,
exactly one dynamic edge).

**The big one (#4460), found by re-deriving parked #3:** the "88% redundant
schema hashes" were not diffuse leakage — **the same 9-module closure was fully
evaluated 4× per cold boot.** Timestamped probes: four identical
`loadPatternByIdentity(entry, "default")` calls in the same ms (one per
referencing piece), all miss `addressableByIdentity` (dedups COMPLETED loads
only), four concurrent `evaluateCachedModules` — re-creating every schema
literal (intern dups: fresh 618 ≈ one eval; 3×618 re-exec + ~650/eval derivation
dups ≈ the 4,460), every annotation, harden, factory, compose. The ifc-attach
memo idea is a DEAD END (`schemaWithLub` runs 0× at boot — no confidentiality
atoms flow). Fix: single-flight the load tail per `(space, entryIdentity)`
mirroring `inProgressCompilations`; followers re-enter the front door and hit
the leader-populated index — the pre-existing arrived-later path, so concurrency
now converges to sequential semantics. Concurrency regression test: two-runtime
fixture (tx must be committed; keep BOTH runtimes alive — disposing A first
tears down shared emulated storage).

**Fresh bucket table** (trivial pattern, worker busy; "before" = 2026-07-01
main):

| bucket        | before | +#4455 | +#4459 | +#4460 (all) |
| ------------- | ------ | ------ | ------ | ------------ |
| #1 debug-meta | 98     | ~103†  | ~103   | **25**       |
| #3 intern     | 80     | 78     | 78     | **35**       |
| #4 harden     | 49     | 48     | 47     | **13**       |
| #5 factory    | 38     | 37     | 38     | **12**       |
| #6 glue       | 34     | 34     | **0**  | 0            |
| #8 compose    | 53     | **16** | 22‡    | 22           |
| (other)       | 142    | 139    | 122    | **95–97**    |
| **TOTAL**     | ~497   | ~462   | ~441   | **~206**     |

† ~6ms consumer-parse migrated from #8 into #1's lazy first-lookup (dies with
lazy-`.src`). ‡ #4459's rig lacked #4455 (separate branches); combined ≈ ~16/4.

**Rig gotchas added this session:** agent-browser auth/localStorage can
evaporate after sleep/renderer crash — re-import cf.key (snapshot immediately
before `upload`, refs go stale); profiler `stop <file>` writes relative to the
DAEMON's cwd — use absolute paths; `viewSettled` can resolve before module eval
(warm) — classify cold by `evaluateCachedModules` presence in the profile;
in-worker `new Error().stack` is SES-censored for compartment-driven calls —
per-site attribution needs value tags/counters, not stacks; CI "Performance
Check" failures here were coverage-debt (new defensive branches), answered with
real tests, not baselines.

**State after this session:** floor ~206ms. Remaining: #3 ~35 (true residual —
per-eval derivation dups within the single eval), #1 ~25 (identity thread), #8
~16-22 (residual transcode + lazy parse; dies further with C), #4 ~13, #5 ~12,
other ~95. **~200 is banked; below ~150 needs defer-eager-system-app (Berni).**
Tickets: CT-1815 (directive regex decision), CT-1816 (retire compose fallback),
CT-1817 (code-split worker bundle).
