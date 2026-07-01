# Pattern initial-load — the per-piece runtime **boot floor** (current main, 2026-06-30)

**Status (2026-07-01):** B (identity re-root) is DONE + PR'd as **#4436** (pending
Berni). The ~83ms lever — C, make `.src` lazy — is NEXT but **gated on re-rooting
the CFC `.src` fail-closed read first** (see below §6 + the focused seed
[`PART-B-LAZY-SRC-HANDOFF.md`](./PART-B-LAZY-SRC-HANDOFF.md), and the master
handoff's STATUS UPDATE). _(Original 2026-06-30 status: measured & attributed on
`main`, no fix applied; the #1 lever mapped to source.)_

**Supersedes [`SLOW-LOAD-FINDINGS.md`](./SLOW-LOAD-FINDINGS.md)**, which measured
the *old* lunch-poll (pre web-search/art removal, pre storm/VDOM/resume fixes)
and is now stale — its lunch-poll-specific drivers are fixed or gone.

---

## TL;DR

The "lunch poll takes ~1s to load" is **~92% a generic per-piece boot floor that
every pattern pays**, not the lunch poll. A trivial 1-`div` pattern loads in
**~662ms**; an empty lunch poll **~678ms**; the full 10-option/35-vote/4-user
poll **~738ms** (the pattern's own data adds **~60ms**; inline art adds **~0ms**,
re-confirming the old art exoneration). The floor is the runtime **evaluating the
module graph inside a SES Compartment** — for a trivial user pattern it is all
runtime + **system-app** machinery (`default-app.tsx` + `notebook/note/
summary-index/backlinks-index` are loaded at boot). The time is in
`worker-runtime.js` (~578ms of a ~640ms busy worker), in a handful of
per-module / per-primitive buckets. **The top single lever is eager
per-`lift`/`handler` debug-metadata source annotation (~100ms,
`getLineAndColumnAtOffset`)** — the same function the old doc flagged as an
"unexplained anomaly."

This is a **runtime / ts-transformers / SES** finding. Optimizing pattern code
(tally fan-out, per-option cards, vote-commit churn) would move load by ~8%.

---

## 1. Method (all client-side, read-only)

- Isolated offset-20 toolshed with `--inspect` (`start-local-dev.sh
  --port-offset 20 --inspect`), **isolated `CACHE_DIR`/`MEMORY_DIR`** so it does
  not share the default `:8000` instance's SQLite store (the start script
  offsets ports but **not** the data dir — a real footgun).
- Deploy/seed current main via [`seed.sh`](./seed.sh) (`--empty | --no-art |
  full`).
- `agent-browser` (`/opt/homebrew/bin`): `--session` with Import-CLI-Key auth,
  `eval` for the page `commonfabric` debug API, `trace`, and `profiler`.
- **Settle wall-time** = `commonfabric.viewSettled()` (resolves on `getRt().idle()`)
  measured via `performance.now()` after `location.reload()` (identity persists).
- **Worker attribution** = `agent-browser profiler` — note its output is a
  *trace* with `ProfileChunk` events (spans navigation, covers workers), not a
  flat `.cpuprofile`. The runtime worker's samples land on a `v8:ProfEvntProc`
  thread; parse by isolate and pick the one whose frames are in
  `worker-runtime.js`. Parser: [`cpuprof4.py`](./cpuprof4.py) (self + inclusive +
  caller chains via the node `parent` field).

**Instrument note (validate before trusting):** the old doc's
`commonfabric.rt.getGraphSnapshot()` **no longer exists**; `commonfabric.rt` is
now just an event bridge. Current API: `getLoggerCountsBreakdown`,
`getTimingStatsBreakdown`, `viewSettled`, `vdom`, `detectNonIdempotent`,
`watchWrites`, `explainTriggerTrace`.

## 2. The reframe — load is a fixed floor, not scale/art

| load | settle (3 cold reloads) | Δ |
|---|---|---|
| trivial 1-`div` pattern | 656 / 656 / 675 (~662) | — |
| empty lunch poll (0/0/0) | 599 / 730 / 705 (~678) | +16 over trivial |
| 10 opt / 35 votes / 4 users, no art | 700 / 756 / 757 (~738) | **+60 (pattern data)** |
| + 63 KB inline art payload | 695 / 758 / 756 (~736) | **+0 (art exonerated)** |

Document/first-paint is fast (DOMContentLoaded 134ms, FCP 168ms); the ~0.7s is
graph settle *behind* the paint.

