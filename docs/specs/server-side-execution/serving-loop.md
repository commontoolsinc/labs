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
  `revision`, `head`, `branch`. There is NO lease table on main:
  `execution_lease` is CREATED in Phase 1 (§2), with the v1 branch's
  shape as prior art, not substrate (branch `engine.ts:497-507`:
  branch PK, `lease_generation`, `host_id`, `on_behalf_of`, state
  `active|draining|revoked`, `expires_at`).
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
   │  ├─ subscription (accepted-commit feed for the space, from the
   │  │                activation scan's head — §3, §6)
   │  └─ outbox       (post-commit external effects, at-least-once)
   └─ activation policy (which spaces are active)
```

A space is ACTIVE when it has ≥1 live client session or undelivered
events; otherwise it MAY be parked (runtime disposed, lease released).
Activation on: session open, event append, or explicit warm request.

What activation LOADS (RULED 2026-08-02): there is NO piece-start
policy in v2. The space is ONE lazy reactive graph, and activation
loads graph structure sufficient to resolve the demanded values and
the queued events — never "instantiate the pieces" as a step of its
own. Demand is value-granular client pull: a subscription to a value
recomputes that value and its upstream, nothing else. Events run
their handlers eagerly. Undemanded derivations stay
dirty-unmaterialized indefinitely — `idle()` already excludes them
(§3b's pull-based laziness). Per-piece start/stop, root-piece
bootstrap, and auto-start-on-event are client-era framings with no
server analogue (runtime-mapping.md N22/N31).

Activation mechanics: the memory server notifies the ExecutorHost on
any AUTHORED admission into a space with no live lease — an
admission-side hook, not a poll (prior art: the no-handler auto-load
path, `scheduler/events.ts:331-345`). Host boot discovery is a
per-space check: stream head past `eventWatermark` means undelivered
events, so activate. A park racing an incoming commit self-heals: the
hook re-fires on the next admission.

## 2. The lease (single-deriver, operationally)

The invariant "derived state has exactly one deriving committer" holds by
construction against *clients* (no code path). Against *other server
processes* (deploy overlap, partition) it holds via the lease:

- One row per space in `execution_lease`: `(space, holder, expiresAt)`.
  The table is CREATED in Phase 1 — it does not exist on main; the v1
  branch's richer shape (see Anchors) is prior art to reduce from, not
  substrate to keep.
- Acquire with a conditional write; TTL 15 s; renew every 5 s **by direct
  table update — a lease renewal is NEVER a commit** (v1's renewal-adjacent
  traffic was part of the storm).
- On renewal failure or expiry: the SpaceServer MUST stop committing
  immediately (in-flight transaction aborts), then re-acquire or park.
- The memory server rejects a derived-class commit whose `holder` does not
  match the live lease. This is one equality check, not admission
  machinery.
- Liveness is judged by the MEMORY SERVER's clock: admission compares
  `expiresAt` against its own clock, and an expired row matches NOBODY —
  a derived commit under an expired lease is rejected even before any
  successor acquires. Holder clocks never arbitrate liveness.

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
  load graph structure for demanded values + queued events (§1 —
    no piece-start step; undemanded nodes stay unmaterialized)
  W = read watermark doc (0 if absent)
  re-mark the dirty frontier from the basis index (§3b, §6):
    a node is dirty iff a recorded input seq is behind that doc's head
  subscribe(space, from = the head the index scan ran against)

on commits [s..n] arriving (the wave's input batch; commits arriving
mid-wave belong to the NEXT wave — natural double-buffering, no timers):
  for each commit c:
    if c.class == derived and c.holder == self: continue   // own echo
    mark dirty: resolve c's written docs/paths against the dependency
    graph's input links (the scheduler's existing dirtiness path)
    if c.class == event-append: enqueue for handler processing (events.md)
  // The wave is THE REGULAR SCHEDULER run to idle — no phase split,
  // no event handling outside it (D-v2-2, ruled 2026-08-02). Events
  // enter the scheduler's ordinary queue; idle() does not resolve
  // until every queued event is processed, same as a client today.
  // Handler-input freshness is the scheduler's existing rule: a dirty
  // computed input is recomputed ON DEMAND before the handler that
  // reads it runs, and only then (anchor:
  // scheduler/event-preflight-dependencies.ts). Pull-based laziness
  // therefore still skips derived work nothing demands — which is
  // where rapid-fire coalescing comes from: superseded intermediates
  // are skipped by laziness, not by an explicit drain phase.
  run scheduler to QUIESCENCE — scheduler.idle()
  (packages/runner/src/scheduler/facade.ts:1191-1301) resolves; it
  awaits queued AND parked events, running actions, and demanded pull
  work — the eager/idle-scheduled actions and their cascades included.
  It does NOT await undemanded dirty computeds (pull-based laziness,
  §3b), commit durability, or post-commit async builtin work
  (run.ts:563-572 rides runtime.settled(), which maps to the outbox
  here). There is no separate commit for idle-time work.
  commit one derived-class transaction containing:
    - all derived cell changes of this wave (final values only)
    - consequenceOf: every eventId drained this wave
    - watermark doc := n
  hand external effects to the outbox (post-commit; see §5)

on wave budget exhaustion (a cascade that will not quiesce within the
scheduler's pass budget): commit the wave anyway — the in-memory state is
a consistent snapshot — count wavesBudgetExhausted, and advance W NOT AT
ALL: an exhausted wave's commit carries no watermark movement
(`derivedThrough` stays at the current W). Continuation waves carry the
cascade as dirtiness; W jumps to the top of the pending input batch only
at true quiescence. Crash recovery stays sound because the basis index
re-marks the truncated dirty frontier (§3b, §6) and memo hits suppress
effect re-fires.

on idle (no dirty work, no queued events) for IDLE_PARK_MS:
  park per activation policy
```

Rules:

- **One derived commit per wave.** If the wave's changes exceed a
  transaction-size bound, split by piece: every split carries the same
  final `derivedThrough` metadata, the watermark DOC write rides ONLY
  the last split, and all splits land before the loop takes new input.
  The amplification budget (README §3.3) is enforced here as ONE
  metric: `derivedCommits / (authoredSeen − effect-channel acks)` MUST
  stay ≤ 2 on pure workloads and ≤ 3 on workloads with effectful nodes
  (their completion commits are derived-class) — a logical write is one
  authored commit excluding effect-channel acks (testing.md §4).
- **The loop never awaits the network.** Effectful built-ins resolve from
  memo (§4) or yield a pending marker; the network call runs in the
  outbox, and its completion re-enters the loop as a new dirty input
  (result cell write). This is the v1 `compileAndRun` outbox lesson,
  generalized.
- **Self-echo is a no-op**: the subscription will deliver the loop's own
  derived commits back; they are identified by commit class + holder and
  skipped before dirtiness marking. Outbox completion commits (§4) are
  self-echoes too: their dirtiness is injected IN-PROCESS post-commit,
  so the subscription copy is skipped like any other.
- Waves are processed in seq order; there is no concurrency per space.
  Cross-space concurrency is free (separate SpaceServers).

## 3b. Reading state: discovery by running (D11)

There is no static read analysis anywhere in v2. Reads are discovered by
executing:

- Every run (handler, computed, eager action) executes in a transaction
  that logs each read — doc, path, version (the reactivity log,
  `packages/runner/src/storage/reactivity-log.ts`). The scheduler
  subscribes the node to exactly its LAST run's read set.
- **Dynamic dependencies are one-run-late, and that is sound**: a node
  cannot newly read C except as a consequence of a change in something
  it already read — the branch that reaches C is conditioned on prior
  inputs. Run k's read set decides the wake for k+1; dependencies
  discovered in k+1 take effect for k+2.
- **Whether a node runs at all** is the equality cutoff on the same
  machinery: an unchanged upstream output never dirties downstream, so
  conditional secondary inputs are never read and never subscribed.
  Pull-based laziness composes: undemanded computeds do not run;
  dirtiness travels last-known edges as a flag until demand pulls a
  recompute.
- **Snapshot discipline**: a wave reads the store at its input batch's
  seq (mid-wave commits are next wave's input), so a mid-run discovered
  read cannot tear.
- **Cross-space**: the first foreign read (executed under the piece's
  granted authority) registers, by being logged, a server-internal wake
  on that doc for the home SpaceServer. Same one-run-late soundness.
  v2 assumes spaces co-hosted on one memory server; sharding is out of
  scope.
- Read sets are authoritative IN MEMORY. Two persisted forms are
  distinguished, and confusing them is how v1 died:
  1. **The basis index (CORRECTNESS-BEARING for recovery)**: compact
     rows `(action, entity, seq)` — "output current iff these inputs
     unchanged since these seqs" — written INSIDE the wave's derived
     transaction (never own commits; amplification untouched). In-wave
     reads share the wave's own commit seq. Purpose: recovery and warm
     start are the SAME move — activation re-marks the dirty frontier
     by comparing recorded input seqs against current heads (§6), and
     skips still-current nodes instead of recomputing the world.
     Recovery DEPENDS on this index (own derived commits are echo-
     skipped live, so commit replay cannot re-mark the frontier); what
     keeps it on the right side of the no-payload lesson is its shape:
     ids + seqs only, overwritten in place per action — never payloads,
     never per-run history — and admission never reads it. It is NOT
     the evidence log (§8's exception says the same). Prior art being
     REDUCED, not a kept shape: main's `persistentSchedulerState`
     persisted form (`scheduler_observation` full-JSON payloads with
     replay/snapshot/context-floor machinery, OFF by default on main)
     fails this section's own test; the v2 index is a NEW schema of
     standalone `(action, entity, seq)` rows replacing those payload
     tables (deletion + reduction tracked in plan Phase 1; pre-arc
     #3646 is the scope precedent).
  2. **The evidence log (FORBIDDEN — tripwires §8)**: per-run link
     payloads, certificates, replay records — 130 KB per map run in v1.
     The test between the two: payloads or per-run history ⇒ evidence;
     ids + seqs, overwritten in place per action ⇒ basis index.
  W, `eventWatermark`, and the basis index are the correctness-bearing
  persisted forms; commit REPLAY bears nothing — recovery never replays
  (§6). Client reload needs none of this: every derived value is
  committed, so client reload is read-and-render.

## 3c. CFC: the enforcement boundary is the action run

Batching commits MUST NOT coarsen CFC granularity. If flow control
evaluated at the wave commit, the wave's read-union would taint every
write in it — one action reading a secret would overtaint an unrelated
action's public write. Therefore, normatively:

- CFC evaluates at the END OF EACH ACTION RUN, against that action's own
  logged read set (§3b) — the same Runtime code path as a client today,
  including the existing rejected-write drop
  (`reportDroppedCfcRejectedWrite`, `scheduler/events.ts`).
- The wave transaction carries only writes that individually passed
  their action's check; each write keeps per-action provenance for label
  purposes (the `cfcFlowLabels` ladder applies unchanged). The commit is
  transport; enforcement already happened per action, in memory.
- Handler runs are actions: a server-side handler run gets per-run CFC
  exactly as its client run did. D-v2-1 moves WHERE handlers run, never
  the enforcement unit.

FORBIDDEN: wave-level label unions; deferring any CFC check to commit
or admission time; a server bypass ("the server is trusted") — the
server is trusted with AUTHORITY, not with skipping flow control over
user data.

## 3d. Transactions: the action tx seals into the wave

Today 1 action run = 1 `IExtendedStorageTransaction`, and the per-action
bookkeeping (reactivity log, CFC at close, basis capture, failure
isolation) hangs off it. v2 KEEPS that object and interface — `action(tx)`
is unchanged — and changes only the destination: server-side, an action
tx SEALS into the wave accumulator instead of committing to the store.
Sealing fires everything commit fires today: the read log feeds the graph
and basis rows (§3b), CFC evaluates against this action's reads (§3c),
and the action's passed writes join the wave.

- The accumulator is a layered view: store snapshot at the wave's input
  seq + previously sealed writes. Actions run serially per space, so a
  later action reads earlier ones' sealed writes; intra-wave ordering is
  the scheduler's ordering.
- Failure isolation is per action: an aborted tx discards only its own
  writes; the wave keeps the rest.
- On a client (OFF arm, and speculation in the ON arm) seal == commit /
  overlay-apply as today — one abstraction, two destinations. Anchor:
  `packages/runner/src/storage/extended-storage-transaction.ts`.

**Mid-wave concurrency rule**: the wave commit CASes PER DOC against
the wave's read basis, and conflict handling is PER WRITE CLASS:

- **Pure derivation writes**: a doc whose head advanced past the basis
  (a concurrent authored commit landed mid-wave) has its derived write
  DROPPED from the wave commit — the concurrent commit is already the
  next wave's input and recomputes that derivation from fresher state.
  Dropping is sound exactly because derived values are re-derivable.
  Count drops as `wave.supersededWrites`.
- **Non-re-derivable writes** — `eventWatermark` advances,
  handler-consequence writes, effect intents — are REBASED AND RETRIED:
  re-CAS against the new head, merging at field level (these are
  advances and appends that commute with concurrent authored appends).
  If the rebase conflicts semantically, roll the affected events back
  to unconsequenced (requeue) rather than lose them. events.md §4's
  atomicity survives the retry: the watermark advance and its
  consequences move TOGETHER into the rebased commit, never
  separately.

Dropping would be unsound for authored values, which is one more reason
the classes never share a commit. Whole-wave CAS failure is FORBIDDEN
(livelock under sustained authored traffic), as are blind derived
writes (clobber).

**Multi-space seals** (`.inSpace(...)` provisioning): one tx writes one
space by DEFAULT; a tx crosses only via the explicit opt-in chain —
`.inSpace()` → `optIntoInSpaceMultiSpaceCommit`
(`builder/pattern.ts:1084`) → `enableCrossSpaceChildCommit`
(`runner.ts:4733`, commit order `[children..., parent]`) →
`enableMultiSpaceWrites` (`interface.ts:786`). Opted-in writes are
sequenced at the commit step — foreign authored commits first, home
derived commit after success — per protocol.md §2b (today's
`commitMultiSpace`/`runSplitCommits`, `v2-transaction.ts:2077/2156`:
sequential, stop at first failure). The wave does not close until the
split completes or fails as a unit (same-host store sequencing, not a
network await).

## 3e. Pattern updates

The SpaceServer owns the pattern-source watcher and the hot-swap. Today
both halves run CLIENT-side when `systemPatternAutoUpdate` is on — on
in shell, off in server processes (EXPERIMENTAL_OPTIONS.md): the
post-instantiation source check and the live swap via the
`patternIdentity` meta sink, teardown + reinstantiation included. Under
the flag that posture FLIPS: pieces run only in the SpaceServer, so the
watcher and the swap MUST run there — a pattern-pointer write is an
ordinary authored input that dirties the piece, and the swap is the
server reacting to it (runtime-mapping.md N40/N41). The pointer write
itself stays authored-class under the updater's principal. Plan
Phase 1 carries the task.

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
  completion, commit result + key in one derived-class commit and
  inject the result-cell dirtiness IN-PROCESS, post-commit — the next
  wave consumes it directly. The subscription's copy of the completion
  commit is an ordinary self-echo and is skipped (§3). A crash between
  completion commit and consumption is covered by recovery: the basis
  index shows the consumers stale against the result doc's head (§6).
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
2. Re-mark the dirty frontier from the BASIS INDEX (§3b): a node is
   dirty iff a recorded input seq is behind that doc's current head.
   Recovery is index-guided re-marking, NOT commit replay — own derived
   commits are echo-skipped live (§3), so replay could not re-mark the
   frontier anyway. Subscribe from the head the index scan ran against;
   later commits arrive as ordinary input.
3. The first wave recomputes the dirty frontier; memo hits suppress
   re-firing completed effects; memo misses re-fire effects whose
   results never landed. External effects are therefore at-least-once
   across crash/lease-handover (the request may have left the process
   before the crash) — RULED and accepted (owner, 2026-08-02). A
   fired-marker (a durable "request left" write ahead of each effect)
   was considered and REJECTED: it costs a commit per effect yet
   cannot close the window — the marker write and the request can
   still straddle a crash.
4. Undelivered events — stream head past `eventWatermark`, the §1 boot
   check — reprocess (events.md §5); events at/below the watermark are
   skipped by the idempotency rule.

There is NO replay log, NO persisted run observations, NO snapshot of
scheduler state beyond W, `eventWatermark`, and the basis index's
ids + seqs rows (§3b — payloads stay FORBIDDEN). If recovery seems to
need more than these, the design is wrong somewhere else — stop and
escalate.

## 7. Counters (implement with the loop, not after)

Exposed via the existing `/api/health/stats` shape, replacing v1's pool
block: `servingLoop: { activeSpaces, waves, wavesBudgetExhausted,
authoredSeen, effectAcks, derivedCommits, watermarkLag, events:
{appended, processed, coalescedPerWaveMax, skippedIdempotent}, memo:
{hits, misses, inflight}, outbox: {queued, completed, failed}, lease:
{held, lost} }` (`effectAcks` counts effect-channel ack writes, so the
§3 amplification metric is computable from counters alone). Every
Phase gate in the plan reads these counters; tests MUST assert on
counters, not logs.

## 8. Tripwires (grep-able FORBIDDEN list)

If any of these identifiers (or obvious synonyms) appear in NEW v2
code, the survival test was skipped — reject the diff:

`claim`, `candidate`, `settlement`, `fence`, `rank`, `contextKey`,
`completeSchedulerScopeSummary`, `scopeSummary`, `evidence`,
`observationReplay`, `shadowRun`, `admissionCertificate`.

Scope: the tripwires bind NEW v2 code. Main still carries a
`completeSchedulerScopeSummary`/observation surface pre-deletion; its
removal is tracked as plan Phase 1 work, and the existing main files do
not trip the list until that deletion lands.

The intentional exceptions: `execution_lease` (§2 — CREATED in
Phase 1; the v1 branch's shape is prior art, not existing substrate)
and the basis index tables (§3b — a NEW reduced schema of ids + seqs
only, overwritten in place; correctness-bearing for recovery but never
payloads, so NOT the evidence log).
