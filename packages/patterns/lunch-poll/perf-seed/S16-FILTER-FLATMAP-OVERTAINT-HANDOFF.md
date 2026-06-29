# S16 — filter/flatMap container/input over-taint (next-session focus)

_Started 2026-06-29, out of the #4367 review. The question: do `filter`/`flatMap`
over-taint their outputs with element content the way the S16 model says they
shouldn't — and if so, **where exactly**, and what's the fix + a
fails-without/passes-with guard? Companion to [`OPEN-THREADS.md`](./OPEN-THREADS.md)._

## TL;DR
- We shipped **#4391** thinking it fixed an S16 "over-taint" in filter/flatMap's
  **container reads**. Rigorous verification showed that change is
  **label-neutral** (observably a no-op). So #4391 as-merged-candidate does NOT
  fix an observable bug — it's defensive consistency with `map` at best.
- BUT the investigation surfaced a **real, still-unfixed over-taint upstream**:
  filter/flatMap read their **input list** with a plain content read that
  dereferences the elements, journaling their content into the coordinator's
  per-tx join `J`. `map` deliberately avoids this (identity-only materialization).
- **Next session:** (1) isolate whether the observable over-taint is the
  input-list read vs the probe's own deref; (2) if it's the input-list read,
  port `map`'s identity-only input materialization to filter/flatMap; (3) the
  **ignore-element test** below becomes the fails-without/passes-with guard;
  (4) decide what #4391 becomes (drop the container change / fold into the
  complete fix / keep as honest defensive consistency).

## The S16 model (what *should* happen) — see `docs/specs/cfc-s16-default-transition-design.md`
- **D1**: one join `J` per transaction = join of everything read (not internal,
  not excluded).
- **D2**: per-slot link labels ride the **link-write**, not journaled reads.
- **D4** (the key one): "Pointwise precision comes from transaction granularity."
  The **result-container label = array shape + link identities, NOT element
  contents**. filter/flatMap **membership** taint legitimately = "whatever the
  predicate results it read carry" (the predicate read is a real value read).
- **S7 caveat** (verified-ground-truth table): `labelAtPath` = longest
  **ancestor-or-equal** prefix only, **no descendant aggregation**. So a label at
  a sub-path (`["data"]`) is **invisible** to a read of the element root. This
  killed the "per-field label" approach (see Dead ends).

## How `map` does it right (the template to mirror) — `packages/runner/src/builtins/map.ts`
`map` probe-scopes **two** places, both under `linkResolutionProbe`:
1. **The input-list read** (`map.ts:163-188`): "identity-only list
   materialization" — reads raw slots via `getRaw` + `resolveLink` (probe), builds
   element cells from the slot links **without dereferencing element content**.
   The comment says the old `asCell` traversal "dereferenced each slot's target,
   journaling a content read of every element doc the coordinator never consumes."
2. **The container presence/diff reads** (the `probeScoped` helper, `map.ts:~248`).

`map`'s smear is **observable** because `map` reads **no** element content
anywhere else — so any element atom on the container is pure smear. The existing
test `map: incrementally added elements get pointwise derived labels`
(`packages/runner/test/cfc-flow-pointwise.test.ts:86`) is exactly the no-smear
guard (`conf0 NOT toContainEqual "bob-secret"`, etc.).

## What #4391 actually did (and why it's label-neutral)
#4391 added `map`'s **container-read** probe-scoping (#2 above) to filter/flatMap
(+ the `resume-republish` container write). It did **NOT** port #1 (the
input-list materialization). Verified label-neutral **twice**:
- The existing `cfc-flow-pointwise` filter tests pass **with the patch reverted to
  origin/main** AND with it — identical. (Reverted via `git checkout origin/main
  -- builtins/filter.ts flatmap.ts resume-republish.ts`, ran, restored.)
- The **ignore-element scratch test** (below): `PROBE_CONF = [alice, bob]`
  **identical** with and without the patch.

Why: for filter/flatMap the coordinator already reads every element (predicate
results / op results, AND the input-list read), so the container deref is
**redundant** — it adds no atom that isn't already in `J`. map is the only list
builtin whose coordinator reads no element content, so only map's container deref
is observable.