**Vs the stale doc (old pattern):** RunMicrotasks 694ms (was ~2,225), GC ~46ms
(was 600–900), **VDOM apply-batches = 1** (was 117–164). The egregious old
slow-load was real and is fixed (#4360 storm, #4366 VDOM settling, #4367
read-mostly resume, #4325 art, #4326 web-search); the boot floor underneath is
what remains.

## 3. The boot floor, attributed (trivial-pattern worker isolate: ~640ms busy)

Inside `evaluateCachedModules` (~459ms inclusive) → `compartmentImportNow` /
`populateModuleExports` (SES Compartment module eval):

| bucket | ~ms | caller chain (top) | lever |
|---|---|---|---|
| **Per-primitive debug-metadata** | **~100** | `getLineAndColumnAtOffset` ← `findMappedLocationInSourceRange` ← `resolveLocationFromFunctionSource` ← `annotateFunctionDebugMetadata` ← `lift`/`handler` ← `populateModuleExports` | **#1: precompute locations at transform time, or defer annotation until a trace needs it** |
| **Module record extraction (TS parse)** | ~102 | `parseSourceFile`/`createSourceFile2` ← `extractCompiledExports` ← `buildRecordsFromCompiled` ← `evaluateCachedModules` | precompute records at build; avoid in-worker re-parse |
| **Per-primitive schema intern+hash** | ~68 | `internSchema`/`computeHash`/`joinSchema`×N ← `applyArgumentIfcToResult` ← `createNodeFactory` ← `lift` | cache/precompute interned schemas |
| **SES harden + lockdown** | ~50–67 | `baseFreezeAndTraverse` ← `harden` ← `hardenExportedValue` ← `populateModuleExports` (per export); `lockdown` ← `ensureSESLockdown` (once) | SES-inherent; per-export harden maybe trimmable |
| **Pattern factory build** | ~60–100 | `factoryFromPattern`/`pattern`/`trustedPattern` + `sanitizeSchemaForLinks` | only-load-what's-needed |
| **esbuild CJS→ESM glue** | ~31 | `__copyProps` ← `__toESM` ← (root) | bundling (pure-ESM avoids `__toESM`) |
| **quicksort w/ random pivot** | ~20 | `randomIntInRange` ← `doQuickSort` (something sorts a largish list at boot) | investigate — odd |

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
- `annotateFunctionDebugMetadata` (`:552`) → `getExternalSourceLocation` (`:192`)
  captures **`new Error().stack` per primitive**; at module-eval the frame points
  into the bundle and maps to nothing, so it falls back to
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

**`.src` & identity — resolved with the authors (2026-06-30, seefeld via Discord).**
`fn.src` *used to* be each builder's stable identity, but **hoisting changed that**:
the per-module content-addressed **`implementationHash`** is now the preferred
fingerprint (`action-run.ts:728` — "`.src` … is the fallback"), and each hoisted
`__cfLift_N` carries a stable module-identity + name. So `.src` is **no longer
needed for identity** and can be made lazy / debug-only. seefeld's directive:
**"remove the fallback and error instead."**

Implementation caveat (flagged back to the authors): `getSchedulerActionId`
(`diagnostics.ts:38`) still returns `.src` first, then **bare `.name`**, which
collides across modules (each re-numbers `__cfLift_1..N`); and
`implementationHashForSource` (`engine.ts:1271`) currently derives the hash by
parsing `.src`. So removing the `.src` fallback safely means **re-rooting the
action id on module-identity + name** (Berni's exact phrasing), not letting it
fall through to bare `.name`. (An earlier note here said "`.src` is load-bearing,
must preserve it" — true of the *current* code, but superseded by this direction:
re-root identity, then drop `.src` from the hot path.)

### Validation (2026-06-30)

Short-circuiting `annotateFunctionDebugMetadata` entirely (runner edit, rebuilt
`worker-runtime.js`, re-measured) **confirms the lever**: `getLineAndColumnAtOffset`
**80.6ms → absent**, worker busy **640ms → 538ms**, trivial settle **~662ms →
~579ms (−83ms, reproducible 592/571/574)**. This proves the cost; it is **not** a
valid fix (it drops `.src`, changing action identity). The achievable win is
~83ms *if `.src` is preserved*.

### Fix — author-settled direction (NOT a transformer change)

Earlier drafts here considered transform-time position injection (and debated
compiled-vs-original positions). **Superseded:** the authors confirmed `.src`
isn't needed for identity, so we don't inject positions at all. The fix is in the
runner:

1. **Re-root `getSchedulerActionId` on module-identity + name** (`diagnostics.ts:38`)
   so the stable action id no longer routes through `.src`. (Mind the bare-`.name`
   cross-module collision above.)
2. **Remove the expensive `resolveLocationFromFunctionSource` fallback**
   (`module.ts:560`) — error/skip instead, per seefeld. → the **~83ms**.
3. **Make `.src` / source-location lazy & debug-only** (compute only when
   debugging is on → cost 0 normally), and **fix the cheap source-map path**
   (`getExternalSourceLocation`) so it yields the location when needed — the
   "source maps broke" thread (Gideon is taking this).
4. **Verify**: action-id + fingerprint stability before/after across
   `pattern-tests` (68) + `generated-patterns` (147), plus the boot re-measure
   (expect ~83ms). The short-circuit experiment (above) is the cost upper-bound.

Separately, the TS-parse (~102ms, `buildRecordsFromCompiled` → `createSourceFile`)
and schema-intern (~68ms) are the same "do it at build, not boot" shape — later
levers behind this one.

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
  spec **mandates a red-team security pass** for CFC identity changes (line 555).
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
  ("persist across action recreation" *within a session*, `scheduler.ts:311`),
  the breakpoints Set, debounce keys, telemetry. Ephemeral → re-rooting is low
  risk.
- Durable identity already uses content-addressed `implementationHash` / the CFC
  provenance WeakMap. **CFC verified-source is the one security-sensitive surface**
  — spec-gated behind a red-team pass.

### Empirical: the cheap path is broken (Berni point 1) — `cf check` on lunch-poll
- **64 of 82 primitives hit the expensive fallback**; only 18 take the cheap
  stack path.
- The fallback produces **correct** canonical `cf:module/<hash>/path` locations.
- The 18 cheap "successes" return the **wrong** location —
  `runner/src/module.ts:138:10` (the runtime factory frame, identical for all 18
  → they would *collide* as identities). `INTERNAL_SOURCE_LOCATION_FRAME_PATTERNS`
  (`module.ts:106`) filters `factory.ts` but not `module.ts`, and the eval-time
  stack frames mostly don't canonicalize (the CT-1754 mechanism, `engine.ts:900-926`).
- ⟹ The cheap path is frequently-null **and** actively-wrong; the fallback is
  currently the only correct source. **"Remove the fallback" (Berni's "former")
  must wait until the cheap path is fixed** — naive removal would break/collide ids.

### The proper set of fixes (sequenced)
- **A — Fix the cheap source-map path** (Berni point 1; Gideon's thread). The
  **safe** ~83ms (preserves `.src` exactly, no identity/CFC change). NON-trivial:
  real bug — the cheap path returns the factory frame and most eval-time frames
  don't canonicalize. Independently shippable. **Recommended first win.**
- **B — Re-root identity off `.src`** (Berni's "the latter," architectural).
  `getSchedulerActionId` → `getArtifactEntryRef(factory)` `{ identity, symbol }`;
  `implementationHash` sourced from the content address directly; CFC → the
  provenance WeakMap. The `getActionId` slice is low-risk + verifiable (68+147)
  but needs `getArtifactEntryRef`/patternManager plumbed into `getSchedulerActionId`
  (today `(state, action)`, no runtime handle). **The CFC slice is security-gated
  (red-team pass per spec line 555).**
- **C — `.src` lazy/debug-only + remove fallback + error** (Berni's "former" +
  point 2). Gated on B (done) **AND — the red-team's key addition — re-rooting the
  CFC `.src` fail-closed read** (`cfc/implementation-identity.ts`
  `resolveProvenanceImplementationIdentity`, which returns `unsupported` and denies
  `writeAuthorizedBy` when `.src` doesn't parse-and-match provenance). Without that
  re-root, lazy `.src` flips CFC `verified → unsupported` → verified writes denied.
  Then `annotateFunctionDebugMetadata` defers `.src`/`.preview` behind a debug gate
  → cost 0. This is what fully banks the ~83ms. **Focused seed:
  [`PART-B-LAZY-SRC-HANDOFF.md`](./PART-B-LAZY-SRC-HANDOFF.md).**

### Status (updated 2026-06-30, late session)
**B is now implemented** (action identity re-rooted off `.src` onto
content-addressed `{ identity, symbol }`) and the **full runner suite is green
(721/0)**. The `.src`-derived `implementationHash` leak (the subtle part — see
the handoff's "lesson") is fixed: `applyImplementationHash` now derives from
provenance, and ids flipped `:line:col` → `:symbol`. **(2026-07-01) All remaining
steps are DONE and it is PR'd as #4436** (the harness, the 68+147 gate, the
dead-code cleanup, the red-team pass, a Cubic/CI round) — plus a red-team-surfaced
**per-instance action-id collision fix** (`schedulerInstanceKey`). **Full detail +
resume mechanics: [`B-IDENTITY-REROOT-HANDOFF.md`](./B-IDENTITY-REROOT-HANDOFF.md);
current status: the master handoff's STATUS UPDATE.**

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
