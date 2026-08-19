---
status: historical
created: 2026-08-18
archived: 2026-08-18
reason: "Stage-C evidence: W0 — the (d′) refutation experiment (demand = the tracked-ids closure, the demand walk deleted on a scratch branch); the three §2.8 questions answered with numbers before W1."
---

# Stage C — W0: the (d′) refutation experiment (server-execution v2)

**STATUS: IN PROGRESS — written incrementally; sections marked (pending) are
not yet measured. Never read a (pending) section as a result.**

Date: 2026-08-18. Base: the stage-C design branch tip `ed9e1cb2c`
(`claude/server-exec-v2-stage-c-design`, PR #6009's line, off the tuning
trio's `b54bf5215`). Scratch branch `claude/server-exec-v2-w0-dprime-scratch`
(worktree `/Users/berni/labs-worktrees/w0-dprime`), NO PR, never merged: the
code on it is the design's §2.8 "cheap experiment", scratch quality; the
ANSWERS in this report are the deliverable. Durable copy of this report:
`/Users/berni/labs-worktrees/w0-dprime-report.md`.

## 0. Verdict for W1 (one line)

(pending)

## 1. What was built

Scratch commits on `claude/server-exec-v2-w0-dprime-scratch` (base
`ed9e1cb2c`): `9f70f3900` (the build), `49e113d12` (fmt), `5ebe838c6`
(the pins + seams). Every deno invocation `--no-lock`.

**Memory server** (`packages/memory/v2/server.ts`):
- `demandedInstancesForSpace(space, { excludePrincipal })` — rows
  `(id, scope, scopeKey, identity, root)` = ⋃ over the space's client
  sessions of `session.trackedIds` (the service principal's sessions
  excluded), one row per (instance key, session); `root: true` on the
  rows that are the session's watch ROOTS (root keys are UNIONED in from
  the watch specs so a root the tracker has not keyed still carries what
  `watchedRootsForSpace` carried). Anonymous sessions contribute keys and
  an identity without principal (not a demander, as today).
- The push-growth `demandChanged` notify (design §2.8 flag 2): the
  incremental push branch's `commitEntities` notifies with reason
  `push-growth` when `session.trackedIds` GREW; the full-evaluation
  branch's `commitWatchState` notifies when the replaced set differs. The
  observer signature gained an optional `reason: "watch" | "push-growth"`.
- `demandSetSizesForSpace(space)` — per-session `trackedIds.size` /
  watch count + the union size (the §2.6 measurement).
- `watchedRootsForSpace` is kept (unused by the SpaceServer now).

**Scheduler** (`packages/runner/src/scheduler/`):
- `node-record.ts`: `NodeRegistry.demandedWriters: Set<Action>` +
  `isDemandedWriter()` — the standing root kind, held on the registry so
  every liveness state bundle sees it with no plumbing (SIMPLEST-OPTION
  CHOICE, FLAGGED: W1 may prefer a field on the liveness state).
- `dependency-graph.ts`: `isDemandRoot` gains the disjunct;
  `recomputeLiveRefs` (the equivalence reference) gains it too.
- `scheduling-writes.ts`: `SchedulerWriteIndex.onWriterEntitiesChanged`
  hook (added/removed entities per writer; fired from `updateWriterIndex`
  and `clearAction`) — the REGISTRATION / UNREGISTRATION bracket's seat.
- `facade.ts`: `enterDemandedEntity(address)` / `leaveDemandedEntity`
  (refcount per scope-NAME entity, `entityNameKey` — the writer index's
  vocabulary; 0→1 / 1→0 bracket every current writer:
  `wasLive → flip → notifyNodeLivenessChange`, and a dirty node that
  became live is queued as pending), `rearmNotCurrentForDemander(address,
  pair)` (the currency check: `keyAtRatchet(fanOut, pair)` not in
  `fanOut.clean` ⇒ `markActionInvalid(writer, undefined, {fanOutInstances:
  "keep"})` + pending — the `rearmNotCurrentFanOutForActor` shape; a
  writer with no fan-out record is left to liveness), `writersOfEntity`,
  `demandedWriterCount`, `demandedEntityCount`, `demandRootCounters`.
  The registration hook installs lazily on the first `enter` (never off
  the serving posture).

**SpaceServer** (`packages/runner/src/executor/space-server.ts`):
- `#loadDemandedStructure` is now the DEMAND PASS over
  `demandedInstancesForSpace`: `#demandersByKey` keyed by the instance
  key (`${scopeKey}\0${id}`, byte-identical to the old `keyOf`) over
  EVERY row; departed keys → `leaveDemandedEntity` (+ load-state
  cleanup); new keys → `enterDemandedEntity`; new (key, pair) rows →
  `rearmNotCurrentForDemander`; the root-level arrival re-arm
  (`invalidateActionsForDemandRoots`) KEPT for root keys; the structure
  load per ROOT row byte-for-byte as before minus the walk install.
- DELETED: `#installDemandWalk`, `#demandSinks`, the `demand-walk:*`
  effect nodes, their teardown; `grep demand-walk src/` finds comments
  only.
- Flag 6 done in scratch form: `#keysByRootId` / `#keysByResolvedRoot`
  indexes so `#demandersFor` is a lookup, not a full key scan (needed so
  the closure's key count does not confound the settle numbers).
- `noteDemandChanged(reason)` counts `pushGrowthWakes` / `watchWakes`.
- Instrumentation: the `demand` counter block (§6 W4's (d′) version,
  scratch) and the `settle` series in the stats (`/api/health/stats
  .servingLoop.demand` / `.settle`): per authored input, admission
  (`enqueueCommit`) → coverage (the wave whose `derivedThrough` ≥ seq;
  `ms`, `waves`, `cycles`, `growthWakes`, `class`), and, when a
  push-growth wake fires after coverage, the next derived commit as the
  structural-growth landing (`msGrowth`, `growthWaves`, `graceMs`) —
  attribution by ADJACENCY (the most recently covered input), stated as
  such. Flag 4 count (`noWriterRowsWithPatternMeta`) recomputed at pass
  end over the current registry.

**Tests** (`packages/runner/test/`): `executor-dprime-w0.test.ts` (the
(d′) pins); `executor-fan-out.test.ts` (f-walk)'s walk-node half retired
into a T9′ witness; `executor-space-server.test.ts`'s demand seams now
feed `demandedInstancesForSpace` rows (root rows + a superset closure of
every `computed:` doc — the seams have no client to grow the closure).


## 2. Answers

### 2(a) Do the demanded derivations still land?

(pending)

### 2(b) Does anything the walk kept live go dark?

(pending)

### 2(c) Settle time

(pending)

## 3. Workload runs ledger

(pending)

## 4. Flags for W1

(pending)

## 5. What was NOT done and why

(pending)
