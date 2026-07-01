# Seed — Cold-load bucket #2: TS-parse-in-worker at boot (~102ms)

> **STATUS (2026-07-01): Fix A shipped.** The ~102ms was ~99% _redundant_
> re-parsing — the 9-module system-app closure was parsed 4×/cold-boot. A
> content-hash-keyed parse memo in `buildRecordsFromCompiled` collapses it to 1×
> (~94.5ms → ~21.5ms, gated green). Full finding + the "why one parse not zero"
> reasoning + Fix B (persist at build → 0 parses) plan:
> **`BOOT-FLOOR-FINDINGS.md` §9**. The measurement-methodology gotchas (worker
> warm/cold bimodality, `close` nukes auth, in-worker instrumentation self-gates
> cold) are in that doc's §1.

**For a fresh session.** This is one independent slice of the Common Fabric
cold-load (pattern initial-load) investigation: root-cause and remove the
**in-worker TypeScript re-parse** that runs at every piece boot. It is fully
independent of the action-identity / source-map work (that's a separate thread)
— different files, no overlap.

Workspace: **`D-cf-repos/labs`**, branch **`gideon/cold-load-ts-parse`** (off
`origin/main`). Per the workspace convention, **D = port-offset 4** for all
`scripts/{start,stop,restart,check}-local-dev.sh`. Work ONLY in this workspace.

---

## 0. The one finding that frames everything (read these first)

The "~1s lunch-poll cold load" is **~92% a generic per-piece runtime boot floor
(~670ms that EVERY pattern pays)**, not the pattern. The CPU profile of a
_trivial_ 1-`div` pattern's worker isolate (~640ms busy) breaks the floor into 7
buckets. **This thread owns bucket #2.** Full context (copied into this dir):

- **`COLD-LOAD-MASTER-HANDOFF.md`** — the index + the 7-bucket map (§3) + the
  measurement rig (§1) + the stance (§9). Read it first.
- **`BOOT-FLOOR-FINDINGS.md`** — the perf arc, the attribution method, the
  per-bucket caller chains, the gotchas. §3 + §5 are the relevant detail.

The complete investigation (incl. the other threads' handoffs) lives on the
pushed branch — read anything else from it read-only without checking it out:
`git show origin/gideon/lunch-poll-load-investigation:packages/patterns/lunch-poll/perf-seed/<file>`

---

## 1. Bucket #2 — what we know

|                               |                                                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cost**                      | ~102ms of the ~640ms trivial-pattern worker boot (the 2nd-largest bucket; #1 is the ~100ms `.src` debug-annotation, owned by the other thread)                                                            |
| **Caller chain (top → root)** | `parseSourceFile` / `createSourceFile2` ← `extractCompiledExports` ← `buildRecordsFromCompiled` ← `evaluateCachedModules`                                                                                 |
| **Mechanism (hypothesis)**    | The runtime runs the **TS parser in-worker at boot** to (re-)derive export records — even though modules are **already compiled**. So it re-parses authored TS solely to rebuild the export/record graph. |
| **Fix direction**             | Precompute the export records at **compile/build time** and persist them with the cached compiled module, so the warm/by-identity load path skips the in-worker `createSourceFile`.                       |

This is the "do it at build, not at boot" shape — the same shape as bucket #3
(schema-intern). Start by reading
**`packages/runner/src/sandbox/module-record-compiler.ts`** (per the master
handoff §6.2) and tracing `buildRecordsFromCompiled` → `extractCompiledExports`
in `packages/runner/src/harness/engine.ts` (`evaluateCachedModules` lives
there). Confirm _whether_ it parses, _why_ (what record fields it derives from
source that aren't already in the compiled artifact), and whether those can be
produced at compile time instead.

---

## 2. The measurement rig (you need this to prove any fix)

The cheapest, most direct signal is the **trivial-pattern settle re-measure**.
**Baseline on the 2026-06-30 main was ~662ms** — but that predates the
OpaqueRef→Reactive rename now on main, so **RE-DERIVE the baseline on current
`main` first** (don't inherit the number). The CPU profile attributes within it.

Path B (real toolshed + browser — what cold-load actually is). For workspace D:

```bash
T=$(mktemp -d)
CACHE_DIR=$T/cache MEMORY_DIR=file://$T/cache/memory/ \
  ./scripts/start-local-dev.sh --port-offset 4 --inspect    # D = offset 4
# (FOOTGUN: start-local-dev offsets PORTS but NOT the data dir — you MUST isolate
#  CACHE_DIR/MEMORY_DIR or you share the default :8000 store.)
# Deploy + seed the trivial pattern (trivial.tsx is in this dir):
#   see seed.sh and master-handoff §1 for the deploy/seed recipe (adjust --api-url to the offset-4 port).
# agent-browser (Import-CLI-Key auth), per measurement:
agent-browser --session s profiler start
agent-browser --session s eval "location.reload()"; agent-browser --session s wait 2500
agent-browser --session s profiler stop boot.json
python3 cpuprof4.py boot.json    # self + inclusive + caller chains
# Settle wall-time: reload + await commonfabric.viewSettled(); read performance.now()
```

**Gotchas (all real, all in the handoffs — don't rediscover them):**

- `agent-browser profiler` emits a **trace with `ProfileChunk` events**, not a
  flat `.cpuprofile`; the runtime worker samples land on a `v8:ProfEvntProc`
  thread (the isolate whose frames are in `worker-runtime.js`). `cpuprof4.py`
  handles this (nodes use a `parent` ref).
- The dev toolshed serves `/scripts/worker-runtime.js` by **proxying to the
  shell** (felt build); a **runner edit needs a shell restart** to rebuild the
  worker bundle (re-pass the isolation env).
- Debug API on the page: `getTimingStatsBreakdown`, `viewSettled` (=
  `getRt().idle()`), `vdom`, `detectNonIdempotent`. (`getGraphSnapshot` is
  gone.)

---

## 3. Done = an observable win

A fix is real only if the **trivial-pattern boot re-measure** moves (revert +
re-measure to confirm; the profile attributes within the settle). Target: the
~102ms `createSourceFile`/`parseSourceFile` self-time at boot **drops toward
absent**, and the trivial settle drops correspondingly. Gate any runtime change
with the runner suite + `integration pattern-tests` + `generated-patterns`
(identity/record changes need the runtime gate).

---

## 4. Stance (carry it, not just the facts)

- **Re-derive on current `main`; don't inherit conclusions.** The findings are
  from 2026-06-30 main; the debug API drifts and the rename may have shifted
  buckets. Validate the instrument before trusting it.
- **Verify load-bearing claims directly** — confirm the in-worker parse _is_
  happening (instrument `buildRecordsFromCompiled`), don't infer from the chain.
- **Validate every fix is observable** — short-circuit / revert + re-measure
  before building anything around a hypothesis.
- The runtime authors (seefeldb / Berni) shaped the identity fix and are
  reachable for the record/compile-pipeline questions.

---

## 5. First steps

1. `git -C . log --oneline -1` — confirm you're on `gideon/cold-load-ts-parse`
   off current `origin/main`.
2. Read `COLD-LOAD-MASTER-HANDOFF.md` (§3 bucket map, §1 rig, §9 stance), then
   `BOOT-FLOOR-FINDINGS.md` §3 + §5.
3. Read `packages/runner/src/sandbox/module-record-compiler.ts` and trace
   `buildRecordsFromCompiled` → `extractCompiledExports` in
   `packages/runner/src/harness/engine.ts`. Confirm the parse and what it
   derives.
4. Stand up the offset-4 rig, re-derive the trivial baseline, capture a fresh
   profile, and confirm bucket #2 is still ~102ms on current main.
5. Then: design the precompute-records-at-build fix → prove it observable.
