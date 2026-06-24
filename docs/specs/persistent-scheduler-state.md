# Persistent Scheduler State

## Status

Implemented behind `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` /
`Runtime.experimental.persistentSchedulerState`; the default-on rollout remains
a separate decision.

The landed implementation includes internal memory-v2 scheduler observation
tables, no-op observation commits, same-space durable dirty marking,
cross-space read-index mirrors, and snapshot query APIs. Resumed pieces now
await space sync once, load all scheduler action snapshots for the piece in one
batch, and apply matching observations synchronously as actions register.
Missing, invalid, or fingerprint-mismatched observations fall back to fresh
registration.

Observation payloads are now versioned. Payload v2 persists reads, shallow
reads, changed writes, materializer envelopes, action options, status markers,
and identity/fingerprints, but no longer persists `currentKnownWrites` or
`declaredWrites`; those write surfaces come from live action annotations during
registration. Readers accept both v1 and v2 rows. The runtime fingerprint is
`runner:scheduler:v2`, so old `runner:scheduler:pull` rows miss once and
rebuild conservatively.

The old subscription-time per-action rehydration race apparatus
(`awaitSpaceSyncedWithTimeout`, per-action tokens, shared timeout fallback, and
deferred initial execution) has been deleted; piece-level resume is the only
storage rehydration path for resumed pieces.

## Summary

The runner already observes most of the information needed to restart a piece
without re-running every node: each scheduler action records read paths, shallow
read paths, actual changed write paths, declared write paths, materializer write
envelopes, action type, and dependency edges derived from those paths. That
state is currently held in process memory. When the process restarts, the
runtime reconstructs the pattern graph and re-runs nodes to rediscover their
dynamic dependencies.

The memory layer, by contrast, persists transactions in SQLite. Memory v2 keeps
an append-only commit log, revision log, branch heads, and materialized
snapshots. Transactions already carry read dependencies and write operations,
but the persisted commit payload is not sufficient to reconstruct the scheduler:

- no-op transactions are dropped before they reach memory v2
- storage commits require at least one operation
- scheduler-only details such as shallow reads, current-known writes,
  materializer envelopes, action identity, and dirty/stale state are not
  persisted
- scheduler observations are keyed by JavaScript function object identity, which
  cannot survive process restart

This proposal persists transaction-linked scheduler observations for every
successful action dependency collection or action run, including no-op runs. It
also persists enough server-side scheduler indexes to dirty inactive pieces when
later transactions write paths those pieces read. On restart, the runner can
validate those observations against the current process graph, code identity,
branch head, and durable dirty state. Valid observations can rehydrate the
scheduler indexes directly. Invalid or missing observations fall back to the
current behavior: run dependency collection or run the action when demanded.

## Goals

- Rehydrate a piece without eagerly running every node when persisted scheduler
  observations are still valid.
- Rebuild trigger indexes, writer indexes, materializer indexes, and dependency
  edges from durable observations.
- Determine which actions are clean, dirty, stale, or unknown by comparing
  recorded read watermarks to committed writes after the observation.
- Persist enough server-side trigger/dependency state that writes can dirty
  inactive pieces which read the changed data.
- Persist no-op action observations, because a run can update dependencies or
  prove output stability without changing memory.
- Support demand-targeted rehydration: if only one output, effect, or event
  preflight is needed, run only the unknown or stale actions required for that
  demand.
- Keep transaction/CFC concepts such as `attemptedWrites` separate from
  scheduler dependency evidence.

## Non-goals

- Do not make scheduler observations part of ordinary user data snapshots or
  semantic revisions. This is not an architectural secrecy boundary: runner is
  the memory client's primary caller, so memory can expose scheduler-specific
  internal APIs where that keeps the implementation direct.
- Do not replace the memory v2 commit/revision/head/snapshot model.
- Do not replay event queues across process restart in this proposal.
- Do not make the memory server execute JavaScript actions. The server records
  dirty/stale scheduler state; runners still execute actions.
- Do not trust persisted scheduler state when the action's implementation,
  schema, process graph, runtime version, or branch context no longer matches.
- Do not promise zero execution after restart. The fallback path must remain
  conservative and correct.

## Current System Overview

### Scheduler

The scheduler currently keeps the following important state in memory:

- `dependencies`: latest scheduler `ReactivityLog` per action, with recursive
  reads, shallow reads, and actual changed writes.
- `triggerIndex`: entity/path indexes mapping storage changes to readers.
- `writeIndex`: current-known writes and optional historical might-write sets,
  plus entity to writer indexes.
- `materializers`: broad or dynamic writable-input computations indexed by
  materializer write envelopes.
- `dependents` and `reverseDependencies`: action-to-action dependency edges
  derived from reads and writes.
- `pending`, `dirty`, `stale`, and upstream-stale counts.
- action type and lifecycle state: effect vs computation, parent/child action
  relation, demand roots, debounce/throttle state, retry state, and action run
  timing.

Only some of that state is worth persisting. Diagnostics, timers, in-flight
transactions, retries, pending promises, and loop counters are process-local.
Dependency observations, action identity, action type, declared writes,
materializer envelopes, and read/write watermarks are restart-relevant.

Useful classification:

