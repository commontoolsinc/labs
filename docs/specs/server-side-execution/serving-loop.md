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
their handlers eagerly — after preflight makes any dirty state
inputs current (D-v2-2). Undemanded derivations stay
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

Wiring, by plane. Every byte between these components travels on
exactly ONE of two planes; the split is what keeps bookkeeping off
the commit stream (README §3.3):

```
loopback-runtime plane               direct-engine plane
(storage protocol — carries every    (raw engine-table access —
commit the host produces)            carries no commit, ever)

SpaceServer runtime ◄──────────┐     ExecutorHost
  │ (a)                    (d) │       │ (c)
  ▼                            │       ▼
IStorageManager                │     execution_lease table
  │ (a)                        │     (same engine-v3 store)
  ▼                            │
memory server ─────────────────┘
  │ (b)
  ▼
ExecutorHost ── activate ──► SpaceServer

SpaceServer outbox ──(e)──► network; results re-enter via (a)
```

- **(a) runtime → IStorageManager → memory server**: the ONLY
  commit path — each wave's one derived commit (final values,
  watermark doc — §3) and the outbox's AUTHORED commits
  (cross-space event appends, `.inSpace` provisioning —
  protocol.md §2b) all enter the store here. Basis-index rows (§3b)
  travel on this plane too, but as part of the store TRANSACTION —
  never as part of the commit REPRESENTATION: they are engine table
  rows, they are not pushed to any subscriber (protocol.md §3), and
  admission never reads them (protocol.md §7). "On the storage
  protocol" must not be read as "on the wire".
- **(b) memory server → ExecutorHost**, in-process: the
  admission-hook activation feed — an authored admission into a
  space with no live lease NOTIFIES the host, and activation then
  follows this section's ACTIVE criteria (≥1 live session or
  undelivered events; never a poll). The distinction matters for
  provisioning: an `.inSpace` write is an authored admission into
  a lease-less space, but alone it meets neither criterion, so the
  minted space stays parked until its first session or event —
  reconciling protocol.md §2b's "activates later" with this hook
  (trace finding T11.Q7).
- **(c) ExecutorHost → engine tables**: lease acquire and renew by
  direct table update — the direct-engine plane's ONLY traffic, and
  a renewal is NEVER a commit (§2).
- **(d) memory server → runtime**: the space subscription delivers
  accepted commits from the activation scan's head (§3, §6); the
  loop's own derived commits return here too and are skipped by
  class + holder (self-echo, §3).
- **(e) outbox → network**: post-commit external effects,
  at-least-once under memo-key dedupe (§4–§5); completions re-enter
  as derived commits on (a), dirtiness injected in-process (§4).

## 2. The lease (single-deriver, operationally)

The invariant "derived state has exactly one deriving committer" holds by
construction against *clients* (no code path). Against *other server
processes* (deploy overlap, partition) it holds via the lease:

- One row per space in `execution_lease`: `(space, holder, expiresAt)`.
  The table is CREATED in Phase 1 — it does not exist on main; the v1
  branch's richer shape (see Anchors) is prior art to reduce from, not
  substrate to keep.
