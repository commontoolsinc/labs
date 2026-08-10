---
status: historical
created: 2026-08-10
archived: 2026-08-10
reason: "Profiling report on scheduler liveness rebuild cost and the incremental maintenance that replaced it, August 2026."
---

# Scheduler liveness maintenance cost

A growing UI list made scheduler liveness maintenance the dominant cost of an
append. This records what was measured, why the old shape scaled the way it did,
and what the incremental replacement changed.

## The shape of the problem

`recomputeLiveRefs` derived demand refcounts from scratch on every edge or
demand-root change: materialize every active node, zero every `liveRefs`, walk
reverse-dependency edges from every root, then walk the reachable set again to
recount. Its cost was proportional to the whole graph, not to what changed.

A UI list violates the premise that made that acceptable. Appending one item
re-renders the list, so every existing card remounts: each remount tears down an
action's edges and registers new ones. The number of maintenance operations per
append therefore grows with the list, and so does the graph each operation
walked. Two independently linear factors multiply, giving quadratic cost per
append and cubic cost overall.

## Measurement

`packages/runner/test/liveness-scaling.profile.ts` drives a growing list through
the real scheduler: each append mounts one card — a computation reading the list
and writing the card, plus an effect reading the card — then remounts every
existing card. Both algorithms were measured with identical counters on the
identical workload, the second in a worktree at `5058fac7e`.

Counted work, not elapsed time: an append-driven window leaves the runtime
worker mostly idle on IPC and storage, and run-to-run noise swamps the signal.

`maintenance ops` counts entries to the four mutators that can change liveness.
It is identical across both algorithms at every size, which is what makes the
comparison exact.

### Deriving from roots on every change

| board | maintenance ops | node writes | edge visits | node writes/op |
| --- | --- | --- | --- | --- |
| 10 | 320 | 3,200 | 2,000 | 10.0 |
| 20 | 1,240 | 24,800 | 16,000 | 20.0 |
| 30 | 2,760 | 82,800 | 54,000 | 30.0 |
| 40 | 4,880 | 195,200 | 128,000 | 40.0 |

Log-log slopes over board size 10→40: maintenance ops 1.97, node writes 2.97,
edge visits 3.00, node writes per operation 1.00.

Work per operation tracks the node count exactly — 10, 20, 30, 40 at boards of
10, 20, 30, 40. That is the linear factor that multiplies with the quadratic
operation count to give a cubic total.

An earlier instrumentation pass over the same workload, recording per-rebuild
samples rather than totals, independently reported 130,680 node resets and
~128,260 edge visits at board 40. The totals above decompose as 130,680 resets
plus 64,520 increments, and 128,000 edge visits — agreement between two separate
instruments, which is what makes both trustworthy.

That pass also found the rebuild triggered by the liveness flip on the
resubscribe path changed nothing in 100% of calls: at that point the action's
edges have not been replaced yet, so there is nothing to recount.

### Maintaining incrementally

| board | maintenance ops | node writes | edge visits | node writes/op |
| --- | --- | --- | --- | --- |
| 10 | 320 | 255 | 0 | 0.8 |
| 20 | 1,240 | 1,010 | 0 | 0.8 |
| 30 | 2,760 | 2,265 | 0 | 0.8 |
| 40 | 4,880 | 4,020 | 0 | 0.8 |

Log-log slopes over board size 10→40: maintenance ops 1.97, node writes 1.99,
node writes per operation 0.02.

Work per operation is flat. At board 40 the totals are 49× fewer node writes
(195,200 → 4,020) and no edge visits at all.

Two of those 0.8 writes per operation are the price of correctness rather than
of maintenance: a node that loses a root status is re-derived even when it still
looks live, and a registering node recounts the references its readers already
hold. An earlier revision skipped both and measured 0.5, which was wrong in ways
counted work cannot show — see the note below.

The remaining quadratic in the total is the workload's own — N appends each
remounting N cards, visible as the unchanged 1.97 slope on maintenance ops. The
scheduler no longer contributes a factor of its own. Reducing that last factor
means not remounting every card on every append, which is a question for the
rendering path rather than the scheduler.

Edge visits reaching zero is a property of this workload, not a general claim:
its graph is two levels deep, so the region a withdrawal re-derives is a single
node and the upstream walk finds no edges. A deeper graph pays for the depth of
the affected region — still bounded by what changed rather than by the graph.

## What changed

Liveness is maintained in two asymmetric directions instead of being rederived.

Granting demand — a new edge, or a node becoming a root — can only add
reachability. The new reader hands one reference to each writer it reads, and a
writer crossing from dormant to live passes the same contribution upstream. A
node is enqueued only on that crossing, so cycles settle rather than loop, and
each arm of a diamond contributes its own reference.

Withdrawing demand — an edge removed, or a root status lost — can strand nodes,
and a reference count cannot distinguish a genuine supporter from a rootless
cycle holding itself up. Withdrawal re-derives over the region that can be
affected and no further: the origin's transitive upstream. That region is closed
under the writer edge, so a live reader outside it cannot owe its liveness to
anything inside, and its support can be trusted. Clearing the region and
re-seeding from roots inside plus live readers outside is cycle-safe and
diamond-accurate.

`recomputeLiveRefs` remains as the definition those updates implement, and as
the reference `packages/runner/test/scheduler/dependency-graph.test.ts` checks them
against after every mutation in a randomized sequence.

## Notes for a future pass

- A verifier asserting the incremental state against a full rebuild after every
  mutation, run across the whole runner suite, found exactly one gap that
  inspection of the scheduler tests alone had not: `unregisterDependentEdge`
  skipped a decrement when the writer was itself a root. Sixteen further hits
  were the same defect. Checking an incremental algorithm against its reference
  across an existing suite is cheap and finds what targeted tests miss.
- A randomized equivalence test only reaches the shapes its generator can build.
  The first version registered a quarter of its nodes as effects, which makes
  almost every node root-reachable, so rootless cycles never formed and the
  release path went unexercised across 30,000 mutations. Two defects lived in
  exactly that blind spot: losing a materializer root inside a cycle never
  withdrew, and a node registering with edges already naming it never collected
  the references its readers held. Both were found by adversarial review, not by
  the fuzz. The generator now parameterizes which root kinds exist, and the
  root-free runs are the ones that reach the release path.
- Removing a global rebuild removes a repair mechanism. Both defects above
  predate this change, and both were harmless while every edge mutation
  rederived the whole graph from the roots. An incremental replacement inherits
  the correctness obligations its predecessor was papering over.
- Wall clock cannot adjudicate this workload. Counts can.