| State | Persist? | Reason |
| --- | --- | --- |
| action identity, type, graph generation | Yes | Needed to match observations to recreated actions. |
| latest reads and shallow reads | Yes | Needed to rebuild triggers and validate cleanliness. |
| current-known writes and materializer envelopes | Yes | Needed to rebuild writer/materializer indexes before running. |
| dependency edges | Optional | Derivable from reads/writes, but can be cached for faster startup. |
| dirty/stale sets | Yes | The server must dirty inactive pieces; runners can validate or rebuild from observations plus later writes. |
| pending/event queues | No | Process-local unless event queues become durable. |
| debounce/throttle configuration | Yes | It is part of scheduling behavior, but active timers are not. |
| timers, promises, retries, trace buffers | No | They are runtime execution state. |

### Runner And Storage Transactions

Action runs create an extended storage transaction, invoke the action, commit
the transaction, convert the transaction to a scheduler `ReactivityLog`, then
resubscribe the action with that log. The storage transaction can expose a
`TransactionReactivityLog` containing:

- `reads`
- `shallowReads`
- `writes`
- optional `attemptedWrites`

The scheduler-facing log deliberately drops `attemptedWrites`; attempted writes
are CFC/security evidence, not dependency evidence.

Observation attachment is best-effort over the action's active transaction. It
must not change the semantics of a transaction that the action intentionally
aborted or that has already completed. In those cases the scheduler skips
observation attachment and lets the existing action retry/error path handle the
transaction result.

No-op transactions are currently short-circuited. If a transaction has no write
space, or its native commit has no effective operations, the runner transaction
returns success without opening the replica or calling memory v2. This is good
for normal storage performance, but it means the persistent transaction log
does not learn that the action ran, what it read, or that it proved no data
change was needed.

Memory v2 commit construction also strips the transaction's non-recursive read
flag before sending confirmed/pending reads to the server. That is correct for
the current conflict model, but scheduler rehydration needs to retain the
recursive-vs-shallow distinction in its own observation record.

### Memory V2

Memory v2 stores one SQLite database per space. The durable state is:

- `commit`: canonical sequence, branch, session/local sequence, original client
  commit, and server resolution
- `revision`: append-only entity mutations
- `head`: latest entity revision per branch
- `snapshot`: periodic full entity documents
- `branch`: branch metadata

The current memory v2 engine rejects commits with zero operations. Therefore a
pure scheduler observation cannot simply reuse the existing semantic commit
shape unchanged.

### Process Graph Snapshot

The pattern-construction graph snapshot spec already proposes persisting the
concrete process graph: nodes, module descriptors, input/output links, schemas,
and generation metadata. That is the right base for durable action identity,
but it explicitly leaves scheduler bookkeeping as an open question.

Persistent scheduler observations should be layered on top of graph snapshots:
the graph snapshot says which actions exist; the scheduler observation says
what each action last read, what it can write, and at what memory sequence that
observation was valid.

## Problem Statement

The current restart path can rebuild a piece's structural graph, but it cannot
know the current dynamic dependency graph without running actions. This has
four costs:

1. Cold start cost: large pieces must run many computations just to rediscover
   dependencies.
2. Precision loss: after restart, the runtime cannot tell whether a dirty state
   affects a demanded output until dependency collection or action execution
   runs again.
3. No-op invisibility: an action that ran and changed only its dependency set,
   or wrote the same value, produces no persisted memory transaction.
4. Inactive-piece dirtiness: piece A can commit a write to data read by piece B
   while piece B is not running. Today piece B gets away with this because
   startup eagerly re-runs its nodes. If startup can skip work, the memory layer
   must remember that B's prior observations are now dirty or stale.

The hard part is correctness. Dynamic dependencies are state-dependent. A
persisted scheduler edge is valid only for the action implementation, inputs,
schema interpretation, branch, and memory state against which it was observed.
If any of those inputs changed, using the edge as authoritative can skip work
that should run.

## Proposed Model

Persist scheduler observations as internal, branch-local records associated
with memory transactions and commit sequence numbers. These records are not
user data and should not be returned by ordinary memory queries.

The model should be transaction-first, not an unrelated cache. In practice, most
runner transactions are scheduler-relevant, and action runs have a 1:1
correlation with the transaction they commit. The few transactions that are not
owned by a scheduler action still act like external effects: they commit actual
writes, and those writes initiate scheduler dirty propagation for any actions
that read the changed paths.

There are four record classes:

- `scheduler_action_snapshot`: latest durable observation for one action in one
  piece generation.
- `scheduler_observation`: ordered observation events, including no-op
  observations, tied to the memory sequence that was current when the
  observation became visible.
- `scheduler_read_index` and `scheduler_write_index`: server-side path indexes
  used to find inactive readers/writers across pieces.
- `scheduler_action_state`: durable clean/dirty/stale/unknown state per action.

The names are illustrative; the implementation may choose different table names.

### Action Identity

Observation records must be keyed by a stable action identity, not by function
object identity. A durable action key should include:

- space and branch
- piece/result cell id
- process generation
- stable node id from the process graph snapshot
- module/program implementation identity or hash
- action kind: computation, effect, or event handler
- output link or stream link, when applicable
- optional parent action id for dynamic child graphs

