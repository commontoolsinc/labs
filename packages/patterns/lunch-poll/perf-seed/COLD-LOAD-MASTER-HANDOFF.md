# Master Handoff — Cold-load investigation (2026-06-30)

**Read this first.** It is the index + carry-forward plan for the cold-load
(pattern initial-load) investigation. Detail lives in two sibling docs; this doc
ties them together and lays out the three forward workstreams.

- **[`BOOT-FLOOR-FINDINGS.md`](./BOOT-FLOOR-FINDINGS.md)** — the perf arc, the
  boot-floor root cause, the CPU-profile decomposition, the fix design.
- **[`B-IDENTITY-REROOT-HANDOFF.md`](./B-IDENTITY-REROOT-HANDOFF.md)** — the
  implemented fix (B), its exact diff, remaining steps, design flags.

Branch: `gideon/lunch-poll-load-investigation` (off `main`). Memory pointer:
`project_lunchpoll_bootfloor_identity.md`.

---

## 0. TL;DR — the one finding that reframes everything

The "lunch poll takes ~1s to load" is **~92% a generic per-piece runtime boot
floor (~670ms) that EVERY pattern pays** — not the lunch poll. Measured on
current `main`, settle wall-time (`commonfabric.viewSettled()`):

| load                        | settle | Δ                   |
| --------------------------- | ------ | ------------------- |
| trivial 1-`div` pattern     | ~662ms | —                   |
| empty lunch poll (0/0/0)    | ~678ms | +16                 |
| 10 opt / 35 votes / 4 users | ~738ms | +60 (pattern data)  |
| + 63 KB inline art          | ~736ms | +0 (art exonerated) |

So the whole cold-load problem is **the runtime boot floor**, and optimizing
pattern code barely moves it. The floor is the runtime evaluating the system-app
module graph in a SES Compartment; the CPU profile breaks it into ~7 buckets
(§3). Three forward workstreams fall out:

1. **Land B** — content-addressed action identity (removes the #1 lever's
   dependence on `.src`). _Implemented, runner-green, pre-PR._
2. **A → C** — fix the source maps, make `.src` lazy → bank the #1 lever (~83ms)
   off the critical path.
3. **The other 6 buckets** — TS-parse, schema-intern, SES-harden,
   pattern-factory, module-glue, mystery-quicksort — each its own intensive
   investigation + fix.

---

## 1. How to reproduce / the measurement rig (you will need this for all 3)

**Two harnesses, two purposes:**

- **Path A — headless `lunch-poll-diagnose.ts`** (in-process Web Worker
  runtimes, `MultiRuntimeHarness`, NO browser/toolshed).
  `deno run -A
  packages/patterns/tools/lunch-poll-diagnose.ts --cases=10x5 --rounds=3`.
  Fast, deterministic; good for the reactive-graph/commit-churn axes. Caveat:
  in-process may not reproduce real-async effects
  ([[reference_reactive_conflict_strand_repro]]).
- **Path B — real toolshed + browser** (what cold-load actually is). Recipe:

```bash
# Isolated, inspectable offset-20 toolshed (FOOTGUN: start-local-dev.sh offsets
# PORTS but not the data dir — you MUST isolate CACHE_DIR/MEMORY_DIR or you share
# the default :8000 store):
CACHE_DIR=$T/cache MEMORY_DIR=file://$T/cache/memory/ \
  ./scripts/start-local-dev.sh --port-offset 20 --inspect   # 8020 / 5193 / insp 9249
# Deploy + seed current main (perf-seed/seed.sh: --empty | --no-art | full):
packages/patterns/lunch-poll/perf-seed/seed.sh --no-art --api-url http://localhost:8020 ...
# agent-browser (Import-CLI-Key auth), then per measurement:
agent-browser --session s profiler start
agent-browser --session s eval "location.reload()"; agent-browser --session s wait 2500
agent-browser --session s profiler stop boot.json
python3 packages/patterns/lunch-poll/perf-seed/cpuprof4.py boot.json   # self+inclusive+callers
# Settle wall-time: reload + await commonfabric.viewSettled(); read performance.now()
```

**Instrument gotchas (all real, all cost time if rediscovered):**

