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

## 4. Transport

- The client already attaches `schedulerObservation` /
  `schedulerObservationBatch` to `transact` commits; the server extracts
  and persists them during `applyCommit`. The change: when the server
  pushes a commit's doc updates to a subscribed session, it includes the
  commit's observations — **only** for sessions whose protocol handshake
  carries `persistentSchedulerState` (the flags surface already exists:
  `getMemoryProtocolFlags()`), and **not** to the writer's own session
  (echo suppression; the writer has live state).
- Payload: the same slim encoded observation the store keeps (volatile
  fields normalized out), plus the accepted commit seq as `observedAtSeq` —
  identical shape to a boot-listing row, so the client-side validation and
  apply paths are shared with reload.
- The client surfaces received observations alongside the doc updates it
  hands the runtime's storage subscription; the scheduler consumes them at
  the §3 point.
- Scoping: observations ride only commits the session receives anyway, in
  spaces it is authorized to read. The boot listing already exposes the
  whole space's snapshot rows to any session that can list, so this adds no
  new disclosure class; the addresses inside `reads` are opaque doc ids.
  Flag for the standing CFC review pass regardless (existence-channel
  precedent). Observations remain scheduling metadata — never authorization
  or label evidence.

## 5. What this buys, concretely

- **Multi-user chat (the benchmark):** the receiver-side cascade
  (whole-state derivations re-running per incoming message) becomes
  adoption bookkeeping. The actions metric drops by ~(M−1)/M of the
  cascade's computation runs; the associated transactions, IPC, and
  conflict-retry churn go with it. Acceptance: flag-ON multi-user beats
  main on the group-chat A/B.
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
