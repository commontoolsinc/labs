# v2 detail: the serving loop

Normative spec for Phase 1 of
[the plan](../../plans/server-execution-v2.md). Read
[README.md](README.md) first; this document assumes its vocabulary.
MUST/NEVER language is binding on implementers.

## Anchors (verified on main, 2026-08-02 — re-verify before coding)

- Scheduler: `packages/runner/src/scheduler/` (`execution.ts`,
  `dependency-graph.ts`, `events.ts`, `event-identity.ts`). The scheduler
  already runs graphs to fixpoint on a client runtime; the serving loop
  hosts THAT scheduler server-side. Do not write a new scheduler.
- Runtime construction: `packages/runner/src/runtime.ts` (`new Runtime`),
  builtin registration `packages/runner/src/builtins/index.ts`
  (`registerBuiltins(runtime)`).
- Store: engine-v3 sqlite per space DID
  (`packages/toolshed/cache/memory/engine-v3/`), tables `commit`,
  `revision`, `head`, `branch`, and an existing `execution_lease` table.
- Memory server + protocol: `packages/memory/v2.ts`, mounted in toolshed
  at `/api/storage/memory`
  (`packages/toolshed/routes/storage/memory/memory.routes.ts`).

## 1. Components

```
toolshed process
└─ ExecutorHost (one per process)
   ├─ SpaceServer (one per ACTIVE space)
   │  ├─ lease        (execution_lease row, renewed on a timer)
   │  ├─ runtime      (ordinary Runtime, flag ON, server posture)
   │  ├─ subscription (accepted-commit feed for the space, from seq W)
   │  └─ outbox       (post-commit external effects, at-least-once)
   └─ activation policy (which spaces are active)
```

A space is ACTIVE when it has ≥1 live client session or undelivered
events; otherwise it MAY be parked (runtime disposed, lease released).
Activation on: session open, event append, or explicit warm request.

## 2. The lease (single-deriver, operationally)

The invariant "derived state has exactly one deriving committer" holds by
construction against *clients* (no code path). Against *other server
processes* (deploy overlap, partition) it holds via the lease:

- One row per space in `execution_lease`: `(space, holder, expiresAt)`.
- Acquire with a conditional write; TTL 15 s; renew every 5 s **by direct
  table update — a lease renewal is NEVER a commit** (v1's renewal-adjacent
  traffic was part of the storm).
- On renewal failure or expiry: the SpaceServer MUST stop committing
  immediately (in-flight transaction aborts), then re-acquire or park.
- The memory server rejects a derived-class commit whose `holder` does not
  match the live lease. This is one equality check, not admission
  machinery.

FORBIDDEN: per-action leases, lease fencing tokens per commit, lease
renewal via the commit stream, more than one lease shape.

## 3. The loop, normatively

State per SpaceServer: `W` = watermark, the highest space seq whose
derived consequences are fully committed. Persisted in the space (one
well-known doc, updated in the same transaction as derived commits — never
its own commit).

```
on activate(space):
  acquire lease (else park)
  runtime = new Runtime(serverPosture)   // flag ON, egress allow,
                                         // builtins registered
  W = read watermark doc (0 if absent)
  subscribe(space, from = W + 1)

on commits [s..n] arriving (the wave's input batch; commits arriving
mid-wave belong to the NEXT wave — natural double-buffering, no timers):
  for each commit c:
    if c.class == derived and c.holder == self: continue   // own echo
    mark dirty: resolve c's written docs/paths against the dependency
    graph's input links (the scheduler's existing dirtiness path)
    if c.class == event-append: enqueue for handler processing (events.md)
  // COALESCING: drain ALL queued events through their handlers first,
  // in per-stream seq order; handler writes accumulate in memory.
  // Handlers in the batch read derived state as of the last completed
  // wave (D-v2-2) — intermediate derived states for superseded inputs
  // are never computed at all.
  run every queued handler
  run the derivation fixpoint ONCE, to QUIESCENCE — scheduler.idle()
  (packages/runner/src/scheduler/facade.ts) resolves; this INCLUDES the
  scheduler's eager/idle-scheduled actions and whatever they cascade
  into. There is no separate commit for idle-time work.
  commit one derived-class transaction containing:
    - all derived cell changes of this wave (final values only)
    - consequenceOf: every eventId drained this wave
    - watermark doc := n
  hand external effects to the outbox (post-commit; see §5)

on wave budget exhaustion (a cascade that will not quiesce within the
scheduler's pass budget): commit the wave anyway — the in-memory state is
a consistent snapshot — count wavesBudgetExhausted, DO NOT advance the
watermark past inputs whose cascade was truncated, and continue the
cascade as the next wave's dirtiness. W catches up at true quiescence;
crash recovery stays sound because replay from W+1 re-marks the truncated
dirtiness and memo hits suppress effect re-fires.

on idle (no dirty work, no queued events) for IDLE_PARK_MS:
  park per activation policy
```