- `commonfabric.rt.getGraphSnapshot()` (the old `SLOW-LOAD-FINDINGS.md` tool) is
  **GONE**. Current debug API: `getLoggerCountsBreakdown`,
  `getTimingStatsBreakdown`, `viewSettled` (= `await getRt().idle()`), `vdom`,
  `detectNonIdempotent`.
- `agent-browser profiler` emits a **trace with `ProfileChunk` events**, not a
  flat `.cpuprofile`; the runtime worker's samples land on a
  **`v8:ProfEvntProc`** thread (pick the isolate whose frames are in
  `worker-runtime.js`). The parsers in this dir (`cpuprof2/3/4.py`) handle this
  — nodes use a `parent` ref, not `children`.
- `--skip-refresh` in the diagnose tool is **inert** (no `refresh` handling
  exists).
- Read-site `main.tsx:line:col` from the diagnose tool are
  **transformed-output** positions — don't trust them; only symbolic sites
  (`sink:result`, the `poll-opt` action) are reliable.
- The dev toolshed serves `/scripts/worker-runtime.js` by **proxying to the
  shell** (felt build); `felt watchDir` is `shell/src` only, so a **runner edit
  needs a shell restart** to rebuild the worker bundle (with the isolation env
  re-passed).

**The cheapest validation of any boot fix:** the trivial-pattern settle
re-measure (baseline ~662ms). The CPU profile attributes WITHIN that. Always
confirm a fix is _observable_ (revert + re-measure) — see
[[validate-fix-is-observable]].

---

## 2. The two scaling laws (path-A, for context / the other lunch-poll thread)

Separate from cold-load, the diagnose tool established (confound-broken, users
vs options isolated):

- **Render/graph cost is LINEAR in options** (+55 nodes / +22 computeds / ~+155
  edges per option, exact), replicated per user. `tallyOptions` O(opt×votes) +
  per-card `votes.find` are real but bounded.
- **Commit churn is ~QUADRATIC in concurrent voters** (exponent ~1.87; 68→1428
  for 2→10 voters at fixed options; flat in options). `conflicts == reverts` is
  a structural identity under `CF_CONFLICT_ADMISSION=off`. **Magnitude needs
  path-B validation** (in-process may understate). This is the
  lunch-poll-specific scalability story (not cold-load); pick it up if
  multi-user perf becomes the focus.

---

## 3. The boot-floor decomposition (workstream 3's map)

From the CPU profile of a **trivial** pattern's worker isolate (~640ms busy; all
of it is runtime + **system-app** machinery — `default-app.tsx`,
`notebook/note/
summary-index/backlinks-index` load at boot; the pattern code
itself is ≤0.6ms). Inside `evaluateCachedModules` (~459ms) →
`compartmentImportNow` / `populateModuleExports`:

| # | bucket                                  | ~ms     | mechanism (caller chain)                                                                                                                                                            | fix direction                                                                                                    |
| - | --------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1 | **Per-primitive debug-metadata**        | ~100    | `getLineAndColumnAtOffset` ← `findMappedLocationInSourceRange` ← `resolveLocationFromFunctionSource` ← `annotateFunctionDebugMetadata` ← `lift`/`handler` ← `populateModuleExports` | **B (done) + A + C** below                                                                                       |
| 2 | **Module record extraction (TS parse)** | ~102    | `parseSourceFile`/`createSourceFile2` ← `extractCompiledExports` ← `buildRecordsFromCompiled` ← `evaluateCachedModules`                                                             | runtime runs the **TS parser in-worker** at boot to build records — precompute records at build / avoid re-parse |
| 3 | **Per-primitive schema intern+hash**    | ~68     | `internSchema`/`computeHash`/`hashOf`/`joinSchema`×N ← `applyArgumentIfcToResult` ← `createNodeFactory` ← `lift`                                                                    | cache/precompute interned schemas (content-address?)                                                             |
| 4 | **SES harden + lockdown**               | ~50–67  | `baseFreezeAndTraverse`/`harden`/`hardenExportedValue`/`markHardened`/`freeze6` ← `populateModuleExports` (per export); `lockdown` ← `ensureSESLockdown` (once)                     | SES-inherent; per-export harden scope maybe trimmable                                                            |
| 5 | **Pattern factory build**               | ~60–100 | `factoryFromPattern`/`pattern`/`trustedPattern` + `sanitizeSchemaForLinks`/`toJSONWithLegacyAliases`/`recursiveStripAsCellFromSchema`                                               | only-build-what's-needed                                                                                         |
| 6 | **esbuild CJS→ESM glue**                | ~31     | `__copyProps` ← `__toESM` ← (root)                                                                                                                                                  | pure-ESM bundling avoids `__toESM`                                                                               |
| 7 | **mystery quicksort**                   | ~20     | `randomIntInRange` ← `doQuickSort` (something sorts a largish list at boot)                                                                                                         | **investigate** — odd, unexplained                                                                               |

