# Interaction cost in the unified inbox: what to fix, in order

The measurements behind every claim here are in
[the investigation record](../history/development/performance/2026-09-11-person-inbox-click-cost.md).
This plan turns them into work. It is ordered by what a person feels, and each
stage names the measurement that would show it landed.

## What the measurements settled

Opening an already-loaded thread changes **one `<style>` text node**, at every
size and in every state. The pattern's design holds. So none of what follows is
about rendering, and none of it is the inbox's own code.

Three facts decide the order of work:

1. **A paced click costs ~124 ms.** Awaiting the runtime between clicks keeps
   eight consecutive opens at 112–147 ms on one person's data.
2. **Clicking faster than the runtime settles degrades the session, and it does
   not recover.** Eight eager clicks take 178 → 1032 ms; pacing afterwards
   still costs ~920 ms. A page reload restores ~124 ms; rewriting the data
   partly restores it.
3. **The degraded click does the same work, and pays more for it.** Identical
   logger deltas either side of the degradation — 238 operations, 146 cell,
   36 scheduler, 6 actions, 14 traversals — against 138–172 ms healthy and
   830–931 ms degraded. Worker CPU per click doubles for the same counted work.

That last one is the whole diagnosis. This is a **width** problem, not a
frequency one: nothing runs more often, each unit of work gets dearer. So the
fix is at the leaf, and it is available to every pattern rather than to this
one.

The profile names the leaf, and names what grows around it. Between the healthy
and degraded phases, holding the counted work fixed:

| frame | healthy | degraded | |
| --- | ---: | ---: | --- |
| busy worker CPU | 910 ms | 1822 ms | 2.0× |
| `isPrefix` | 278 ms (30.5%) | 547 ms (30.0%) | 2.0×, constant share |
| `resolveLinkTracingDereferences` | 55 ms (6.0%) | 287 ms (15.8%) | **5.2×** |

`isPrefix` scales with the whole; the dereference-trace machinery is the part
that grows out of proportion. Both sit on the same structure.

## Stage 1 — Stop the dereference-trace set from growing — **not built**

**Where.** `ExtendedStorageTransaction.recordCfcDereferenceTrace`
(`packages/runner/src/storage/extended-storage-transaction.ts`).

**What this stage asked first.** Whether the scanned set grows. It does not.
`dereferenceTracesRecorded` and `dereferenceTracesMax` were added to
`getCfcStats()` and carried to a page through the existing logger-counts
response, and across the healthy → eager → degraded sequence the per-click
figure is **flat at ~750 traces recorded, with the largest set any one
transaction held at 249**. The flow-label probe counters are flat too: ~11
evaluated and ~11 memoized per click, in both states.

So the stage is rescoped rather than built, which is what putting the
measurement first was for. The trace set is not a leak; it is simply large, and
what made it expensive was the scan over it. That is stage 2, and stage 2 alone
turned out to carry the whole symptom.

The unconditional append in `recordCfcDereferenceTrace` — the equality scan
beside the push decides only whether the digest is invalidated, not whether the
trace is stored — is still a duplicate store, and the list is still cleared in
`abort()` and nowhere else. With the scan indexed it costs memory rather than
time, so it is worth tidying but is no longer a performance item.

## Stage 2 — Make the per-read scan not linear — **landed**

**Where.** `probeBelongsToDereference` inside `forEachFlowObservation`
(`packages/runner/src/cfc/prepare.ts`), reached from `prepareForCommit` →
`probeFlowLabelWork` → `flowLabelWorkExists`.

**What was wrong.** For each of the transaction's read activities, the probe
asked whether a recorded dereference covers that read by scanning every trace
source recorded for that document — up to 249 of them, once per read, with a
closure allocated per comparison.

**What landed.** `PathPrefixIndex`
(`packages/runner/src/cfc/path-prefix-index.ts`) indexes those sources by path
segment, so the query costs the read path's length rather than the set's size.
`isPrefix` treats `"*"` as matching any segment on either side, so the walk
carries a frontier rather than a single node; a test compares the index against
a copy of `isPrefix` across a generated corpus of 2,000-plus cases, which is
the only thing that makes the substitution safe.

**Measured**, same rig, same 39-row list, same counters either side
(750 traces, 11 probes, 798 logged operations per click):

| | before | after | |
| --- | ---: | ---: | --- |
| paced click, median | 1482 ms | 387 ms | **3.8× faster** |
| after eager clicking, median | 1711 ms | 392 ms | **4.4× faster** |

