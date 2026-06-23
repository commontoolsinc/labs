# Coarse-reads — provenance findings (instrumented + adversarially verified)

Follow-on to `COARSE-READS-SEED.md` and the `project_4178_write_drop` memory.
This session **instrumented which machinery operation emits the coarse reads**,
**joined them to the actual per-commit conflict set**, and **verified the result
against source** (adversarial workflow + direct re-derivation). The verified
answer **confirms the memory's "handler-arg-binding" hypothesis** and explains
why #4199 / #4200 / #4210 did not move the probe.

> **Correction note (own it):** a mid-investigation main-context pass concluded
> the coarse conflict read was emitted by the **write machinery** (`CellImpl.set`
> → `resolveLink`). That was **wrong** — caused by a grep filter that excluded the
> `nr` suffix (`value.map` ≠ `value.map nr`) plus over-aggregating one tx's
> stacks. Verified attribution below.

## THE FIX (final — two complementary changes, verified)

The distinct-key over-conflict has **two independent read sources under the
container**, both of which a peer key-`add` invalidates via parent-injection. The
fix removes each at its right seam — **no read deletion of write-machinery reads,
no #4199, no cross-space regression**:

**Half A — argument materialization stops recording a reference-resolution dep**
(`runner.ts` `readJavaScriptArgument` + `storage/v2.ts` `buildReads`,
`storage/reactivity-log.ts` marker). Materializing an asCell argument follows the
arg's write-redirect (`followPointer` reads the target container's *shape*,
`value.map nr`). That read resolves a *reference*, not a *value*, so it is tagged
`excludeReadFromConflict` and dropped from the commit conflict set — **scoped to
nonRecursive reads**, so a by-value argument's recursive read stays a real
dependency. The read remains in the journal for reactivity; the handler's own
in-body `.get()`s are unaffected and still take dependencies.

**Half B — the commit-conflict matcher uses leaf-only touched paths**
(`memory/v2/engine.ts` `patchOverlapsRead`). This is **exactly the CT-1623 fix
already shipped for the scheduler reader-dirty index**
(`schedulerTouchedLeafPathsForPatch`), now applied to the commit-conflict path.
An add/remove of `value.map.K` no longer injects parent `value.map`, so it stops
prefix-matching disjoint **sibling** reads (the write machinery's own-key diff +
link-family reads). Whole-container readers still conflict (a container read is a
*prefix of* the leaf write — caught by the bidirectional overlap), and **same-key
RMW still conflicts** (own-key read exactly matches a same-key write). The
nonRecursive (shape/keyset) matcher is untouched, so keyset readers still conflict
with key adds. Strictly removes spurious sibling conflicts, never a real one.

**Why two seams.** Neither alone moves the probe at scale (each leaves the other
source under `value.map`); together they collapse a disjoint-key write's effective
conflict surface so concurrent distinct-key writers all land.

### Result (users=10, `--mode=map`, distinct-key contention)

| arm | MISSING/50 |
|---|---|
| baseline | ~20 |
| Half A only | ~20 |
| Half B only | ~20 |
| **Half A + Half B** | **0** |

