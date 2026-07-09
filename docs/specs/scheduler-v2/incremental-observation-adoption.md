# Incremental observation adoption (subscription-carried scheduler state)

Status: Design. Successor to `per-doc-rehydration.md` (reload is the
degenerate case of this mechanism). Flag-on only (persistentSchedulerState).
Goal: with the flag on, multi-user flows get FASTER than main — clients use
scheduler information to skip work in ongoing operation, not just on reload.

## 1. The idea

Every action run already attaches its observation to the run's commit, and
the server already persists it per (ownerSpace, pieceId, generation,
actionId). Today that state flows down only via the boot-time listing.
This design sends it down **incrementally with memory subscriptions**: when
client A's action run commits, the subscribers receiving that commit's doc
writes also receive the observation. A receiving client that has the same
logical action registered can **adopt** it — install the observation's read
surface and mark the action clean at the observed seq — instead of
re-running the computation.

The receivers' re-runs are pure waste today: the action is deterministic
over its read set, the reads are shared docs, and the writer's outputs are
already committed — a receiver's run recomputes byte-identical values. In a
chat with M clients, each message's derivation cascade runs M times; with
adoption it runs once (the writer), and the other M−1 clients do index
bookkeeping. This is the recovery lever for the multi-user perf delta: the
"+X% actions" cost is dominated by exactly these redundant re-derivations.

Local **effects** are excluded and still run: rendering is a per-client side
effect, not shared state. But an adopted computation whose output did not
change never dirties the effect in the first place (I3), so effect runs also
drop to the true minimum.

## 2. Adoption equivalence (correctness model)

Adopting observation O for local registered action X must be
indistinguishable from having run X at `O.observedAtSeq` (I7 extended to
live operation). X's outputs are already in the store; determinism over the
read set does the rest. Adoption is allowed only when ALL hold:

- **C1 — identity.** X matches O by actionId + implementationFingerprint +
  runtimeFingerprint (the same `observationMatchesCurrentAction` checks the
  reload path uses). Action ids fold the piece-scoped doc links, so ids are
  stable across runtimes for shared derivations — proven empirically by the
  reload work (byte-identical instance keys across two managers). Crucially
  this also makes adoption *self-limiting*: derivations over
  reader-isolated or per-user docs have per-user doc ids in their instance
  keys, so different users' actions never match — no false adoption of
  state that is not actually shared.
- **C2 — seq currency.** For every doc in `O.reads ∪ O.shallowReads`, the
  local replica's newest committed seq for that doc is ≤ `O.observedAtSeq`.
  A newer local write means X is genuinely stale relative to state the
  writer did not observe → run normally. (Conservative per-doc check; the
  safe failure direction is refusing adoption.)
- **C3 — no local divergence.** No locally-pending (uncommitted/optimistic)
  write overlaps `O.reads`: the local view differs from the writer's basis,
  so the local run is meaningful. Refuse adoption.
- **C4 — computations only.** Effects and event handlers never adopt.
  (Handlers only run at the origin already; effects are per-client.)
- **C5 — mid-run races converge.** The scheduler has no per-action running
  flag, and none is needed: an adoption racing a mid-flight local run is
  harmless — the run's completion resubscribes from its own log and re-sets
  clean, an equivalent view (deterministic action over the same committed
  reads), and its unchanged output is quiet per I5.

What adoption does — the reload primitive, applied live
(`rehydrateActionFromObservation`): restore the write surface, resubscribe
the observation's reads as triggers (the read set may have changed —
adoption keeps the indexes truthful), install gate options, set status
clean at `O.observedAtSeq`, remove the action from the pending work set and
cancel its scheduled run. Later writes (local or remote) dirty it through
the normal machinery.

## 3. Ordering

Observations apply **after** their commit's writes land in the replica and
**before** the scheduler dispatches the resulting invalid work. Per push
batch: apply writes → mark dirty readers → adopt matching observations
(clearing exactly the dirt those writes caused) → the next scheduling pass
sees only the genuinely-local remainder.