And the symptom stage 1 was named for is gone with it: a paced round after an
eager one used to stay degraded (~920 ms against a ~124 ms first round) and now
recovers fully — 431 ms, then eager, then 400 ms. `isPrefix` no longer appears
in the profile's top ten at all; what is left is flat, with no frame above 8%
of a healthy round.

## Stage 3 — Do not run the pass at all when there is nothing to find — **part landed**

**What landed.** `coveredByTrace` is computed on demand rather than for every
read. Only a link-resolution probe needs it inside the walk, and of the two
consumers only `deriveFlowJoin` reads it off the observation; the hot caller,
`flowLabelWorkExists`, never does. An interleaved A/B put it about a tenth
ahead in both pairs, with counted work per click at 766 logged operations
against 798.

**Where that leaves the pass.** `flowLabelWorkExists` is now **7.1% of wall**
(232 ms of a four-click round), against 13.4 seconds before stage 2. It is no
longer the place to look.

**What is still unexplained, and is the interesting number.** The counters say
~11 probes evaluated and ~11 memoized per click, against **2 CFC-relevant
transactions in an entire session**. So eleven full evaluations per click
conclude, every time, that there is no flow work to do.

The memo that would fix that is keyed on an activity epoch every journaled read
advances. Narrowing it is not simply "invalidate on a new document": the
verdict depends on the read's CLASS as well as its document — a document
holding only link-origin entries is relevant to a probe read and not to a value
read — so two reads of one document can disagree. The invalidation key would
have to be the (document, read shape) pair, which the transaction does not
compute at journal time. That is a CFC design decision rather than a
performance edit, and it wants the owner of
`docs/specs/cfc-commit-preparation.md` rather than a measurement.

## Stage 4 — Two write refusals that stop a host driving the pattern

Both block a host from setting `people` at all. Both are small, and neither is
a performance problem; they are here because they cost a day to route around.

**4a. An input refused by an unrelated input — root cause found, not yet
fixed.** Any `cf cell set --cell <piece>#argument <field>` on this piece fails
with `updated input does not match its schema: view: value does not match type
object`. The staged root is read as
`targetCell.asSchema(undefined).withTx(tx).get()`, so a scoped input arrives as
its stored **sigil link** rather than as a `Cell`; `schemaAcceptsOpaqueCellValue`
opens with `if (!isCell(value)) return false`, so the link is not admitted as an
opaque cell value and is validated against the referent's type instead. A write
to any input is then refused by whichever `asCell` input the piece happens to
have, naming that one.

The fix is to accept a sigil link at a position whose schema declares `asCell` —
the link is the stored form of exactly that — either by widening the shared
predicate or by passing a local `acceptOpaqueValue` at this call site.

What is missing is a test that fails without it.
`packages/piece/test/scoped-input-write.test.ts` guards the same-session case,
which passes today; the refusal needs a client whose session is not the one
that minted the link, and an attempt to build that in-process did not
reproduce — a second `PiecesController` over the same space did not fail the
way `cf` does. Land the fix behind a harness that can mint a second session
properly, or behind a CLI-level test, rather than behind a test that would pass
either way.

