# Incremental observation adoption (subscription-carried scheduler state)

Status: Implemented. Successor to `per-doc-rehydration.md` (reload is the
degenerate case of this mechanism). Flag-on only (`persistentSchedulerState`).
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

- **C1 — identity.** X matches O by implementation/runtime fingerprints and
  the complete durable identity tuple `(ownerSpace, branch, pieceId,
  processGeneration, actionId)` (the same `observationMatchesCurrentAction`
  checks the reload path uses). Action ids fold the piece-scoped doc links, so ids are
  stable across runtimes for shared derivations — proven empirically by the
  reload work (byte-identical instance keys across two managers). Id
  folding self-limits adoption only for derivations whose isolation is in
  the doc *id* (per-user result docs of per-user pieces). It does NOT
  self-limit scope-addressed isolation — see C6.
- **C2 — seq and output currency.** For every doc in `O.reads ∪
  O.shallowReads ∪ O.actualChangedWrites ∪ O.currentKnownWrites`, the
  local replica holds a confirmed record for that doc and its newest
  committed seq is ≤ `O.observedAtSeq`. A newer local write means X is
  genuinely stale relative to state the writer did not observe → run
  normally. A doc with NO local record (or no confirmed base) is worse
  than unverifiable: adoption would skip the very run that loads/subscribes
  an input or receives an output, so the receiver could be permanently stale
  while marked clean. Refuse; the local run establishes the missing
  subscription/output.
  (Conservative per-doc check; the safe failure direction is refusing
  adoption.)
- **C3 — no local divergence.** No locally-pending (uncommitted/optimistic)
  write overlaps the C2 validation surface: the local view differs from the
  writer's basis or output, so the local run is meaningful. Refuse adoption.
- **C4 — computations only.** Effects and event handlers never adopt.
  (Handlers only run at the origin already; effects are per-client.)
- **C5 — mid-run races converge.** The scheduler has no per-action running
  flag, and none is needed: an adoption racing a mid-flight local run is
  harmless — the run's completion resubscribes from its own log and re-sets
  clean, an equivalent view (deterministic action over the same committed
  reads), and its unchanged output is quiet per I5.
- **C6 — same reader only (server-enforced).** A `scope:"user"` address
  names DIFFERENT data per principal and `scope:"session"` per session,
  with the SAME doc id — so C1's id match holds while the determinism
  premise ("same committed reads") is false across readers. Falsified
  empirically: lunch-poll's deposed-host assertion — the receiver adopted
  the other user's `isAdmin`-family run, which cleared exactly the dirt the
  writer's own `adminName` commit had just caused, so the receiver's
  per-user derivation never recomputed. The server therefore gates rows by
  the writer's commit session key (persisted per observation row): rows
  touching session-scope addresses ship to no other session; rows touching
  user-scope addresses ship only to sessions of the writer's principal
  (the second-tab case that makes same-user adoption valuable), failing
  closed when the writer is unknown. The gate applies to BOTH deliveries —
  the live attach fan-out and the boot snapshot listing. The reload flavor
  matters because the store keeps one row per actionId and each new
  observation clears the shared dirty markers: whichever principal ran
  last would otherwise hand its clean row to every other principal's
  reload, marking their (possibly stale) per-user rows clean. The receiver
  cannot check this itself — observations do not carry the writer's
  principal on the wire — which is acceptable on the same trust basis as
  the doc diff: the server already scopes every pushed byte per reader.
- **C7 — no child-starting coordinators (`resumeMode: "always-run"`).** A
  `map`/`filter`/`flatMap` coordinator's run is not a pure recomputation:
  its reconcile is what (re)registers the per-element child actions. Its
  outputs being in the store does NOT make adoption equivalent to running
  it — adopting it clean skips the reconcile, so a remotely-appended row's
  child action is never registered and that row's per-element reactivity is
  dead. These actions register with `resumeMode: "always-run"` and are the
  same ones `register()` refuses to rehydrate clean on reload
  ([[per-doc-rehydration]] §3.3); live adoption refuses them symmetrically
  (`Scheduler.alwaysRunActions`). This is a scheduler-side exclusion, not a
  server gate: the coordinator's observation still ships and persists (it is
  a legitimate `computation`), the receiver just always runs its own
  reconcile. Only the three collection builtins produce `always-run`; a
  future adoption entry point must consult the same set.

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
Observations are extracted from commits in `applyCommit`, persisted, and
attached to flag-on subscription sync windows. Observation-only commits carry
no operations and mark no docs dirty, so they trigger no push themselves; their
rows ride the next advancing sync window that covers the reserved delivery
sequence, including an otherwise-empty catch-up.