vs. the alternative (Half A + #4199 read-exclusion) which also reached 0 but
deletes write-machinery reads (cross-space regression) and turns same-key blind
writes into last-writer-wins. Half B is preferred: it fixes the *matcher*, keeps
all reads, preserves same-key RMW, and parallels an already-shipped fix.

### Verification (with both fix behaviors active)

- Probe: `mode=map` users=10 → **0** (was ~20); `mode=both` MAP ~7-12 (was ~20,
  not regressed) — residual is the separate whole-document-read lever (below).
- Memory v2 conflict suites green: `v2-engine` 19, `v2-patch` 16, `v2-server` 27,
  `v2`, `v2-engine-revision` — 0 failed.
- Runner conflict suites green: patterns-handlers, patterns-lift,
  scheduler-observations, cell-meta-sink, runner, ensure-piece-running.
- **Cross-space / inSpace-child green** (cross-space-value-read, inspace-child-*) —
  no #4199-style regression.
- Integration (multi-runtime, `-A`) green: array_push, derive_array_leak (leak
  counter exact), memory-v2-reactivity, pattern-and-data-persistence.
- **Regression test added** (`packages/memory/test/v2-engine-test.ts`, "leaf-only
  commit conflict"): disjoint-key writers MERGE; same-key + whole-container readers
  still CONFLICT. PASSES with the fix; **FAILS** when reverted to parent-injection
  (`ConflictError: stale confirmed read … at seq 1 conflicted with seq 2`) — proves
  it guards the exact behavior change.
- Full runner unit suite: 625 passed / 1 PRE-EXISTING failure (a `wish`
  `pattern-env.test` network fetch returning `[]`, fails identically at baseline).
  Type-checks clean.

### Not fixed by this (separate lever — see "whole-document reads" below)

`mode=both` keeps a MAP residual (~7-12) from **whole-document `value` /
`value.list` reads** (output-derivation computes re-deriving + replacing the whole
result doc, and genuine list-RMW machinery) on the co-located doc — NOT a
distinct-key arg/sibling read. Every firing conflict there is `read=value` /
`read=value.list`; zero are `value.map`. This is the seed's "output-derivation
reads the whole shared doc" source plus genuine RMW; it is broader and is left as
the next lever (do not bundle).

## TL;DR (verified)

1. **The drop-causing coarse read = handler-ARGUMENT BINDING**, not write machinery.
   The whole-container shape read `value.map nr` recorded in a setKey write-commit
   comes from `Runner.readJavaScriptArgument@runner.ts:2427/2428` →
   `inputsCell.asSchema(argumentSchema).get()` → `SchemaObjectTraverser`. Direct
   file-wide attribution of `value.map nr` (collision-immune): **113× from
   `readJavaScriptArgument`** (the handler arg), 33× from
   `populateDeclaredSchedulerReads` (scheduler dep-collection — never lands in a
   write commit, verified). Bare `value.map` from `CellImpl.set` = **1**, and that
   one is piece **setup** (tx4), not a handler write. ⇒ write machinery never emits
   the whole-map read in steady state.
2. **The write machinery (`CellImpl.set`/`push`) emits only the link-resolution
   family** in the same committing tx: `value.map.<ownKey>`, `value.map.$alias.path`,
   `value.map./.link@1`, `value.map.cell./`, and `cfc`. These are own-key + link
   paths — **not** the cross-key conflict driver. (#4199's target — see below.)
3. **The arg read and the write share ONE tx** (`runner.ts:2935` arg-build, then
   `runner.ts:2980` body, same `tx`), so the arg-binding `value.map` read is in the
   write-commit's conflict set. Confirmed structurally + in every map-write
   `CONFLICTREADS WRITE` line (`R[…:value.map …]`).
4. **The collision:** two disjoint-key writers each record a whole-`value.map`
   read; each key-`add` patch touches `[leaf, parent=value.map]`
   (`engine.ts touchedPathsForPatch`), which prefix-overlaps the other's
   `value.map` read ⇒ conflict ⇒ retry ⇒ exhaustion ⇒ drop. **No sibling-key
   leaf reads occur** — each single-key writer reads only its own key; the harm is
   purely **container-read × leaf-write**.
5. **Two harms, separated.** The ~16k total reads are dominated by **sink**
   traffic (`Object.sink…[as action]@cell.ts:2266`, ~51% of reads) = over-SUBSCRIBE.
   The per-write-commit **conflict** set is small (≈86% nc≤2). *Caveat:* sinks run
   on a writable `extraTx` (`cell.ts:2261` `runtime.edit()`), so they are tagged
   `W` by the instrument and `W` vs `R` is **not** a conflict-relevance proxy — only
   the `CONFLICTREADS` dump (commits with `nw≥1`) is authoritative. Sinks commit
   `nw=0` ⇒ never appear in the conflict dump.

## Why #4199 / #4200 / #4210 did not move the probe (resolved)

- **#4199 (exclude write-machinery reads from conflict)** wraps `CellImpl.set`'s
  body in `excludeReadFromConflict`. That correctly strips the link-resolution
  family (own-key, `$alias.path`, `.link@1`, `cell./`, `cfc`) — **none of which
  cause disjoint-key collisions** — but the load-bearing `value.map` read is
  recorded **earlier, during argument materialization** (`readJavaScriptArgument`,
  outside any `Cell.set` scope). So #4199 touches everything **except** the read
  that collides. ⇒ no movement. (Its cross-space regression came from
  over-broad exclusion elsewhere — orthogonal.)
- **#4200 (engine honors nonRecursive shape reads)** is real and plumbs the flag:
  `patchOverlapsNonRecursiveRead = touchedPathsForPatch(patch).some(p =>
  isPrefixPath(p, readPath))`. But its own comment states the intent: *"key
  add/remove **still conflict** because touchedPathsForPatch injects the parent
  path, which equals readPath for a direct child mutation."* A whole-map shape
  read **is** a keyset dependency, and a key-add **does** change the keyset — so
  #4200 **deliberately preserves** this conflict as correct semantics. It cannot
  fix disjoint key-adds without breaking its own invariant. The arg-binding read
  is exactly such a whole-map shape read.
- **#4210 (no immediate compute re-queue)** removes a contention *amplifier*
  (computes racing to re-commit up to 10×); complementary, marginal in isolation.
  Consistent: compute reads live in separate txs, not the handler write-commit.

**Net:** the conflict is "correct" given the dependency that gets **recorded**.
The fix must be on the **recording** side — don't record a whole-map keyset/shape
dependency for a handler that only navigates to and writes one key.

## Seam analysis — WHAT the read is and whether it's necessary

The coarse arg read is **not** a value snapshot of the whole map. It is the
**write-redirect resolution of the asCell `map` argument**: traversing the
argument object hits `map` as a pointer →
`traversePointerWithSchema@traverse.ts:3729` → `getDocAtPath(…,"writeRedirect")`
→ `followPointer@traverse.ts:1849` does `tx.read(target, READ_NON_RECURSIVE)` to
resolve the redirect target. So it is **link/reference construction**, not a
logical value dependency. Evidence it is incidental:
- **Opaque** asCell args skip it entirely (`traverse.ts:3741` →
  `createObject(cellLink, undefined)`, no target read). Only the
  **writeRedirect** (writable) asCell path reads the target.
- The target read's value is used only to branch on `redirDoc.value ===
  undefined` (`traverse.ts:3760`) — and **both** branches create a cell anyway
  (`3787-3791`).
- `followPointer`'s own comment (`traverse.ts:1842-1848`): these link-following
  reads are *"ignore[d] … for scheduling. We'll have to tag it later."* — i.e.
  the codebase already treats pointer-resolution reads as a special category.

It is already minimized to **nonRecursive** (shape). Minimizing further is not
the lever: a shape read **correctly** conflicts with a key-add (#4200, by design).
The point is that this particular shape read is **reference resolution, not a
dependency** — so it should not be in the **conflict** set at all (it should stay
in the journal for reactivity).

## RESULT — the lever, tested (the residual is TWO complementary read sources)

Spiked the arg-materialization exclusion (`CF_SPIKE_ARG_NOCONFLICT`, wraps
`readJavaScriptArgument` in `excludeReadFromConflict`) and, separately, #4199's
`Cell.set` exclusion (`CF_SPIKE_SET_NOCONFLICT`, ported to this branch). Both
env-gated, default OFF. `users=10 --mode=map` (pure distinct-key contention),
MISSING per run:

| arm | MISSING (users=10, map) |
|---|---|
| baseline | 20, 20 |
| arg-binding exclusion only | 20, 20 |
| `Cell.set` exclusion only (= #4199) | 19, 20 |
| **both together** | **0, 0** |

With both on + the conflict instrument, **all 50 map-write commits collapse to
`nc=0`** (empty conflict set) — a disjoint-key write becomes a pure producer and
all concurrent distinct-key writers land. At `users=2`, arg-binding exclusion
alone already reached 0 (the retry budget absorbed the residual write-machinery
overlap with a single peer); at `users=10` it does not — confirming the residual.

**Why two sources, both required.** An `add` to `/value/map/<k>` injects parent
`value.map` (`touchedPathsForPatch`), which prefix-overlaps **every** read under
`value.map`. A distinct-key write's conflict set has reads under `value.map` from
**two independent machinery sources**:
1. **Argument materialization** — the whole-`value.map` shape read
   (`readJavaScriptArgument` → followPointer). Excluded by `CF_SPIKE_ARG_NOCONFLICT`.
2. **`Cell.set` write machinery** — the own-key diff read (`value.map.<k>`) + link
   family (`$alias.path`, `./.link@1`, `cell./`) + `cfc`. Excluded by #4199.

Excluding only one leaves the other under `value.map`, still overlapping every
peer's parent-injected add ⇒ retry-exhaustion at 10-way simultaneity. This is the
exact reason **#4199 (and every prior single lever) did not move the probe**: each
addressed at most one of the two sources. **#4199 is necessary but not sufficient;
it needs the arg-materialization exclusion as a complement.**

The LIST path (`mode=list/both`) is unaffected and *should* be — `push` is a
genuine whole-array RMW (lost update), not a granularity artifact (seefeld: no
perfect resolution for genuine RMW).

## The shippable fix (candidate; spikes are over-broad)

The proven fix is **#4199 + an arg-materialization exclusion, together**. Both
spikes are intentionally over-broad for measurement and need scoping before merge:
- **`Cell.set` side = #4199**, which already exists (with its documented
  last-writer-wins semantic for same-key blind writes) but has an unresolved
  **cross-space regression** (`home-profile.test.ts`). That must be fixed.
- **arg side** must be scoped to **asCell/reference args only** — the current
  spike wraps all of `readJavaScriptArgument`, so it also drops *value*-arg reads
  (a genuine dependency) and *compute* input reads. Core suites
  (patterns-handlers, patterns-lift, scheduler-observations) pass with both flags,
  but those don't cover value-arg RMW or cross-space writes.

Detail of the arg-side scoping:

Exclude **asCell-argument-materialization link-resolution reads** from the
conflict set. This is **exactly #4199's `excludeReadFromConflict` mechanism, at a
different seam** — #4199 wrapped `CellImpl.set`; the load-bearing read is in
`readJavaScriptArgument` / the asCell pointer-follow, which #4199 never covers.

- **Code seam:** `runner.ts:2419-2436` `readJavaScriptArgument`
  (`inputsCell.asSchema(module.argumentSchema).get()`, call site `runner.ts:2935`),
  bottoming out at `followPointer@traverse.ts:1849` for asCell pointers. Either
  wrap arg materialization in `excludeReadFromConflict`, or tag the
  pointer-follow read for asCell args specifically.
- **Effect on conflict set:** removes the bare `value.map` entry from every
  map-write read-set (the 113 arg-binding reads). A `w2#0` writer's set drops to
  `{value.map.w2#0, cfc, link family}`, none of which prefix-overlap a sibling's
  `/value/map/w1#0` add ⇒ disjoint keys merge; same-key RMW still conflicts.
- **Scope / safety (must hold):**
  1. **asCell/reference args only.** A by-VALUE arg (`{count: number}`) IS a
     genuine dependency — its materialization read must stay. Scope by the
     asCell/pointer traversal path, not all of `readJavaScriptArgument`.
  2. **In-body reads stay deps.** A handler that does `map.get()`/iterates keys in
     its body records that read separately (not at materialization) — it must
     still conflict. setKey has no in-body read, so its only read is the incidental
     materialization one.
  3. **Reactivity preserved.** Like #4199, the read stays in the journal; only
     `buildReads` drops it — the handler still re-subscribes.
- **Alternative shape:** route schema'd asCell args through a lazy writable proxy
  (the `writableProxy` path, `runner.ts:2429/2940`, currently only the no-schema
  branch) so the redirect target isn't eagerly read. Heavier; the marker approach
  is more surgical and reuses shipped infra.

## Decisive next experiment (instrument-verified, two-gate)

1. Apply the lever ONLY (narrow the recorded arg-binding read).
2. Re-run with `CF_READ_PROVENANCE=1 CF_CONFLICT_READS=1`.
3. **Gate (a) — read-set:** map-write `CONFLICTREADS WRITE` lines for
   `W[patch:…:/value/map/<key>]` no longer contain a bare `…:value.map` entry
   (drops from nc=6 to nc≤1). Proves the lever changed the right thing.
4. **Gate (b) — outcome:** `grep -c "exhausting all retries"` + stale/pending
   conflict messages on the shared doc fall to ~0 for disjoint keys, while same-key
   writers still conflict. Proves it moves the probe.

If gate (a) passes but (b) doesn't, the diagnosis is wrong and the conflict lives
elsewhere (e.g. the `cfc` policy read, or same-key serialization) — re-instrument.

## The instrument (env-gated; OFF by default — verified 0 emissions / exit 0)

`packages/runner/src/storage/read-provenance.ts`, wired at three seams:
- **`CF_READ_PROVENANCE=1`** — `v2-transaction.ts read()`:
  `RDPROV \t tx<ID> \t <W|R> \t <entityShort> \t <path>[ nr] \t <frame1> <- …`
  (`W`=writable tx; `nr`=nonRecursive shape read; `tx<ID>` = per-tx id).
- **`CF_CONFLICT_READS=1`** — per-commit conflict set (`v2.ts buildReads`, dumped
  at both commit sites with write context):
  `CONFLICTREADS \t <WRITE|SCHEDOBS> \t tx<ID> \t nw=.. \t nc=.. \t nr=.. \t W[ops] \t R[reads]`.
- **`CF_SES_ERROR_TAMING=unsafe-debug`** — default SES `errorTaming:"safe"`
  (`ses-runtime.ts`) strips `new Error().stack`; without it ~99% of reads report
  "(no stack)". Env-gated; default unchanged.
- Optional: `CF_READ_PROVENANCE_FRAMES=<n>` (default 7; 40 reaches roots),
  `CF_READ_PROVENANCE_PATHS=<substr,…>`.

> **Instrument caveat:** `tx<ID>` is a per-worker counter, so ids **collide across
> worker realms** — a raw `RDPROV tx<ID>` ↔ `CONFLICTREADS tx<ID>` join is unsafe
> and must be corroborated by entity + call-site (the file-wide attribution above
> is collision-immune). A per-realm prefix would make joins safe (TODO if the
> experiment needs tight joins).

Reproduce:
```bash
CF_READ_PROVENANCE=1 CF_CONFLICT_READS=1 CF_READ_PROVENANCE_FRAMES=40 \
  CF_SES_ERROR_TAMING=unsafe-debug \
  deno run -A packages/patterns/write-contention/probe.ts \
    --users=2 --rounds=5 --mode=both 2>/tmp/wc.err
# who emits the coarse shape read (collision-immune, file-wide):
grep -P '^RDPROV\t' /tmp/wc.err | awk -F'\t' '$5=="value.map nr"{print $6}' \
  | grep -oE 'readJavaScriptArgument@runner.ts:[0-9]+|CellImpl\.(set|push)@cell.ts:[0-9]+' \
  | sort | uniq -c | sort -rn
```

## Baseline (verified this session)

`--users=10 --rounds=5 --mode=both`: LIST 20/50 MISSING, MAP 19/50 MISSING,
39 "exhausting all retries" ≈ 39 MISSING (loud, not silent), `cold==live`
(real lost writes), MAP≈LIST (coarse conflict). `--users=2`: ~2-3 MISSING/path.