- **`holder` is a PER-PROCESS identity (DR1, RULED 2026-08-03):**
  the SpaceServer's service identity plus a process-instance
  component minted at PROCESS START — stable across every renew and
  reacquire within one process lifetime (it stays a nameable,
  attestable identity, so protocol.md §1's "the envelope principal
  IS the lease holder" reads literally), fresh whenever the process
  is genuinely new. The equality check below thereby fences every
  CROSS-process succession (deploy overlap, a successor host) for
  free. The one residue — a same-process reacquire after a pause
  that outlived the TTL (a runtime GC pause is the canonical cause;
  nothing to do with the deferred session-data GC of scopes.md §8) —
  is covered by the stop-committing-immediately MUST below,
  enforced IN-PROCESS before reacquiring (an in-memory generation
  counter suffices; co-hosting makes the abort-before-reacquire
  sequencing local and cheap). This is also why the FORBIDDEN list
  bans per-commit fencing tokens: v1's `lease_generation` is not
  needed — not because fencing is unwanted, but because the
  holder's process component already fences across processes and
  the in-process residue is a local obligation, not wire machinery.
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
  // Handlers run eagerly — but only after preflight makes any dirty
  // state inputs current (D-v2-2): the scheduler's existing rule
  // recomputes a dirty computed input ON DEMAND before the handler
  // that reads it runs, and only then (anchor:
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

on wave budget exhaustion — EITHER trigger (deadline RULED, owner
2026-08-04): (a) a cascade that will not quiesce within the
scheduler's pass budget, or (b) the CONSEQUENCE-FLUSH DEADLINE — a
wave still running at T_flush commits what is sealed so far. ONE
mechanism for both: commit the wave anyway — the in-memory state is
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

**The deadline is the MULTI-USER LATENCY bound.** Without it, one
user's heavy demanded fan-out delays every other user's consequence
visibility in the same batch — head-of-line blocking ACROSS users,
because the whole input batch commits once at the batch's derived
closure. With it, a consequence is visible within roughly
2·T_flush + push even while the wave behind it keeps deriving.
Light waves never reach the deadline and stay single-commit — the
zero-delta case, which is why this is a trigger on the EXISTING
exhaustion machinery rather than a new commit topology. T_flush is
a policy knob (order 50–100 ms), tuned in Phase 6 with the other
budgets; `wavesBudgetExhausted` counts both triggers, and the
amplification budget's inspection rule treats deadline flushes
under load as a legitimate re-baseline reason (testing.md §4).

**Sealing order makes the first flush worth flushing**: events and
their handler consequences MUST seal ahead of deep demanded
recomputes. The loop already behaves this way — events run eagerly,
derivations are demanded pulls — this sentence pins it so an
implementation does not reorder. Per-stream `eventWatermark` still
advances for events fully processed in an exhausted wave, and
`consequenceOf` carries them, so overlay echoes retire on the FIRST
flush (speculation.md §4) even when W lags to quiescence.

**Considered and RECORDED as the fallback, not built** (owner,
2026-08-04): the two-tier WRITE-CLASS split — every wave committing
its non-re-derivable tier (handler consequences, `eventWatermark`
advances, effect intents, cascade entries) ahead of a re-derivable
tier. It buys constant consequence latency at a CONSTANT 2×
amplification floor plus a steady-state consistency seam between
consequences and their derived views; the deadline buys the same
latency bound load-adaptively on machinery that already exists and
is model-verified (C10). Adopt the split ONLY if Phase 3's
propagation gate (≤300 ms p50, testing.md §5) fails under realistic
fan-out with the deadline alone — and if adopting, split by WRITE
CLASS (the §3d conflict seam, which makes the second tier
drop-only and keeps the watermark-with-consequences atomicity),
never by "handlers vs reactive".

Rules:

- **One derived commit per wave.** If the wave's changes exceed a
  transaction-size bound, split by piece: every split carries the same
  final `derivedThrough` metadata AND the same full `consequenceOf`
  list (bounded by wave input, so repetition is cheap — and
  required: push is per-recipient filtered by `scope_key`, so the
  split a client happens to receive must itself carry the eventIds
  its overlay reconciliation matches — speculation.md §4), the
  watermark DOC write rides ONLY
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
- **Scope discovery is part of read discovery**: a run's scope is the
  narrowest scope of anything it read, so it too is discovered by
  running. A narrowing discovery writes the broad-slot redirect AND
  the discovering run's own instance; SIBLING instances materialize
  on their own demand like any other undemanded derivation
  (scopes.md §2, ruled 2026-08-02 batch 4, corrected by the S3
  review). The redirect write dirties the broad slot's readers in
  the same wave, and demanded siblings are ordinary demanded work
  under §3's budget rule.
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
     ids + seqs only, overwritten in place per (action, instance) —
     never payloads,
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
     ids + seqs, overwritten in place per (action, instance) ⇒ basis
     index.
  W, `eventWatermark`, and the basis index are the correctness-bearing
  persisted forms; commit REPLAY bears nothing — recovery never replays
  (§6). Client reload needs none of this: every derived value is
  committed, so client reload is read-and-render.

The index's DDL, authored (closes scopes.md §8 item 1). This is the
engine-v3 migration Phase 1 stage C reduces the observation tables
to. The NORMATIVE content is the columns, the keys, and the drops;
SQL types and secondary indexes (e.g. an entity-keyed lookup mirror
of today's `idx_scheduler_read_index_lookup`) are implementation
detail:

```sql
-- One standalone table. No FOREIGN KEY clauses anywhere: v1's
-- satellites all hung off scheduler_observation; the v2 index
-- references nothing and nothing references it.
CREATE TABLE scheduler_basis (
  branch           TEXT,    -- engine-v3 branch, as on every table
  action           TEXT,    -- durable action identity/fingerprint;
                            --   restart-stable (a per-process
                            --   component would empty the index
                            --   exactly when recovery reads it)
  action_scope_key TEXT,    -- the INSTANCE that ran (scopes.md §7
                            --   M2 re-keying; scope_key vocabulary
                            --   is today's `resolveScopeKey` —
                            --   packages/memory/v2/engine.ts:98 —
                            --   moving to the wire-shape module
                            --   per LD3, key-vocabulary.md §3)
  entity_space     TEXT,    -- the input doc's space: foreign reads
                            --   are logged reads too (cross-space
                            --   bullet above)
  entity           TEXT,    -- the input doc id
  entity_scope_key TEXT,    -- the input INSTANCE read
  seq              INTEGER, -- the input's seq at read time, in the
                            --   entity's own space's sequence;
                            --   in-wave reads share the wave's
                            --   commit seq
  PRIMARY KEY (branch, action, action_scope_key,
               entity_space, entity, entity_scope_key)
);
```

Rules the shape carries, binding:

- **Overwrite in place, per (action, instance)**: a run of
  (`action`, `action_scope_key`) — scopes.md §8's overwrite unit —
  REPLACES that instance's rows as a set. Never append beside a
  previous run's rows: per-run history is the evidence log's
  signature (§8).
- **Doc-granular, ids + seqs ONLY**: no path column, no payloads.
  Path precision stays in-memory in the reactivity log; a JSON path
  column is the first step back toward evidence.
- **Carriage**: rows are written INSIDE the wave's derived store
  TRANSACTION (above — never own commits). protocol.md §3 and §7
  carry the matching sanctions, so the closed metadata list stays
  closed: basis rows are engine table rows on the loopback store
  transaction, never commit metadata, never pushed, never read at
  admission.
- **Narrowing DELETES the rows it stranded** (S4, binding): a run
  whose DISCOVERED scope is narrower than the instance key its rows
  are recorded under MUST delete that key's rows for that action, in
  the SAME wave transaction that writes the narrowed rows. Without
  this the old key's rows survive forever and §6's re-mark rule
  re-dirties a zombie at every activation — and a `space`-key zombie
  has no runnable identity, so it can never overwrite its own rows
  and never stops being dirty. Deleting is sound for the same reason
  overwriting is: the rows are a basis cache, not history.
- **Interim retention is UNBOUNDED, and that is accepted** (S8).
  Rows at `space` and `user:<p>` keys are touched by no session
  retirement; main's 32-per-action execution-context cap
  (`packages/memory/v2/engine.ts:55`) dies with the dropped tables
  and `scheduler_basis` specifies no replacement bound. The
  narrowing rule above removes the one case that would grow without
  a run to overwrite it; everything else is bounded in practice by
  overwrite-in-place per (action, instance). A real bound is the
  session-data GC design's job — OPEN, and it must cover
  non-session keys too (scopes.md §8 item 2).

Dropped WHOLE in the same migration — the payload/history tables,
the two the new schema replaces, and the write index:

```sql
DROP TABLE scheduler_observation;         -- payload evidence (§8)
DROP TABLE scheduler_action_snapshot;     -- per-run history
DROP TABLE scheduler_observation_replay;  -- replay FORBIDDEN (§6)
DROP TABLE scheduler_context_floor;       -- nothing left to floor:
                                          --   it gated SHARED
                                          --   snapshots across
                                          --   principals; the v2
                                          --   index shares nothing
                                          --   (scopes.md §7, ruled)
DROP TABLE scheduler_read_index;          -- REPLACED (below)
DROP TABLE scheduler_action_state;        -- REPLACED (below)
DROP TABLE scheduler_write_index;         -- write links are
                                          --   evidence, not basis:
                                          --   staleness is decided
                                          --   by READS alone
```

`scheduler_read_index` and `scheduler_action_state` are REPLACED,
not reshaped — this section's NEW-schema ruling above. Both FK into
`scheduler_observation` (dropped, so the spine is gone) and both
key by `process_generation`, which accumulates per-process history
where v2 overwrites in place; reshaping would rewrite every column
and both keys — a replacement wearing an ALTER costume. The plan's
stage-C criterion is the backstop: after this migration the basis
index is the ONLY persisted scheduler state besides W and
`eventWatermark`.

**WARNING — the drop list is SEVEN tables; main's own constant
enumerates SIX** (D6). `CORE_SCHEDULER_TABLES`
(`packages/memory/v2/engine.ts:1275-1282`) lists
`scheduler_observation`, `scheduler_action_snapshot`,
`scheduler_observation_replay`, `scheduler_read_index`,
`scheduler_write_index`, `scheduler_action_state` — and does NOT
include `scheduler_context_floor`, which is created and dropped
through separate statements (`engine.ts:2233-2245`). An
implementation that mechanically drives the migration off that
constant WILL leave the floor table behind and fail the plan's
stage-C criterion for a reason that reads like a mystery. Drive the
drop from the seven-table list above, not from the constant.

**NO BACKFILL** (D10). `scheduler_read_index` and
`scheduler_action_state` rows are NOT migrated into
`scheduler_basis`. The new table starts empty. A store that had
opted into `persistentSchedulerState` therefore loses warm start
ONCE, at the migration — acceptable because the index is a cache:
the first activation after the migration re-marks everything dirty
and recomputes, which is exactly what an absent index means (§6). A
migration that reads old rows would have to reinterpret
`process_generation` history as overwrite-in-place state, which is
the reshaping this section already rejected.

**Old client / new server compat is already answered** (D11): the
capability is negotiated at hello, and a client whose server did not
advertise `persistentSchedulerState` treats the state as absent and
runs fresh (`packages/runner/src/storage/v2.ts:2142` — the
`serverFlags?.persistentSchedulerState !== true` degrade path). A
server that has migrated advertises nothing to negotiate, so an old
client takes the same fresh path it already takes today. No version
handshake is added for this.

**Protocol-layer deletions ride the same migration** (D7). With the
persisted form gone the flag gates nothing, so the following delete
WITH the machinery — this is derivable, not a fork, and is listed
here so no one re-derives it mid-PR:

- the `persistentSchedulerState` experimental flag and its ambient
  control point (`setPersistentSchedulerStateConfig`);
- its `serverFlags` capability negotiation at hello (both sides);
- the `scheduler.snapshot.list` RPC and its client wrapper;
- `CommitData.schedulerObservation` — the commit-carried
  observation payload.

**Collateral that "byte-identical" gates do NOT cover** (D9, S7).
Dev tooling and live docs read these tables directly and break
silently, since no product test exercises them:

- `packages/state-inspector/scheduler.ts:15-19` (the five-table
  requirements map) and its readers at `246-281` — the inspector
  queries every dropped table by name;
- the `cf inspect` CLI surface that renders that output;
- `packages/memory/v2/sqlite/guard.ts:16-33` — the `CORE_TABLE_NAMES`
  blocklist that a pattern statement may never reference: the
  dropped names come OUT and `scheduler_basis` goes IN, or pattern
  SQL gains a reachable engine table;
- the two live specs that describe the persisted form:
  `docs/specs/persistent-scheduler-state.md` and
  `docs/specs/scheduler-v2/per-doc-rehydration.md`.

The stage-C TRAIN carries both halves (the plan cuts it as three
PRs): C.2 carries this migration; C.1 deletes the certificate
surface it ships beside (`completeSchedulerScopeSummary`
/ `completeActionScopeSummary` — README §5), and that half is NOT a
hand edit: ~110 fixture files under
`packages/ts-transformers/test/fixtures/` embed the emitted marker,
so the GOLDEN-REGENERATION procedure is a required step of the
change, not a follow-up. Plan Phase 1 stage C sizes the full
surface. (C.1's unconditional consumer deletion is safe for the
OFF-arm adoption path runtime-mapping.md N62 keeps: the one
certificate consumer in `facade.ts` —
`observationMinimumContextRank`, `facade.ts:213` — already
degrades to the most-restrictive rank on an ABSENT summary, and
`adoptRemoteObservations` never reads it; verified 2026-08-03.)

## 3c. CFC: the enforcement boundary is the action run

Batching commits MUST NOT coarsen CFC granularity. If flow control
evaluated at the wave commit, the wave's read-union would taint every
write in it — one action reading a secret would overtaint an unrelated
action's public write. Therefore, normatively:

- CFC evaluates at the END OF EACH ACTION RUN, against that action's own
  logged read set (§3b) — the same Runtime code path as a client today,
  including the existing rejected-write drop
  (`reportDroppedCfcRejectedWrite`, `scheduler/events.ts`).
- **The unit is the RUN, and a run is `action × instance`** (S5). Say
  "per action run", never "per action": under scope fan-out ONE
  action runs N times as N principals inside ONE wave (scopes.md
  §2), so an action-granular unit would merge N principals'
  provenance inside the load-bearing enforcement — the same
  over-tainting this section exists to prevent, one level down.
  Labels evaluate PER INSTANCE RUN.
- The wave transaction carries only writes that individually passed
  their action run's check; each write keeps per-action-run
  provenance for label purposes (the `cfcFlowLabels` ladder applies
  unchanged), and protocol.md §1/§7 carries attribution at exactly
  this granularity. The commit is transport; enforcement already
  happened per action run, in memory. The carried provenance's
  READER is main's existing read-time label derivation, unchanged
  (FP6, RULED 2026-08-03): a later run reading the cell — same
  wave or a later one — seeds its own ladder from the cell's
  labels; the carriage is what makes that input available
  server-side across waves, and no new enforcement point exists.
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
and the action's passed writes join the wave — carrying the run's
identity annotations with them: the acting identity and, on scoped
writes, the explicit `scope_key` (protocol.md §1's transaction
identity model). Attach at SEAL time, when the run still knows who
it ran as (the demand's instance or the event's stamped actor); the
wave commit step only batches what sealing attached — by then no
single "current user" exists to consult, which is the model, not a
gap.

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
  Count drops as `supersededWrites` (exposed in §7's counters).
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

**The event REQUEUE above is not events.md §5's event DROP** (T3).
Two different conflict notions share the vocabulary of this section
and must not be collapsed:

| | when it applies | consequence |
| --- | --- | --- |
| REQUEUE (this section) | the handler RAN and its consequence commit lost a per-doc basis CAS — the event is valid, only raced | rolled back to unconsequenced and retried in a later wave |
| DROP (events.md §5) | the handler CANNOT RUN AT ALL — its preconditions are gone (target stream/doc deleted, CAS base unrecoverable) | no consequences; a dropped-event notice on the stream entry, `eventWatermark` advances past it |

(The per-doc DROP of a superseded DERIVED WRITE, first bullet above,
is a third thing again — a write, not an event.) The event-drop
predicate is stated once, in events.md §5; this section cites it and
never restates it. A raced event is never dropped, and an unrunnable
event is never requeued — requeueing one would wedge the stream,
which is the failure `eventWatermark` advancement exists to prevent.

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
- **Miss rule**: enqueue the effect on the outbox with the key AND
  the run's identity carriage — the result-cell address including
  its instance `scope_key`, plus the run's acting identity where it
  had one, plus the run's CFC LABEL BASIS (FP6, RULED 2026-08-03).
  The completion commit is derived-class, so it carries
  protocol.md §1's annotations like any other — but it never passes
  through §3d's sealing (the run is long over when the response
  arrives), and the memo key cannot supply them (the instance is
  hashed in, not recoverable), so the outbox entry is the only
  carrier. The completion WRITE's labels derive from the carried
  request basis — an external result inherits its request's
  confidentiality; results are never default-unlabeled. On
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
timers inside the loop; a "pending effects" table (the EFFECT half of
the outbox is
process-local; on crash, missing results are re-missed from keys —
the durable rows of §5 carry APPENDS, never effect state).

## 5. The outbox

- EFFECT requests: a process-local queue of (space, memo key,
  request, authority
  handle, label basis + identity carriage — §4's miss rule: the
  result-cell
  address with its `scope_key`, the acting identity where the
  run had one, and the run's CFC label basis (FP6, RULED
  2026-08-03) so the completion write's labels derive from its
  request's — an external result inherits its request's
  confidentiality. Process-local is SOUND here: a crash re-misses
  the effect from memo keys (§4, §6; at-least-once, already ruled).
- **Cross-space event appends are DURABLE (FP1, RULED
  2026-08-03).** Their entries are engine-table rows written INSIDE
  the emitting wave's own store transaction — the basis-row
  carriage pattern, sanctioned in protocol.md §7 — and DELETED on
  delivery-ack: a queue that empties, never history, so the
  no-per-run-persistence lesson holds. A row carries the event
  (payload bounded by the event, never graph-scaled) plus the
  acting
  identity (`actingPrincipal` + `actingSession`) + `capabilityRef`
  that the target's admission validates and stamps `firedAt` from —
  actor inheritance crosses spaces through exactly this carriage
  (events.md §2). Activation re-sends pending rows (§6 step 5);
  the target's `eventId` horizon keeps processing exactly-once.
  This closes the crash window between wave commit and delivery
  that a process-local append queue could not survive.
- `.inSpace` provisioning rides NEITHER queue today: its foreign
  commits are SEQUENCED at the wave commit step — foreign-first,
  home-after-success, stop-at-first-failure (protocol.md §2b) — so
  a crash between the halves leaves the event unconsequenced and
  the deterministic replay converges. Outbox carriage is its
  sharded-future form only (§2b's closing note).
- At-least-once; idempotence comes from the memo hit rule (a duplicate
  completion writes an identical key and is a CAS no-op) for
  effects, and from the `eventId` dedupe horizon for appends.
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
5. Pending durable outbound-append rows (§5, FP1) RE-SEND; a
   duplicate of an already-delivered append dedupes at the target's
   `eventId` horizon. Nothing regenerates an EFFECT request from
   here — those re-miss from memo keys in step 3, by design.

There is NO replay log, NO persisted run observations, NO snapshot of
scheduler state beyond W, `eventWatermark`, and the basis index's
ids + seqs rows (§3b — payloads stay FORBIDDEN). If recovery seems to
need more than these, the design is wrong somewhere else — stop and
escalate.

## 7. Counters (implement with the loop, not after)

Exposed via the existing `/api/health/stats` shape, replacing v1's pool
block: `servingLoop: { activeSpaces, waves, wavesBudgetExhausted,
supersededWrites, authoredSeen, effectAcks, derivedCommits,
watermarkLag, events:
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
`completeSchedulerScopeSummary`, `completeActionScopeSummary`,
`scopeSummary`, `evidence`, `observationReplay`, `shadowRun`,
`admissionCertificate`, `lease_generation`, `fencingToken` (§2's
FORBIDDEN lease shapes, greppable — DR1's per-process holder is the
fence; a reappearing generation/token field is v1 revival).

Scope: the tripwires bind NEW v2 code. Main still carries a
`completeSchedulerScopeSummary` / `completeActionScopeSummary`
observation surface pre-deletion — the certificate has TWO
identifiers, and naming only the first has already let inventories
undercount the surface; its
removal is tracked as plan Phase 1 work, and the existing main files do
not trip the list until that deletion lands.

The intentional exceptions: `execution_lease` (§2 — CREATED in
Phase 1; the v1 branch's shape is prior art, not existing substrate)
and the basis index tables (§3b — a NEW reduced schema of ids + seqs
only, overwritten in place; correctness-bearing for recovery but never
payloads, so NOT the evidence log).