- **Server:** retain the client's `persistentSchedulerState` handshake flag
  per connection (mirroring the existing `#syncSchemaTable` negotiation —
  the precedent that push payloads may be flag-conditioned per connection).
  When building any advancing `SessionSync` and both the connection flag and
  the global flag are on, query the snapshot store for observation rows whose
  delivery sequence is in the sync's `(fromSeq, toSeq]` window and attach them
  as an optional `SessionSync.observations` field, decoded the same way a boot
  listing row is. This includes otherwise-empty catch-up syncs: observation-
  only commits have no document diff to carry them. Echo suppression compares
  each row's persisted writer session key with the receiving session key; it
  does not infer authorship from a commit-sequence collision. Sourcing from the
  store makes the push idempotent and batching-agnostic: a re-pushed or
  coalesced window carries the same rows.

  The window is then filtered to what THIS session may adopt, exactly as
  the doc diff is scoped (`v2-adoption-attach-test.ts` pins all three):

  - **Watch-scoped:** a row ships only when every address in `reads`,
    `shallowReads`, `actualChangedWrites`, and `currentKnownWrites` is inside
    the session's tracked doc set. A receiver never gets pushes for untracked
    inputs or outputs, so it could never verify such a row current (C2) — and
    pre-filter, the row poisoned the receiver into the C2 deadlock (the flag-ON
    multiUserTest stall).
  - **Reader-scoped (C6):** rows touching session-scope addresses are
    dropped; rows touching user-scope addresses ship only when the row's
    persisted writer session key carries the receiving session's
    principal. `scheduler_observation.session_id` now stores the writer's
    commit session key for this purpose.
  - Dropped rows degrade to the receiver running the action itself —
    adoption stays an optimization, never a correctness dependency.
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
  from the store by sequence window, such observations ride the next advancing
  sync — document-bearing or an otherwise-empty catch-up — whose window covers
  their reserved delivery sequence. A cascade's later stages can therefore
  lag one window behind their data — the receiver may redundantly run a
  cheap laggard (measured: the map coordinator's reconcile) before its
  observation arrives; the per-element ops adopt in-window (§3's benign
  race, value-identical no-op).
- Scoping: observations ride only sync pushes the session receives anyway,
  in spaces it is authorized to read, and (per the attach filters above)
  only rows whose read set lies inside the session's own watch — pushed
  observation metadata now stays inside the same boundary that scopes the
  doc diff itself. The boot listing remains space-wide (the reload path's
  mark-clean legitimacy comes from the receiver's own persisted doc
  values, not cross-reader determinism), so its exposure class is
  unchanged; the addresses inside `reads` are opaque doc ids. Flag for
  the standing CFC review pass regardless (existence-channel precedent).
  Observations remain scheduling metadata — never authorization or label
  evidence.

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

## 6. Implemented slices

1. **S1 — server push (complete):** include commit observations in subscription
   notifications to flag-on, non-writer sessions.
2. **S2 — client + scheduler adoption (complete):** plumb received observations
   through the storage provider to a scheduler `adoptRemoteObservations`
   entry applying §2/§3 (reusing the reload validation + rehydrate
   primitive and the per-doc replica seqs for C2).
3. **S3 — live-skip test (complete):** loopback two-manager harness, both runtimes
   LIVE on the same piece; drive a write through runtime A; assert
   runtime B's derived values update with ZERO computation runs in B's
   action-run trace (and that a B-local write still runs B's actions —
   adoption must not deaden local reactivity).
4. **S4 — group-chat A/B (complete):** flag-ON vs main on the multi-user benchmark;
   the actions/wall deltas are the acceptance.

## 7. Non-goals / deferred

- Reliable doc→deriver attribution (P2): adoption never needs to find the
  deriver — the observation arrives WITH the doc write.
- Demand-targeted partial rehydration, snapshot GC, cross-space child
  restore: unchanged from per-doc-rehydration.md.
- Additional payload-volume optimization beyond the implemented watch-set and
  reader-scope filters.