Races are benign in both directions. If a receiver starts running X before
the observation arrives, its unchanged output causes no scheduling activity
(I5) and the late adoption is dropped (C5). If observations arrive across
multiple pushes (the writer's cascade = one commit per action run), the
receiver adopts a prefix and runs the not-yet-covered suffix; both converge
to the same values, so the overlap is wasted CPU at worst, never
incorrectness.

## 4. Transport (concretized against the traced push chain)

The subscription push is a **batched doc diff**, not a commit stream: the
server accumulates dirty doc ids per space (`markSpaceDirty` on accepted
commits), flushes on a short timer, re-evaluates each session's watch set,
and pushes `SessionEffectMessage{effect: SessionSync}` where `SessionSync =
{fromSeq, toSeq, upserts: [{id, scope, seq, doc}], removes}` — per-doc
snapshots with per-doc seqs, no operations, no per-commit boundaries.
Observations currently exist only on the inbound path (extracted from
commits in `applyCommit` and persisted); observation-only commits carry no
operations, mark nothing dirty, and are invisible to the fan-out.

- **Server:** retain the client's `persistentSchedulerState` handshake flag
  per connection (mirroring the existing `#syncSchemaTable` negotiation —
  the precedent that push payloads may be flag-conditioned per connection).
  When building a session's `SessionSync` with non-empty upserts and both
  the connection flag and the global flag are on, query the snapshot store
  for observation rows with `commit_seq` in the sync's `(fromSeq, toSeq]`
  window (the store already denormalizes `commit_seq` and `observed_at_seq`
  per row; the existing listing query gains a commit-seq window filter) and
  attach them as a new optional `SessionSync.observations` field, decoded
  the same way a boot-listing row is. Echo: the fan-out already skips the
  writer's own doc revisions via `DirtyOrigin{sessionId, seq}`; skip
  observation rows the same way (rows whose `commit_seq` matches an origin
  seq from the receiving session). Sourcing from the store makes the push
  idempotent and batching-agnostic: a re-pushed or coalesced window carries
  the same rows.
- **Client:** zero memory-client changes — the field rides `SessionSync`
  through `WatchView.applySync`'s emit. The runner's `applySessionSync`
  (storage/v2.ts) applies the upserts, fires the existing `integrate`
  notification (synchronous scheduler invalidation), then fires a new
  `scheduler-observations` storage notification carrying the rows; the
  scheduler facade handles it by calling `adoptRemoteObservations` — still
  inside the synchronous turn, before the deferred `execute()` dispatch.
  This is exactly the §3 window: writes applied → readers marked dirty →
  adoption clears the dirt the writer already resolved → dispatch sees the
  remainder.
- **Oracles:** per-doc seq currency reads the replica's
  `record.confirmed.seq` (already maintained per doc on integrate); the
  pending-local-write check reads the provider's pending-commit set (the
  same source `idleWithPendingCommits` uses). Both surface as small
  optional provider methods.
- **Adoptable rows only:** live adoption applies only `status: "success"`
  rows without durable dirty/stale markers — a dirty or failed row must
  not wake or re-run work on receivers; those semantics belong to the
  reload path, which owns marker handling.
- **No-op runs:** an observation-only or no-op commit triggers no push
  itself (nothing became dirty), but because the attach step sources rows
  from the store by seq window, such observations ride the NEXT push whose
  window covers their commit seq. A cascade's later stages can therefore
  lag one window behind their data — the receiver may redundantly run a
  cheap laggard (measured: the map coordinator's reconcile) before its
  observation arrives; the per-element ops adopt in-window (§3's benign
  race, value-identical no-op).
- Scoping: observations ride only sync pushes the session receives anyway,
  in spaces it is authorized to read. The boot listing already exposes the
  whole space's snapshot rows to any session that can list, so this adds
  no new disclosure class; the addresses inside `reads` are opaque doc
  ids. Flag for the standing CFC review pass regardless (existence-channel
  precedent). Observations remain scheduling metadata — never
  authorization or label evidence.

## 5. What this buys, concretely

- **Multi-user chat (the benchmark):** the receiver-side cascade
  (whole-state derivations re-running per incoming message) becomes
  adoption bookkeeping. The actions metric drops by ~(M−1)/M of the
  cascade's computation runs; the associated transactions, IPC, and
  conflict-retry churn go with it. Acceptance: flag-ON multi-user beats
  main on the group-chat A/B.

  Measured (group-chat-adoption-bench, 10 messages, alice→{bob, tab2},
  scheduler run-start deltas): main(v1) sender 401 / receivers 400 /
  total 801; branch flag-OFF 201 / 400 / 601 (v2 already halves the
  sender cascade); branch flag-ON 201 / **332** / **533** with 68
  adoptions — receivers −17%, total −33% vs main. The residual receiver
  runs are effects plus §4's window-lag laggards; aligning the
  observation-batch flush with its cascade's push window is the next
  lever.
- **External-I/O builtins:** a receiver adopting the writer's fetch/LLM
  computation state never re-issues the request (today this is guarded
  case-by-case, e.g. the fetch mutex).
- **Reload residual:** the same delivery lets a resume-time always-run
  coordinator pre-warm its persisted read set before its reconcile, which
  is what takes the flag-on reload churn gate from ≤1 to 0
  (per-doc-rehydration.md §7).

## 6. Implementation slices

1. **S1 — server push:** include commit observations in subscription
   notifications to flag-on, non-writer sessions.
2. **S2 — client + scheduler adoption:** plumb received observations
   through the storage provider to a scheduler `adoptRemoteObservations`
   entry applying §2/§3 (reusing the reload validation + rehydrate
   primitive and the per-doc replica seqs for C2).
3. **S3 — live-skip test:** loopback two-manager harness, both runtimes
   LIVE on the same piece; drive a write through runtime A; assert
   runtime B's derived values update with ZERO computation runs in B's
   action-run trace (and that a B-local write still runs B's actions —
   adoption must not deaden local reactivity).
4. **S4 — group-chat A/B:** flag-ON vs main on the multi-user benchmark;
   the actions/wall deltas are the acceptance.

## 7. Non-goals / deferred

- Reliable doc→deriver attribution (P2): adoption never needs to find the
  deriver — the observation arrives WITH the doc write.
- Demand-targeted partial rehydration, snapshot GC, cross-space child
  restore: unchanged from per-doc-rehydration.md.
- Server-side filtering of observations per subscription selector
  (start with per-commit fan-out to flag-on sessions; refine if payload
  volume warrants).