The current scheduler action id (`src`, function name, or generated anonymous
id) is useful for diagnostics, but it is not sufficient as the durable key.

#### Version 1 Action Identity

Until durable process graph snapshots are available, the implemented version-1
identity is intentionally conservative. Runner startup annotates actions with
the result cell's normalized space/scope/id, branch, and graph generation `0`.
This is stronger than a pattern/module-name fallback because colocated pieces of
the same pattern get distinct identities, but it is not a full graph generation.
JavaScript action ids and raw builtin action ids must also include stable
node-local binding information, such as a hash of the result cell plus their
bound input and output cells, because a single piece can contain many
actions from the same source location or many `raw:map` / `raw:when` instances
with the same implementation name. Future durable graph generations, stronger
implementation fingerprints, or schema/process migrations should invalidate or
migrate these rows instead of treating them as fully versioned graph
observations.

### Scheduler Observation Shape

Each successful dependency collection or action run should produce an
observation similar to:

```ts
// Shown at module scope.
interface SchedulerActionObservationV1 {
  version: 1;
  ownerSpace: string;
  branch: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  actionKind: "computation" | "effect" | "event-handler";
  implementationFingerprint: string;
  runtimeFingerprint: string;

  observedAtSeq: number;
  observedAtLocalSeq?: number;
  transactionKind: "dependency-collection" | "action-run" | "event-preflight";

  reads: SchedulerRead[];
  shallowReads: SchedulerRead[];
  actualChangedWrites: SchedulerAddress[];
  currentKnownWrites: SchedulerAddress[];
  declaredWrites: SchedulerAddress[];
  materializerWriteEnvelopes: SchedulerAddress[];
  ignoredSchedulingWrites?: SchedulerAddress[];

  actionOptions?: {
    debounceMs?: number;
    noDebounce?: boolean;
    throttleMs?: number;
  };

  status: "success" | "failed";
  errorFingerprint?: string;
}
```

`SchedulerRead` should retain the read path, scope, and the confirmed or
pending watermark used by the transaction. It should also preserve whether the
read was recursive or shallow. Cross-space reads require a per-space seq
watermark, because each space has an independent SQLite database.

`actualChangedWrites` is the transaction's changed write set. `currentKnownWrites`
is the scheduler's post-observation active scheduling write set after applying
the same rule used by resubscription: prefer the run's latest precise writes;
when the run has no effective writes, keep the previous current-known writes; and
fall back to declared writes only when the action has no prior current-known
view. It must not be a stale pre-run snapshot of the action's old writer index.
Persisting both is important: if a later run writes the same value,
`actualChangedWrites` can be empty while the action still owns a current output
path.

`attemptedWrites` should remain in the transaction/CFC record only. It should
not be copied into scheduler dependency fields.

### No-op Observations

No-op observations are required. They should be persisted when:

- dependency collection succeeds and records reads but no writes
- an action run succeeds and its effective native commit is empty
- an action run changes dependency paths but writes the same output value
- a materializer runs and proves that no materialized target changed

Aborted or inactive transactions are not no-op observations. If an action
intentionally aborts its transaction, or observation attachment discovers that
the target transaction is already complete, persistence should skip the
observation rather than converting the abort into a scheduler failure.

This does not mean every no-op must become a semantic revision. Scheduler
observations can be stored in an internal table with their own row id and an
`observedAtSeq` watermark. It is fine for memory to expose scheduler-specific
protocol calls to the runner; the important boundary is that ordinary data
queries and snapshots should not interpret observation rows as user data. If the
observation accompanies a real memory commit, it should be written atomically
with that commit. If it accompanies a no-op, it should still be durable and
ordered relative to the branch head it observed. Runners may batch multiple
no-op observations into one memory transaction, but the server must keep or drop
each action observation independently.

No-op observations participate in memory v2 session/local sequence replay. A
fresh no-op observation is kept, updates scheduler indexes, and clears the
action's dirty state when its reads are current. A stale no-op observation is
dropped as obsolete scheduler metadata, not rejected as a semantic conflict.
This handles the cross-device/current-data case: if another commit made the
runner's observation basis stale, the correct durable state is to retain the
existing dirty marker or unknown fallback rather than blocking the client.

Observation-only commits must use the action owner space, not whichever space
happens to appear first in the observation's reads or writes. Read-only and
same-value action runs can have no semantic write space; without an explicit
owner-space field they can otherwise persist their authoritative observation into
a cross-space read database and miss later owner-space rehydration.

## Storage Design Options

### Option A: Zero-operation semantic commits

Allow memory v2 `ClientCommit.operations` to be empty and store observation data
inside `commit.original`.

Pros:

- Reuses existing canonical sequencing.
- Gives observations a natural position in the commit log.
- Reuses existing session/local sequence replay rules.

Cons:

- Changes the memory v2 semantic contract that a transaction has at least one
  operation.
- Mixes scheduler-only records into the semantic commit stream, so every query
  and sync path would need to preserve the difference between user revisions and
  observation-only rows.
- Requires care to avoid triggering normal storage notifications for pure
  observations.

### Option B: Private scheduler tables

Add internal SQLite tables such as `scheduler_observation` and
`scheduler_action_snapshot`.

