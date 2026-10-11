# The serving cycle without server round trips

The serving loop's cost on bursty input is not the derivations and not the
commit. Over a 30-topic Topics seed the scheduler's runs amount to four to
five seconds of work, and the seed takes 60 s on the main thread and 30 s in
the worker: 378 cycles at a 118 ms median on the main thread, 84 cycles at
329 ms in the worker, with the settle alone at 102 and 133 ms
([the 2026-10-11 record](../history/development/performance/2026-10-11-serving-loop-in-a-worker.md)).
A client running the same program pays none of that: a node commits its
transaction and the next node runs. This plan keeps the wave as the commit
unit, which the watermark, the consequence list, exactly-once events and the
fan-out budget rest on, and removes the per-cycle waits and passes around it.

## Where a cycle's time goes

A cycle in `SpaceServer.#serveWave` drains events, runs the demanded-structure
load pass, settles the scheduler to quiescence under the 100 ms flush
deadline, commits the wave, and then runs the post-commit work before the
next cycle: the sealed contributions' settlement, the delivery reconciliation,
the view-plan publish, the outbox drain, and the demand pass.

**The settle probes quiescence through the server.** Each probe awaits the
structure load pass, the runtime's `idle()`, the memory server's `idle()`, the
storage manager's `inputSynced()` and one macrotask, and then asks whether the
scheduler is idle. The server's `idle()` is server-wide: it waits for every
connection's in-flight receives, every space's publication lock and any
scheduled refresh, and its own documentation says a sustained stream of new
work extends it indefinitely. So one space's settle is paced by every client
of every space, and under any sustained input the probe reaches the deadline
without observing quiescence, whatever the scheduler was doing. The barrier
exists because the loop's inputs reach its replica as frames pushed on its
own loopback session: the probe has to let the server push them and the
replica apply them before "idle" means anything. Under the store read-through
posture the home space's documents are read from the engine already, and the
loop is told of each admitted commit by the server's observer (the feed), so
the frames are a second delivery of what the loop can read for itself.

**The demand pass re-asks the server every cycle.** `demandForSpace` and
`viewInterestsForSpace` return every session's rows, and the space server
compares them to its mirror. The pass cost 8 ms per cycle on the main thread
and 96 ms over the worker's port, where the rows cross as fresh objects. The
server already sends `demandChanged` when a session's demand moves; the rows
themselves do not travel with it.

**The post-commit work runs ahead of the next settle.** The outbox drain and
the view-plan publish are I/O against the server and other spaces; nothing
the next settle reads waits on them, and the next wave already opens during
the commit's round trip.

## What changes

**Quiescence is decided locally.** With read-through on for the serving
space, the settle's proof becomes: every feed record at or below the batch
head has been integrated into the replica (`integrateStoreWrites`, which
read-through already runs per record), the structure load pass is not
pending, and the scheduler is idle. No `Server.idle()`, and no frame barrier
for the home space; the loopback session keeps carrying the loop's own commit
confirmations, which settle sealed layers and are not inputs. A foreign
space's session, which still delivers that space's writes as frames, keeps
its `inputSynced()` barrier until foreign spaces read through their engines
the same way. The coverage math (`#barrierHead`, `#visibleInputHead`, prefix
coverage) keeps its meaning and gets its proof from the feed rather than the
barrier: the batch head is the highest feed record integrated when the
scheduler was last observed idle. `serving-loop.md` §3's prefix-coverage
paragraph describes the frame barrier as the mechanism and is amended to name
either; the rule it states, which sequence W may cover, does not change.

**Demand crosses as deltas.** `demandChanged` carries the changed session's
rows (its full current demand, or its removal), the space server keeps the
mirror it already compares against, and `demandForSpace` and
`viewInterestsForSpace` become reads of that mirror on both arms. The server
is the one producer, so the mirror is exact; an observer installed late
replays every session's rows once, as the session mirror does today.

**Post-commit work pipelines.** After `commitWave` returns, the loop awaits
only what the next settle depends on: the foreign warm notices, the sealed
contributions' settlement and the delivery reconciliation. The view-plan
publish and the outbox drain start and run alongside the next cycle, each
single-flighted so a slow one is joined rather than duplicated, and a failure
in either is reported where it is reported today.

**The cadence becomes a policy, measured.** With the settle local, a wave
closes when the scheduler is idle or at the deadline, and a cycle is one
input batch. Whether nearby inputs should share a cycle beyond that is
decided by the measurements, not ahead of them: the knob is the coalescing
window between a feed arrival and the cycle it starts, and the default is
none until the numbers say otherwise.

## What does not change

The wave is the commit unit, carrying the derived writes, the consequence
list and the watermark in one derived-class commit; the §3d conflict rules;
CFC, which evaluates per action run at seal, never over the wave; the
deadline as the multi-user latency bound; the OFF arm and clients.

## Stages

1. [ ] **A cycle's phases on the health route.** Timing rows for each phase
   of a cycle, and the settle's three waits apart (the runtime's idle, the
   server's idle, the frame barrier), so the baseline below is per phase and
   each stage's effect is read from the same rows. The baseline is the
   record above: cycles, settle and cycle medians, `demandPassMs`, and the
   vote burst's wave count and time.
2. [ ] **Demand as deltas.** The observer event carries rows, the space
   server's mirror answers the pass, both arms. Expected: the pass drops from
   8 and 96 ms to a lookup; cycle medians fall by that.
3. [ ] **Local quiescence under read-through.** The settle's probe over the
   feed and the scheduler for the home space, the frame barrier kept for
   foreign sessions, the spec paragraph amended. Expected: settles end on
   quiescence rather than the deadline, `wavesBudgetExhausted` falls toward
   the share of cycles with real cascades, and the seed's cycle count falls.
4. [ ] **Pipelined post-commit.** The publish and the outbox drain off the
   cycle's critical path.
5. [ ] **Cadence and the number.** The coalescing knob, measured on the vote
   burst and the seed under both postures against the client arm: the
   burst's wave count and settled time are the target, a watch add near its
   loop-absent cost and a watermark lag of one are the constraints. If the
   burst stays an order of magnitude above the client arm, the two-tier
   write-class split `serving-loop.md` §3 records as the fallback is the next
   design, and it goes through the specification first.