Rules:

- **One derived commit per wave.** If the wave's changes exceed a
  transaction-size bound, split by piece, but every split carries the same
  final watermark and lands before the loop takes new input. The
  amplification budget (README §3.3) is enforced here: the ratio
  (derived-class commits) / (authored commits processed) MUST stay ≤ 2 on
  the Phase 1 acceptance workloads.
- **The loop never awaits the network.** Effectful built-ins resolve from
  memo (§4) or yield a pending marker; the network call runs in the
  outbox, and its completion re-enters the loop as a new dirty input
  (result cell write). This is the v1 `compileAndRun` outbox lesson,
  generalized.
- **Self-echo is a no-op**: the subscription will deliver the loop's own
  derived commits back; they are identified by commit class + holder and
  skipped before dirtiness marking.
- Waves are processed in seq order; there is no concurrency per space.
  Cross-space concurrency is free (separate SpaceServers).

## 4. Effectful nodes: memoization contract

For `fetch*`, `generate*`, `sqlite*` (the §3.5 effectful class):

- **Memo key** = stable hash of (builtin id, canonical JSON of the
  resolved request inputs — after cell dereference, before any network
  activity). Canonicalization: sorted keys, no undefined, links by entity
  id + path.
- **Storage**: the result is an ordinary cell commit; the memo key is
  written alongside the result (same doc, `requestHash` field). No new
  tables.
- **Hit rule**: if the recomputed key equals the stored key, the stored
  result IS the node's value — no effect fires. This is what makes
  restart-recovery safe: recompute pure nodes, re-derive keys, reuse
  results.
- **Miss rule**: enqueue the effect on the outbox with the key; on
  completion, commit result + key in one derived-class commit;
  the loop picks it up as ordinary dirtiness.
- **In-flight dedupe**: one outstanding effect per key per space; a second
  miss on the same key attaches to the in-flight effect.
- Failures commit an error-shaped result (the existing builtin error cell
  conventions) with the key, so retries are input-driven (inputs change →
  new key), never timer-driven loops.

FORBIDDEN: re-firing an effect whose stored key matches; effect retry
timers inside the loop; a "pending effects" table (the outbox is
process-local; on crash, missing results are re-missed from keys).

## 5. The outbox

- Process-local queue of (space, memo key, request, authority handle).
- At-least-once; idempotence comes from the memo hit rule (a duplicate
  completion writes an identical key and is a CAS no-op).
- Authority: the capability handle bound at wiring time (README §3.8);
  the outbox holds provider credentials via the existing broker; the
  SpaceServer's runtime never sees raw secrets.
- Per-space budget hooks live here (Phase 6): outstanding-effect caps,
  egress rate.

## 6. Recovery, precisely

On activate after crash or deploy:

1. Acquire lease, read watermark W.
2. Subscribe from W+1 — authored commits since W replay as ordinary input.
3. The first wave recomputes dirty derivations; memo hits suppress
   re-firing completed effects; memo misses re-fire effects whose results
   never landed (correct: they never happened).
4. Events with seq > their consequence watermark reprocess (events.md §5);
   events at/below it are skipped by the idempotency rule.

There is NO replay log, NO persisted run observations, NO snapshot of
scheduler state beyond the two integers above (watermark; event
consequence watermark). If recovery seems to need more state, the design
is wrong somewhere else — stop and escalate.

## 7. Counters (implement with the loop, not after)

Exposed via the existing `/api/health/stats` shape, replacing v1's pool
block: `servingLoop: { activeSpaces, waves, wavesBudgetExhausted,
authoredSeen, derivedCommits, watermarkLag, events: {appended, processed,
coalescedPerWaveMax, skippedIdempotent}, memo: {hits, misses, inflight},
outbox: {queued, completed, failed}, lease: {held, lost} }`. Every Phase gate in the plan reads these counters; tests
MUST assert on counters, not logs.

## 8. Tripwires (grep-able FORBIDDEN list)

If any of these identifiers (or obvious synonyms) appear in a v2 diff,
the survival test was skipped — reject the diff:

`claim`, `candidate`, `settlement`, `fence`, `rank`, `contextKey`,
`completeSchedulerScopeSummary`, `scopeSummary`, `evidence`,
`observationReplay`, `shadowRun`, `admissionCertificate`.

The one intentional exception: `execution_lease` (§2), which predates v2.