Pros:

- Keeps semantic memory commits unchanged.
- Lets observations use scheduler-specific indexes and retention policy.
- Keeps ordinary memory APIs focused on user data while still allowing explicit
  runner-facing scheduler APIs.

Cons:

- Needs a way to allocate an ordered observation watermark for no-op runs.
- Needs explicit transactional coupling when an action run also writes data.
- Must define how observations replicate, if scheduler rehydration should work
  across devices.

### Recommendation: Transaction-centric Hybrid State

Use internal scheduler tables, but drive them from the transaction pipeline. For
real action commits, write scheduler observation/index/state rows in the same
SQLite transaction as the memory commit. For no-op action runs, insert an
observation transaction row with:

- the current branch head sequence
- a monotonic observation id
- the transaction/session/local sequence, if available
- a read watermark for every observed space

The observation id orders no-op observations against each other. The branch head
sequence anchors them to the memory state they observed. No-op observations do
not create semantic revisions or normal storage notifications, but they do
update scheduler read/write indexes and action state.

The runner batches adjacent no-op observations into a single
`schedulerObservationBatch` commit. Each batch entry carries its own local
sequence, read watermarks, and observation payload. The batch has an envelope
local sequence for the transport request, but keep/drop/replay decisions are
made per entry. A semantic write flushes any queued no-op batch first so the
server observes the same action order as the runner.

This preserves the memory semantic log while making scheduler state durable and
server-visible. If cross-device scheduler rehydration becomes a requirement,
the same observation payload can later be replicated through an explicit
internal sync channel without changing the user data model.

### Table Sketch

The exact schema should follow memory v2's encoding helpers and migration style,
but the storage shape should look roughly like this:

```sql
CREATE TABLE scheduler_observation (
  observation_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  branch           TEXT    NOT NULL DEFAULT '',
  commit_seq       INTEGER,
  observed_at_seq  INTEGER NOT NULL,
  session_id       TEXT,
  local_seq        INTEGER,
  piece_id         TEXT    NOT NULL,
  action_id        TEXT    NOT NULL,
  process_generation INTEGER NOT NULL,
  payload          JSON    NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_scheduler_observation_action
  ON scheduler_observation (
    branch,
    piece_id,
    process_generation,
    action_id,
    observation_id
  );

CREATE TABLE scheduler_action_snapshot (
  branch           TEXT    NOT NULL DEFAULT '',
  piece_id         TEXT    NOT NULL,
  process_generation INTEGER NOT NULL,
  action_id        TEXT    NOT NULL,
  observation_id   INTEGER NOT NULL,
  payload          JSON    NOT NULL,

  PRIMARY KEY (branch, piece_id, process_generation, action_id),
  FOREIGN KEY (observation_id)
    REFERENCES scheduler_observation(observation_id)
);

CREATE TABLE scheduler_read_index (
  branch             TEXT    NOT NULL DEFAULT '',
  owner_space        TEXT,
  read_space         TEXT    NOT NULL,
  read_id            TEXT    NOT NULL,
  read_scope         TEXT    NOT NULL,
  read_path          JSON    NOT NULL,
  read_kind          TEXT    NOT NULL, -- 'recursive' | 'shallow'
  piece_id           TEXT    NOT NULL,
  process_generation INTEGER NOT NULL,
  action_id          TEXT    NOT NULL,
  observation_id     INTEGER NOT NULL
);

CREATE INDEX idx_scheduler_read_index_lookup
  ON scheduler_read_index (branch, read_space, read_id, read_scope);

CREATE TABLE scheduler_write_index (
  branch             TEXT    NOT NULL DEFAULT '',
  write_space        TEXT    NOT NULL,
  write_id           TEXT    NOT NULL,
  write_scope        TEXT    NOT NULL,
  write_path         JSON    NOT NULL,
  write_kind         TEXT    NOT NULL, -- 'current-known' | 'declared' | 'materializer'
  piece_id           TEXT    NOT NULL,
  process_generation INTEGER NOT NULL,
  action_id          TEXT    NOT NULL,
  observation_id     INTEGER NOT NULL
);

CREATE TABLE scheduler_action_state (
  branch             TEXT    NOT NULL DEFAULT '',
  piece_id           TEXT    NOT NULL,
  process_generation INTEGER NOT NULL,
  action_id          TEXT    NOT NULL,
  latest_observation_id INTEGER,
  direct_dirty_seq   INTEGER,
  stale_seq          INTEGER,
  unknown_reason     TEXT,

  PRIMARY KEY (branch, piece_id, process_generation, action_id)
);
```

`scheduler_observation` is the ordered history. `scheduler_action_snapshot` is
the latest usable observation per action. If the same action run produces real
memory operations, both the memory commit row/revision rows and scheduler
observation rows should be inserted under the same SQLite transaction and
linked through `commit_seq`. No-op observations leave `commit_seq` null and use
`observed_at_seq` plus `observation_id` for ordering.

The `scheduler_action_state` sketch compresses dirty/stale causes into summary
seq fields. A production implementation may need a separate dirty-cause or
stale-edge table so clearing one upstream dirty source does not accidentally
clear another.