**4b. A conflict that is neither retried nor reported.** `cf cell set` against
the inbox's own backing document fails with `ConflictError: stale confirmed
read: of:fid1:… at seq 0 conflicted with seq 958` — a dozen documents the
writer read as absent that the server holds at the current sequence, which are
the query-result documents the piece re-mints on each `people` change. The same
write against a one-input holder piece in the same space at the same moment
commits every time, so this is the inbox's argument graph rather than a busy
space. Two defects, worth splitting:

- The transaction is not retried; repeated attempts against a piece that is
  still re-deriving fail repeatedly (5/5 observed).
- The operator sees `Error: [non-error-thrown] [object Object]`. Cliffy
  replaces the thrown `ConflictError` before `renderCliError` sees it.
  Recovering the message needed a patch to `Command.prototype.handleError`.
  Fix this one first and on its own: it is a few lines, and every later
  investigation of the first defect is blind without it.

Routing the write through a **verb** goes through the event path, carries its
own retry, and reports `settled`. It is reliable where both direct spellings
are not, and that asymmetry is itself worth understanding before 4b is called
fixed.

## Stage 5 — What the pane says about itself

The pane reaches a state where every in-DOM check passes — no source chip
still pending, every row's detail present, every key non-empty and unique,
nothing mutating for 30 frames — **while showing the previous person's data**.
Five of seven transitions, checked against the piece's own `threadCount` read
out of band; the worst sat settled showing 38 threads and three chips reading
50 with nobody selected. Everything converged eventually, so nothing is lost.

The consequence for anyone writing an acceptance probe: **there is no predicate
inside the DOM that certifies completeness for this pattern**, because the
counters go stale exactly as the list does. A probe needs an oracle outside the
browser. That is a documentation change, in the loom project's own performance
notes, and it retires the reopen-verification strategy the earlier probe used.

Whether the lag itself is a defect is a separate question this pass did not
answer. It needs one measurement it did not take: whether the chips and the
list are published in one wave or two. Until then it is a known behaviour, not
a filed bug.

## Stage 6 — A rule, and a benchmark

**The rule, and it is the easiest thing here to skip.** The pattern's cost is
set by how many rows the statements returned, not by how many are on screen:
one person with 38 rows rendered opens a thread in 320 ms, five people with 6
rows rendered take 1.4–3.5 s. Nothing at authoring time says so — the author
writes `slice(0, THREAD_LIMIT)` and reasonably expects cost to follow it. Add
to `skills/pattern-dev`, and as a check in `skills/pattern-critic`: a display
cap bounds the render and not the transaction; the number to hold down is the
rows a statement returns.

**The benchmark.** The click cost is now provokable directly — a piece, a
linked store, a list, and a paced-versus-eager click ladder — which is the test
of whether it is understood. Add it under the lane
`docs/development/BENCHMARKS.md` owns, sized so it runs in CI, and assert the
paced band rather than an absolute: what regresses is the gap between a paced
click and an eager one.

## Stage 7 — The result pull deep-traverses the whole result

The largest single item left, found after stage 2 flattened the profile.

`deepTraverse` accounts for **33% of a click's wall time** — 1084 ms of a
3289 ms four-click round — reached from an action named `pull:<uri>`, with its
cost in what it touches rather than in itself (`createViewProxy`,
`resolveLinkTracingDereferences`, `getOwnPropertyDescriptor`).

`Cell.pull()` deep-traverses its value when the cell's link carries no schema
or a true schema, because without one there is nothing to tell it which nested
values to read as dependencies. The runner pulls the result cell after every
commit (`runner.ts`, `#pullCellOnceInPullMode`, from a commit callback), and
builds that cell with `getCellFromLink(resultLink)` — so if the normalized
result link carries no schema, every commit re-walks the entire result. For
this pattern that is 37 threads of pre-rendered detail, on an interaction that
changes one text node.

**Ruled out already:** the render root. `cf-render` renders the `full` kind
with a bare cast rather than `rendererVDOMSchema`, which looked like the same
fault; applying the schema there changed neither the counters (766 logged
operations either way) nor `deepTraverse`'s share (3.3% self against 3.1%).
That change was reverted — it touches every pattern's render path and bought
nothing measurable. The sink that traverses is the result pull, not the render.

**What to establish first**, the way stage 1 was: whether the result link
genuinely arrives schemaless, and if so why — the pattern's result schema
exists, so either normalization drops it or this cell is built from a link that
never had it. Only then is there a fix to design, and the choice of what schema
a result pull should carry is a runtime decision, not a local edit.

## Order, and why

1. ~~**4b's error rendering**~~ — landed. A few lines, and it unblinded the rest.
2. ~~**Stage 1**~~ — measured first, and the measurement said no. Rescoped.
3. ~~**Stage 2**~~ — landed, and it carried the whole symptom: 3.8× on a paced
   click, and the persistent degradation gone.
4. ~~**Stage 3's local half**~~ — landed; the pass is down to 7.1% of wall.
5. ~~**Stage 6**~~ — landed: a benchmark that guards the curve's shape, and the
   authoring rule in `pattern-dev` and `pattern-critic`.
6. **Stage 7** — now the largest remaining item at 33% of a click, and the one
   with a measurement to take before a fix can be designed.
7. **Stage 4a** — small, and it is a correctness bug. The root cause is known;
   what is missing is a harness that reproduces it.
8. **Stage 3's structural half** — a CFC design decision, not a measurement.
9. **Stage 5** — the writing down, in loom's own performance notes.

After stage 2 the profile has no hotspot left. The next tier, by share of a
degraded round, is `sortAndCompactPaths` (13.7%), `#findNode` (9.7%),
`createViewProxy` (7.2%) and `resolveLinkTracingDereferences` (7.1%) — all path
and link machinery, none of them dominant. Expect the next win to be structural
(stage 3's "do not run the pass") rather than another leaf.

Stages 1, 2 and 3 are labs runtime changes and belong in their own tasks, so a
pattern change cannot quietly grow a runtime refactor. Nothing in this plan
asks for a change to `cf-person-inbox.tsx`: at every size measured, it did
exactly what it was built to do.