## The real over-taint (the live lead)
The ignore-element test: a predicate that **never reads the element** (returns
`true` off a constant) so **membership carries no element taint**. Yet
`PROBE_CONF = [alice, bob]` — element atoms reach a reader anyway. Since the
predicate didn't read them, and the container deref is probe-scoped (#4391),
the source is **upstream**: most likely filter's input-list read
`inputsCell.asSchema(FILTER_INPUT_SCHEMA).withTx(tx).get()`
(`packages/runner/src/builtins/filter.ts:~150`), which dereferences the elements.
`map` avoids exactly this with its identity-only materialization.

**OPEN / must isolate first:** I did NOT cleanly separate "filter's input-list
read journals content" from "the probe's own `kept.asSchema({asCell}).get()`
deref journals content." Both are candidates. Isolate by: (a) instrument which
read puts alice/bob in `J` (read the **container's** derived label directly, not
via a probe that itself may deref), or (b) port the input-list materialization and
see if the ignore-element test flips to clean.

## The fails-without/passes-with guard (the ignore-element test)
This is the test shape that SHOULD work once the real fix lands. Mirror
`cfc-flow-pointwise.test.ts`'s helpers (`seedLabeledDoc`, `derivedConfidentiality`,
`StorageManager.emulate`, `cfcFlowLabels: "persist"`). Predicate that ignores the
element:
```ts
const alwaysKeep = lift((_n: number) => _n >= 0);
// inner pattern does NOT bind `element`:
pattern((_: FactoryInput<any>) => alwaysKeep(1))
```
Seed el0/el1 with whole-doc labels (alice/bob). filter [el0], grow to [el0, el1]
(second reconcile re-reads prior container). Probe `kept` shape, read the probe's
`derivedConfidentiality`. **Assert it does NOT contain alice/bob** — the predicate
never read them. Today this **fails both ways** (PROBE_CONF=[alice,bob]); with the
input-list fix it should pass only with the fix. (NB: confirm the probe itself
doesn't deref — that's the isolation step above.)

## Dead ends (don't re-chase)
- **Per-field labels + subset predicate.** Tried labels at `["keep"]`/`["data"]`
  with a predicate reading only `.keep`, expecting `data-*` to leak via the
  container deref. Got `PROBE_CONF = []` — **S7** (no descendant aggregation) makes
  sub-path labels invisible to element-root reads, so neither membership nor
  over-taint journals them. Whole-doc labels are required.
- **Probing `kept[i]` for cross-element smear (the map structure).** filter's
  `kept` slots are **links to input elements** (per-slot labels ride the link), not
  result cells — so there's no per-slot smear to observe the way map has.

## Pointers
- Current PR: **#4391** (`gideon/4367-followups`, worktree `labs-4367-fu`). Commits:
  S16 container-read probe (label-neutral), `trackUntilSettled` doc-nit (real),
  resume-republish-unit mock fix. CI green.
- `map.ts:163-188` — the identity-only input materialization to port.
- `filter.ts:~150`, `flatmap.ts` — the plain input-list read to fix.
- `cfc-flow-pointwise.test.ts` — test template + the map no-smear guard (`:86`).
- `docs/specs/cfc-s16-default-transition-design.md` — D1/D2/D4 + the S7 ground-truth.
- `commontoolsinc/specs` repo `cfc/08-05` (collection transitions), `08-09`
  (runtime propagation) — the canonical (under-specified) rule.
- **CT-1801** — the spec-gap ticket (formalize the structure-only-read rule; held
  for seefeld). This thread is its implementation half.

## Lesson (also worth a memory note)
We built #4391 around a plausible "container over-taint" model (from a spec
workflow) **without first confirming it was observable** (a fails-without test).
Verification showed the fix was the wrong/incomplete half. Always validate a fix
is **observable** (fails-without / passes-with) before building a PR around a
plausible bug model — especially for CFC/flow-label changes where the model is
subtle and "looks right."