For cross-space reads, either store one observation row in the action's primary
space with per-space read watermarks in `payload`, or store mirror rows in every
read space. The primary-space form is simpler, but it requires read validation
APIs that can open the other space databases during rehydration.

The current implementation uses mirror rows in read spaces. The owner space
keeps the authoritative observation; after the owner-space commit succeeds, the
server upserts a full scheduler observation snapshot into every read space and
into any previous read spaces that need stale index cleanup. These mirror rows
have `commit_seq = NULL` because the semantic commit belongs to another SQLite
database.

The owner space remains the source of truth for rehydration state. A write in a
read space can use mirrored rows to discover inactive readers, but it must push
the resulting direct-dirty marker back to each reader's owner space. The owner
space then propagates stale state through its own persisted scheduler graph. This
owner-space propagation may mark downstream actions stale, but it must not chase
cross-space mirrors recursively from stale state. Cross-space mirror lookup is
driven only by actual committed writes; possible writes from dirty/stale actions
wait until those actions run and commit real changed writes.

Version 1 accepts that owner-space commits and cross-space mirror writes are not
atomic across SQLite databases. If the owner commit succeeds and a later mirror
write fails, semantic data remains committed and the transaction may report a
failure after the fact. The known consequence is temporarily degraded
cross-space dirty propagation for inactive readers until a future run rewrites
or repairs the mirror rows. A later production hardening pass should add
explicit repair or `unknown` marking for mirror failures, but this spec does not
require distributed atomicity.

In-memory read-trigger indexes must also be cleaned up when actions unsubscribe
or a scheduler instance is disposed. Mirror rows are durable, but the runner's
live trigger maps should not retain empty per-entity buckets after a piece or
space unloads; a space unload can drop every trigger-index entity for that
space without touching durable mirror rows.

For inactive-piece dirtying, the write owner must be able to find readers even
when the reader's piece is not running. With one SQLite database per space, that
means either:

- mirror `scheduler_read_index` rows into every read space database, with a
  pointer back to the owning piece/action observation, or
- add a server-local scheduler metadata database that indexes reads and writes
  across spaces.

The mirror approach stays closest to the current memory architecture. The
server-local catalog is cleaner for cross-space queries, but it adds a new
storage root and replication story.

## Server-side Dirty Propagation

Persisted observations must support the same dirtying operation that the
in-memory scheduler performs today.

When any transaction commits actual changed writes, whether or not it belongs
to a scheduler action:

1. Normalize changed write paths using the same recursive/shallow overlap rules
   used by the scheduler and memory conflict validation.
2. Query `scheduler_read_index` for overlapping readers across pieces.
3. Mark those reader actions direct-dirty in `scheduler_action_state`.
4. Use persisted dependency edges, or derive edges from `scheduler_write_index`
   plus `scheduler_read_index`, to propagate stale state to downstream actions.
5. Do not execute actions on the server. Loaded runners may receive
   notifications; inactive pieces simply retain dirty/stale state until they
   start or are demanded.

When an action run commits:

1. Persist the memory commit/revisions if there are effective operations.
2. Apply dirty propagation for actual changed writes against the existing read
   index.
3. Persist the scheduler observation.
4. Replace that action's read index rows, write index rows, materializer rows,
   and latest action snapshot.
5. Clear the action's direct dirty bit if its new read watermarks are current.
6. Recompute stale propagation if the action's current-known writes changed.

Dirty propagation intentionally runs before the current action observation is
upserted. That lets an action's own successful observation clear any self-dirty
state caused by its changed writes while preserving dirty marks for other
inactive readers.

When an action run is a no-op:

1. Persist the scheduler observation without semantic revisions if its read
   watermarks are current.
2. Drop the observation without failing the transaction if a read watermark is
   stale or a pending read dependency is no longer valid.
3. Replace read/write/materializer index rows for kept observations.
4. Clear the action's direct dirty bit for kept observations.
5. Leave existing dirty/stale/unknown state in place for dropped observations.
6. Do not dirty downstream readers, because no actual changed writes occurred.

This server-side state changes the role of rehydration. Restart no longer has
to discover from scratch whether inactive writes made the piece dirty; it loads
the persisted dirty/stale/unknown action state and validates it against the
latest observations.

## Rehydration Algorithm

### Full Piece Rehydration

1. Load the process graph snapshot from the piece/result cell.
2. Validate the graph snapshot against the current runtime, program/module
   fingerprints, schemas, and process generation.
3. Recreate action objects and scheduler subscriptions from the graph snapshot,
   but do not run actions yet.
4. Load the latest valid scheduler action observation and durable action state
   for each action key.
5. For each valid observation:
   - restore `dependencies`
   - restore trigger paths from `reads` and `shallowReads`
   - restore current-known writes and writer indexes
   - restore materializer envelopes
   - rebuild dependency edges from restored reads and writes
6. For missing or invalid observations, mark the action `unknown`.
7. Load persisted direct-dirty/stale state. If the server-side dirty index is
   absent, outdated, or being backfilled, recompute by comparing observation
   read watermarks to committed writes after each observation:
   - no overlapping later write: action can be clean
   - overlapping later write: action is dirty
   - missing data, incompatible code, or ambiguous branch history: action is
     unknown