**The cross-cutting lever (highest-leverage open question):** every one of these
is the runtime's _per-module / per-primitive_ processing applied across the
**whole loaded module graph** — and a trivial pattern loads the **full system
app**. So: **does the entire system-app module graph need to evaluate eagerly at
every piece load?** Deferring/lazy-loading system patterns not needed for the
current piece would cut across buckets 2–5 at once. This is probably worth
scoping BEFORE grinding each bucket individually.

---

## 4. WORKSTREAM 1 — Land B (identity re-root)

**Status: implemented, full runner suite green (721/0), pre-PR.** Everything is
in **[`B-IDENTITY-REROOT-HANDOFF.md`](./B-IDENTITY-REROOT-HANDOFF.md)** — the
6-file diff, what each change does, what's verified. Remaining, in order:

1. **`.src`-garbled invariant harness** (build this FIRST — it would have caught
   the `implementationHash` `.src`-leak instantly; see the handoff's "lesson").
   An e2e test: run a representative pattern, capture all action ids /
   fingerprints / CFC identities, run again with `.src` deliberately garbaged (a
   test hook on `annotateFunctionDebugMetadata`), assert **byte-identical** + no
   collisions + suites green. It should pass now; it proves the invariant.
2. **Gate:** `deno task integration pattern-tests` (68) + generated-patterns
   (147) — identity/schema changes need the runtime gate
   ([[feedback_schema_changes_need_runtime]]). Plus full `fmt --check` + `lint`.
3. **Cleanup:** `implementationHashForSource` (`engine.ts:1271`,
   `harness/types.ts:217`) is now **dead** — remove it. Decide
   `identityFromCanonicalSource` (`verified-provenance.ts:96`, still the `.src`
   guard in `recordModuleProvenance`, `engine.ts:1053`).
4. **PR** — small, contained, **merge-gate = red-team review** (the spec
   mandates it for CFC identity changes). Red-team flags in §8.

---

## 5. WORKSTREAM 2 — A → C: get `.src` off the cold-load critical path

This is what actually **banks the ~83ms** (B is the prerequisite that makes it
safe). The pieces and their dependencies:

### C — make `annotateFunctionDebugMetadata` lazy (the perf win)

Now that B made `.src` non-load-bearing for identity, the eager per-primitive
annotation can be **gated behind a debug flag** (Berni: "lazy evaluated once
debugging is turned on — then the cost is 0"). Default off →
`getLineAndColumnAtOffset` et al. don't run at boot → ~83ms saved. Subtleties to
design:

- The expensive `.src` resolution needs **eval-time context** (the creation
  stack / `sourceLocationContext`), which is gone later — so "lazy" can't mean
  "defer the whole resolution to debug-time" unless A (cheap source-map path)
  works. Cleanest C: **skip annotation entirely at boot unless a debug flag is
  set** (most loads never debug); when debug is on, annotate eagerly (today's
  behavior).
- **Dependency / risk:** `recordModuleProvenance` (`engine.ts:1053`) still
  _reads_ `.src` as a cross-module mismatch **guard**. If `.src` is lazy (unset
  at boot), the guard becomes a no-op (skips on undefined). That may **weaken**
  the re-exporter-spoof defense — re-root the guard onto provenance, OR keep
  `.src` available for the guard. **Coordinate with Berni / the red-team pass.**

### A — fix the cheap source-map path (correctness + debug quality)

Independent of C; lower urgency once `.src` is off the critical path.
**Empirical root cause (instrumented, `cf check` on lunch-poll):** the cheap
stack path (`getExternalSourceLocation`) fails for **64/82** primitives (→
expensive fallback), and its 18 "successes" return the **WRONG** location
(`runner/src/module.ts:138`, the runtime factory frame — they'd collide). So the
cheap path is both frequently-null AND actively-wrong; the expensive fallback is
currently the only correct source. Mechanism to dig into: `engine.ts:900-926`
loads per-module source maps (incl. an identity-map fallback for cached bodies,
CT-1754), but the cheap path's `new Error().stack` frames aren't canonicalizing
— `INTERNAL_SOURCE_LOCATION_FRAME_PATTERNS` (`module.ts:97`) filters
`factory.ts` but not `module.ts`, and the eval-frame sourceURL/line-shift
handling is suspect. **This is "Gideon's thread" per the Discord exchange.**
Fixing it makes any on-demand `.src` correct + cheap (and lets the expensive
fallback be removed + error, per Berni — but only AFTER the cheap path works).

**Sequencing:** B (done) → **C banks the perf** → A is the debug-quality
follow-on. (You can do A before C if you want lazy `.src` to use a fixed cheap
path rather than the slow fallback on demand — but it's no longer load-bearing.)

---

## 6. WORKSTREAM 3 — the other 6 boot-floor buckets (the bulk of cold-load)

> **STATUS (2026-07-01, EOD).** #2 TS-parse **DONE** (#4441 merged + #4442 open,
> `parsed=9→0`). #5 factory **partially landed** (#4447: O(1) partial-cause
> dedup
>
> - sanitize memo). #3 schema-intern **PARKED** (88% redundant hashes, but the
>   schema system is already heavily memoized; low ROI). #1 is the identity/
>   source-map thread's. #4/#6/#7 untouched. **The cross-cutting lever below
>   (item 1 — defer eager system-app eval) is confirmed the highest-leverage
>   next move and the recommended next-session focus — PARKED for Berni's input
>   (~mid-July 2026).** Full detail: `BOOT-FLOOR-FINDINGS.md` §9–§10.

The B/A/C work addresses bucket #1 (~100ms). Buckets #2–#7 (~330ms+) are the
rest of the floor and each deserves the **same intensive treatment**:
CPU-profile attribution → caller chains → root-cause → fix → **trivial-pattern
boot re-measure** to confirm the win is observable. Suggested order (impact ×
tractability):

1. **Scope the cross-cutting lever first** (§3): instrument which system-app
   modules actually load at boot and whether the current piece needs them. If
   most of buckets 2–5 is "evaluating system patterns the piece doesn't use," a
   lazy/deferred system-app load is one fix for several buckets. Probe: log
   `evaluateCachedModules` / `populateModuleExports` per module identity at
   boot.
2. **#2 TS-parse-in-worker (~102ms)** — why does `buildRecordsFromCompiled` run
   the TS parser (`createSourceFile`) at boot when modules are already compiled?
   Likely re-deriving export records from source. Candidate: persist records at
   compile, skip the re-parse. (Read `sandbox/module-record-compiler.ts`.)
3. **#3 schema intern+hash (~68ms)** — per-`lift` `joinSchema`/`internSchema`/
   `computeHash`. Candidate: content-address + cache interned schemas across
   loads.
4. **#4 SES harden (~50-67ms)** — mostly inherent, but check whether per-export
   `hardenExportedValue` over-traverses (the `recursiveStripAsCellFromSchema` /
   `traverseValue` chain). lockdown is once-per-worker.
5. **#5 pattern-factory (~60-100ms)** and **#6 module-glue `__toESM` (~31ms)** —
   bundling/instantiation shape; #6 is a pure-ESM-output question.
6. **#7 the quicksort (~20ms)** — `doQuickSort ← randomIntInRange` at boot is
   genuinely unexplained; find what's being sorted (schema keys? a registry?).

For each: the method is the same one that worked here — **fan out a Workflow for
multi-lens analysis if doing a deep dimension, but VERIFY load-bearing claims
yourself** ([[feedback_dont_trust_subagent_diagnosis]]), and gate every
conclusion on the boot re-measure. The buckets overlap (e.g.
annotation+schema+harden all per- primitive), so a single change can move
several.

---

## 7. State / resume mechanics (exact)

- **Branch** `gideon/lunch-poll-load-investigation`. **B diff = 6 files in
  `packages/runner`** (3 src, 3 test), `+103/−35`, all UNSTAGED. Verified green.
- `main.tsx` shows modified ONLY because it was refreshed to `origin/main` for
  the rapids deploy (the #4404 cast tweak) — not part of B.
- **Art re-add** (#4325 render-only comeback, unrelated to cold-load) shelved in
  `stash@{0}`.
- **perf-seed/ is UNTRACKED** — this doc, `BOOT-FLOOR-FINDINGS.md`,
  `B-IDENTITY-REROOT-HANDOFF.md`, the `cpuprof*.py` parsers, `seed.sh` + data.
  The working tree persists across conversations, but **commit these (and the B
  diff) to the branch for durability** before relying on them in a fresh
  session.
- **Offset-20 toolshed rig** may still be up (8020 / 5193 / insp 9249, isolated
  store in scratch); it currently serves a **short-circuited**
  `worker-runtime.js` (from the C-validation experiment) — rebuild from clean
  runner if reused.
- **Rapids:** latest-main lunch-poll deployed to a fresh space
  `lunch-2026-06-30-1138` (empty). Recipe in [[reference_rapids_deploy]].

---

## 8. Open design questions for the authors (Berni / seefeld)

1. **Discriminator = `symbol`** (`__cfLift_N`/export name), not the spec's
   stated `:line:col` (which is `.src`-derived). `.src`-free and matches CFC's
   `{ moduleIdentity, symbol }` (spec §3); changes id _values_. Bless it?
2. **`recordModuleProvenance` `.src` guard** (`engine.ts:1053`) — keep as a
   guard (reads `.src` but never derives identity from it) or retire it?
   Interacts with C (lazy `.src` weakens it).
3. **B sets `implementationHash` at action-creation from provenance** (vs. the
   spec's framing). Confirm that's the intended shape.
4. **Source-map root cause** (workstream 2/A) — Berni's "source maps broke"
   thread; the cheap path is wrong (`module.ts:138`) + null for most primitives.
5. **The cross-cutting lever** (§3/§6.1) — is eager full-system-app eval at
   every piece load a deliberate constraint, or fair game to defer?

---

## 9. Methodology that made this work (carry the stance, not just the facts)

- **Scout inline → orchestrate → adversarially verify.** The path-A cost-driver
  analysis ran as a Workflow (4 lenses → per-driver numbers-skeptic + mechanism-
  skeptic → synthesis) and it CORRECTED several confident-but-wrong claims (the
  "O(N²) fan-out" was metric-mixing; the per-card rank quadratic was
  non-binding). [[feedback_verify_full_comparison_before_sole_cause]].
- **Validate the instrument before trusting it** — the debug API had drifted
  (`getGraphSnapshot` gone); the stale `SLOW-LOAD-FINDINGS.md` was pre-fixes and
  wrong for current main. Re-derive on current `main`; don't inherit
  conclusions.
- **Validate every fix is observable** — short-circuit experiment proved the
  ~83ms lever before building anything; the `:3:20`→`:double` id flip proved B's
  leak fix. [[validate-fix-is-observable]].
- **Verify load-bearing claims directly** — the `implementationHash` `.src`-leak
  passed all tests; it was caught by inspecting the emitted id + grepping the
  assignment site, not by green. [[feedback_dont_trust_subagent_diagnosis]].
- **Build the invariant harness FIRST** for the next identity-touching step.
- **The authors (seefeld) are reachable and shaped the fix** — relay precise,
  code-grounded findings; let them bless security-load-bearing forms.
- **Laptop-sleep kills long background work** — recover via Workflow
  `resumeFromRunId` ([[feedback_sleep_interrupted_workflow_resume]]); keep bg
  jobs short / checkpoint.