8. Propagate dirty state through restored dependency edges to verify or rebuild
   stale state.
9. Queue live effects, demanded computations, or idle materializers according
   to the normal pull-mode rules.

The current runner implementation uses these steps opportunistically during
subscription. `Scheduler.rehydrateActionFromObservation()` rebuilds in-memory
scheduler indexes from a validated observation, and
`Scheduler.rehydrateActionFromStorage()` loads one action's persisted snapshot
from the storage provider before applying that primitive. `Scheduler.subscribe`
can defer the normal first-run scheduling while the storage-backed lookup runs;
a clean snapshot restores indexes and skips first execution, while a missing or
invalid snapshot falls back to the normal initial dirty/pending path.

Rehydration must rebuild dependency edges from the restored active scheduling
write view, not only from the transaction's actual changed writes. A no-op action
observation can have `actualChangedWrites = []` while `currentKnownWrites`
contains the action's output. Restoring that writer must use the same dependency
update path as a live resubscribe so already-restored readers are backfilled as
dependents.

Storage-backed rehydration is asynchronous scheduler work. Scheduler `idle()`
and runtime disposal must wait for this work before storage sessions or memory
transports close. Browser/integration harnesses that own a page runtime should
dispose that runtime before closing the page, while preserving existing
suite-owned page lifetimes for tests that intentionally run ordered steps
against one page.

Runner startup passes this subscription option for pattern result, JavaScript,
and raw actions using the result cell's stable space/scope/id identity. The
version-1 graph generation is currently `0`. JavaScript actions add a stable
hash of their result-cell anchor and bound input/output cells to the diagnostic
action name before that name becomes the persisted scheduler action id. Raw
builtin actions similarly add a stable hash of their bound input/output cells to
the diagnostic raw action name. This prevents repeated source locations and
multiple raw instances in one piece from sharing one snapshot row. Any future
durable graph generation or stronger implementation fingerprinting
should invalidate or migrate these observations rather than treating them as
fully versioned graph snapshots.

`unknown` is stricter than dirty. Dirty means the scheduler has a valid previous
dependency view and knows what can make the action fresh again. Unknown means
the dependency view itself is missing or untrusted; the action must run
dependency collection or execute before dependents can rely on it.

`Scheduler.rehydrateActionFromObservation()` is the low-level primitive for
already-validated observations. Storage-backed rehydration is a trust boundary:
the memory protocol returns observation payloads as `unknown`, so the runner
must type-check the payload and verify action identity, implementation
fingerprint, runtime fingerprint, and scheduler mode before skipping execution.

### Demand-targeted Rehydration

When a specific output, effect, event preflight, or `cell.pull()` is demanded,
rehydration can start from that demand root:

1. Resolve the demand root to an action or read log.
2. Use restored writer indexes and materializer envelopes to find direct
   upstream actions.
3. Walk restored dependency edges backward.
4. Run only upstream actions that are dirty or unknown.
5. Stop once the demand root can observe fresh values.

This is the same logical traversal the pull scheduler performs today, but it can
start from persisted observations instead of first rebuilding every action's
dependencies by execution.

### Materializers

Materializer observations should persist both:

- the materializer's input dependencies
- the materializer write envelopes

This is the category introduced for actions with a large or dynamic write
surface. They cannot stay purely demand-pulled, because their broad envelope is
too imprecise to use as normal dependency evidence. They also should not dirty
all possible downstream readers when an input changes, because that recreates
the broad fanout that pull mode is trying to avoid.

Materializer identity is explicit scheduler metadata. For generated
`computed()` callbacks, the transformer emits
`materializerWriteInputPaths` only when capability analysis observes actual
writes through captured cell inputs; the runner resolves those input paths to
`materializerWriteEnvelopes` for the concrete action instance. A generated
action may read Writable cells without side-writing through them;
output-producing computations can also be materializers, and materializer
membership must not suppress normal dirty fanout through their declared or
current-known outputs. The current runtime fallback is limited to opaque-result
generated computations that do not carry write-path metadata, where the
computation has no normal output surface and its observable work is
side-writing through captured Writable inputs.

On restart:

- If a materializer's input reads are stale, mark the materializer dirty.
- If the same action has declared or current-known writes, rebuild those normal
  writer/dependent edges and propagate stale demand through them like any other
  computation.
- If no primary pull demand exists, run dirty materializers from the idle pull
  loop.
- If a demand root or event preflight reads a path inside a dirty materializer
  envelope, promote that materializer before the reader/handler.
- After the materializer runs, use its actual changed writes to dirty only
  readers of changed paths.

This preserves the current pull-mode materializer behavior while making the
materializer decision durable.

Persisted scheduler state should therefore distinguish three write surfaces for
these actions:

- `materializerWriteEnvelopes`: broad/dynamic target envelopes used to discover
  demand overlap and to know that this action must run when its inputs are
  dirty.
- `currentKnownWrites`: the last precise normal scheduling writes produced by
  the action after it ran. These remain in the ordinary writer index even when
  the action also has materializer envelopes.
- `actualChangedWrites`: the precise changed paths from the latest run, used to
  dirty downstream readers.

Server-side dirty propagation for materializers follows the same split:

1. A committed write that overlaps a materializer's input reads marks the
   materializer direct-dirty in `scheduler_action_state`.
2. The server still propagates stale state through any ordinary dependency edges
   from that action's declared or current-known writes.
3. The server does not fan out through the materializer envelope to all possible
   downstream readers.
4. Loaded runners schedule dirty materializers as eager idle work, honoring
   debounce/throttle settings.
5. If a demand root or event preflight reads inside a dirty materializer
   envelope before idle work runs, the runner promotes the materializer and runs
   it first.
6. Only after the materializer commits actual changed writes does durable dirty
   propagation mark precise downstream readers dirty.

## Correctness Invariants

- A persisted observation may be used only when its action identity and
  implementation fingerprint match the recreated action.
- Storage-backed observations may skip execution only when their runtime
  fingerprint, including scheduler mode, also matches the active scheduler.
- A clean action observation is valid only if no later committed write overlaps
  any of its recursive or shallow reads under the appropriate overlap rule.
- Missing or invalid observations must never be treated as clean.
- Scheduler writes must be over-approximated when uncertain. Extra work is
  acceptable; missed work is not.
- Observation persistence must be atomic with the memory commit whose writes it
  describes.
- Cross-space read-index mirrors are version-1 best-effort rows written after
  the owner-space commit; they are not distributed-transaction participants.
- No-op observations must record the branch head sequence and read watermarks
  they observed.
- Every committed actual write must be reflected into the durable scheduler
  dirty index before the transaction is considered fully integrated for
  rehydration.
- Non-action transactions must still drive dirty propagation from their actual
  changed writes.
- Cross-space reads must be validated against each space's own branch head and
  later writes.
- Cross-piece reads must be discoverable by the space that receives a write,
  even when the reading piece is not running.
- Branch identity must be part of every observation key. Rebase, merge, fork,
  or branch deletion should invalidate observations unless a branch-aware proof
  maps their read watermarks forward.
- `attemptedWrites` are not scheduler dependency evidence. They can be
  persisted for CFC/security, but rehydration must not use them to create
  writer or trigger edges.
- Event handlers can be re-registered from graph snapshots, but queued events
  are outside this proposal unless event queues become durable.

## Required Query Support

Server-side dirty propagation and rehydration need efficient overlap queries.
Memory v2 already validates confirmed reads using path-aware history. The
scheduler-facing API should expose similar internal primitives:

```ts
// Shown for illustration only.
findOverlappingWritesAfter({
  space,
  branch,
  id,
  scope,
  path,
  nonRecursive,
  afterSeq,
  beforeSeq,
})

findSchedulerReadersForWrite({
  space,
  branch,
  id,
  scope,
  path,
})
```

The implementation may over-approximate. For example, structural array edits can
invalidate a whole collection subtree. The API must not miss real overlaps.
Scheduler paths persisted in indexes and observation payloads should use the
memory boundary codec rather than ad hoc JSON, so future path component shapes
stay on the normal persistence path. The memory-side shallow-overlap helper may
be conservative, but it should have parity tests against the runner dependency
overlap logic so scheduler and memory dirtying do not drift.

The implemented snapshot lookup surface is:

- memory protocol request `scheduler.snapshot.list`
- engine API `Engine.listSchedulerActionSnapshots()`
- runner storage-provider method `listSchedulerActionSnapshots()`

The query filters by branch, piece id, process generation, and optionally action
id. Bulk listing is cursor-paginated in deterministic owner-space, piece,
generation, action order. The protocol result intentionally carries
`observation` as `unknown`; the runner owns validation and casting to
`SchedulerActionObservationV1`.

Subscription-time storage rehydration is bounded. If the snapshot request does
not resolve before the rehydration timeout, the scheduler drops that pending
snapshot attempt and schedules the action for the normal initial run path. A
late snapshot result must not overwrite newer in-memory dirty or clean state.

## Phased Plan

Current branch status:

| Area | Version 1 status |
| --- | --- |
| Feature flag | Implemented as `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE`, default off. |
| Observation construction and no-op persistence | Implemented, including batched no-op observation commits. |
| Memory scheduler tables and same-space dirty marking | Implemented. |
| Cross-space read-index mirrors | Implemented with accepted non-atomic mirror writes. |
| Snapshot query surface | Implemented. |
| Runner rehydration primitive and storage-backed lookup | Implemented. |
| Subscription-time clean startup skip | Implemented for recreated actions with valid snapshots. |
| Durable process graph generations | Future work; version 1 uses result cell identity plus graph generation `0`. |
| Demand-targeted dirty recovery beyond subscription startup | Future work. |
| Replication, retention, and mirror repair | Future work. |

The version 1 implementation is gated by the project's common
experimental-option plumbing. With
`EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=false` or unset, the runner does not
attach scheduler observations to transactions, memory clients do not request
scheduler snapshots, and the memory server does not write scheduler observation
rows, dirty rows, or cross-space mirrors. Snapshot-list requests intentionally
return an empty result while the flag is off, even if a previous flagged run
left scheduler rows in the SQLite database. Unlike `modernCellRep`, this flag
is not a required memory protocol compatibility flag: mismatched peers may still
connect, and the server-side flag determines whether scheduler observation rows
are accepted and served.

### Phase 1: Observe Without Rehydrating

- Define durable action ids from process graph snapshots.
- Emit scheduler observation objects after dependency collection and action
  runs.
- Add internal storage APIs to persist observation rows, including no-op rows.
- Add diagnostics to compare in-memory scheduler state against persisted
  observations.
- Do not change restart behavior yet.

### Phase 2: Persist Server-side Indexes

- Store scheduler read index, write index, materializer index, and latest action
  snapshot rows transactionally with action observations.
- Mirror or catalog cross-space read index rows so a write can find inactive
  readers.
- Keep restart behavior conservative while comparing persisted indexes against
  rebuilt in-memory scheduler state.

### Phase 3: Durable Dirty Propagation

- On every committed actual write, mark overlapping persisted readers direct
  dirty.
- Propagate stale state through persisted dependency edges or derived
  read/write overlap.
- Include non-action transactions as dirty propagation sources.
- Add diagnostics for dirty-state drift between server tables and live
  scheduler state.

### Phase 4: Restore Indexes Conservatively

- On restart, load graph snapshots, matching scheduler observations, and
  durable dirty/stale state.
- Rebuild trigger indexes, current-known writer indexes, materializer indexes,
  and dependency edges in the runner.
- Mark actions with valid observations as clean or dirty by comparing read
  watermarks against durable action state, with later-write overlap scans as a
  repair path.
- Mark actions without valid observations as unknown.
- Still allow normal execution to repair unknown state.

### Phase 5: Skip Clean Startup Work

- Avoid initial execution for actions whose observations are valid and clean.
- Ensure live effects can subscribe without firing stale callbacks.
- Preserve current behavior for actions with missing observations, invalid
  fingerprints, or dirty reads.
- Implemented version 1: subscriptions can defer the initial run for a
  storage-backed snapshot lookup and fall back to the normal first run on miss.

### Phase 6: Demand-targeted Dirty Recovery

- Add a rehydration entrypoint for a demanded output, effect, event preflight,
  or explicit `pull()`.
- Walk persisted dependency edges backward from the demand root.
- Execute only unknown or stale upstream actions needed by that demand.

### Phase 7: Replication And Retention

- Decide whether scheduler observations replicate across devices or remain
  local cache state.
- Add garbage collection keyed by piece generation, branch lifecycle, and
  superseded action snapshots.
- Add metrics for cold start skipped actions, unknown-action fallback, and
  observation invalidation reasons.

## Test Strategy

- Unit-test observation construction from `TransactionReactivityLog`, including
  recursive reads, shallow reads, changed writes, declared writes,
  current-known writes, materializer envelopes, and ignored scheduling writes.
- Verify `attemptedWrites` persists only in transaction/CFC records and is not
  present in scheduler observations.
- Add memory v2 tests for internal no-op observation rows: no semantic
  revisions, no normal storage notifications, but durable observation data.
- Add restart tests where a piece rehydrates without rerunning clean
  computations.
- Add restart tests where an unrelated write after the observation does not
  dirty the action.
- Add restart tests where an overlapping write after the observation dirties
  exactly the affected chain.
- Add two-piece tests where piece A writes data read by inactive piece B, then B
  starts dirty without eagerly re-running every node.
- Add non-action transaction tests where a direct edit or handler-originated
  write dirties persisted scheduler readers.
- Add cross-space tests for a write in one space dirtying a piece whose action
  observation is owned by another space.
- Add dynamic dependency tests where a condition changes branches and invalidates
  the prior dependency set correctly.
- Add no-op action tests where dependencies change but output remains equal.
- Add materializer tests for idle execution, demand promotion, and changed-write
  precision after restart.
- Add invalidation tests for implementation fingerprint, schema fingerprint,
  process generation, branch mismatch, and missing observation rows.
- Add cross-space read tests where only one observed space changes.
- Add benchmarks for large clean cold start, targeted dirty rehydration, and
  broad materializer fanout after restart.

Validation evidence for the current branch:

- targeted runner and memory scheduler-state tests
- `HEADLESS=1 deno task test`
- `HEADLESS=1 deno task integration`
- `deno task check`

The current persistent-state benchmark measures in-memory scheduler-index
rehydration only. It does not include process graph loading, storage query
latency, cross-space mirror repair, or full pattern startup.

## Open Questions

- Are scheduler observations local cache state, server-replicated runtime state,
  or something in between? Inactive-piece dirtying requires server-side state
  at least for the server that accepts the write.
- What is the precise durable action id for dynamically-created child actions?
- Should dependency edges be stored directly, or always derived from persisted
  read/write indexes?
- Should cross-space read index rows be mirrored into every read space database,
  or should memory maintain a separate scheduler catalog database?
- Should effects run once after restart even when their dependency observations
  are clean, or should restored subscriptions be considered enough?
- How should observation tables be encrypted or filtered, given that persisted
  read paths may reveal structure even when values are protected by CFC labels?
- What is the retention policy for observations from old process generations
  and inactive branches?
- Can the process graph snapshot and scheduler observation be committed in a
  single setup transaction, or do they need independent lifecycles?
- How should pending optimistic commits be represented if a process restarts
  before confirmation?
