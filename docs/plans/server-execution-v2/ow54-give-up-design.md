# OW54 — terminal cover for a served event that cannot run

**Status: DRAFT FOR OWNER RATIFICATION — design only.** No sentence in this
document changes the server-execution contract, and no implementation may land
from it until the owner rules on every question in §10. Written against
`origin/main` at `d0d0eb79c` on 2026-08-26.

## 1. Problem and boundary

A served event is durable before its authoritative handler runs. That gives the
system only two honest ways out when dispatch or commit preparation cannot
finish:

1. keep the entry pending until the handler can run; or
2. seal a durable terminal outcome that names the failure, let the client see
   it, and preserve a deliberate recovery action.

Silently advancing the stream without either one loses a user's action.

PR #6365 fixed one such loss. A pre-dispatch replica load failure had been
routed to events.md §5's terminal `dropped` arm even though the handler was
runnable and the required document existed durably. The drain sealed
`{ status: "dropped", consequenced: true }`, advanced the watermark, and never
ran the handler. The live failure was a serving session revoked by the genesis
ACL and designed to heal on remount. The fix now defers the served event and
every later-arrived same-space event behind it.

The loss is gone, but the fallback is deliberately unbounded. A load that never
heals:

- keeps the space's lease and prevents idle park;
- holds the whole same-space served stream behind the head;
- retries at the 250 ms backstop, about four real load attempts per second;
- emits one warning for the head and one for every barrier victim on every
  pass, about 44 warning lines per second for a ten-event backlog; and
- occupies the head-serial scheduler for one load-failure latency on every
  pass, so a slow timeout-class failure stalls unrelated co-scheduled dispatch
  repeatedly.

The accepted foundation remains: **wedge loudly rather than lose silently**.
This design proposes the terminal, visible, recoverable cover that eventually
ends that wedge. It also folds in OW54's original commit-preparation failure
class. The original no-cover defect is closed on current main: a served CFC
pre-storage refusal now seals an error consequence. The unresolved subcase is
that the message-prefix discriminator includes a commit-preparation crash, so a
possibly transient crash is terminalized immediately as an error. §7 separates
that crash from a deterministic policy verdict and routes it through the same
bounded delivery-failure contract.

This document does **not** absorb the wake-shaper barrier bypass recorded by
the #6365 review (F1), nor the follow-up to exempt drain re-dispatches from
shaping. Those remain separate work.

## 2. Invariants the options must preserve

Every acceptable option must preserve all of these:

1. **No silent discharge.** A durable event either commits its authoritative
   handler consequence or commits a terminal notice visible to the client.
2. **T3 remains narrow.** `dropped` means “no runnable handler”, never “the
   delivery machinery stayed unhealthy”.
3. **Terminal before release.** A later event's durable outcome cannot overtake
   an earlier event whose terminal notice failed to seal.
4. **One event ID, one terminal outcome.** Reopening a terminal event ID is not
   a retry mechanism.
5. **Barrier victims do not inherit the head's failure.** A later event held
   only for arrival order has not itself failed dispatch and cannot spend a
   give-up budget.
6. **No string-based policy.** Failure class is typed at the producer; error
   text is diagnostic, not a control channel.
7. **No new operation timeout.** The budget changes disposition after an
   observed failure. It does not cancel a still-running load or turn a slow but
   eventually successful operation into a failure.
8. **Settlement is not failure.** Dirty-input recomputation, continuation
   waves, and pending foreign replica loads spend no delivery-failure budget.
9. **OFF is unchanged.** The design applies only to durable served entries.
   Client-only events have no durable entry for the server to re-drain or seal.

## 3. Option matrix

| Question | Options | Recommendation, pending owner ruling |
| --- | --- | --- |
| Give-up predicate | attempt count; elapsed age; class-specific count/age; explicit health signal; hybrid class + cumulative failed-state time + health wake | **Hybrid.** Persist cumulative time in confirmed failure episodes, classify the failure, pause while typed recovery or ordinary dependency settlement progresses, and terminalize at a failed-state budget. Counts are observability only. |
| Cross-space settlement | latest committed foreign value; explicit target-side demand and coverage | **Explicit freshness obligation when freshness is part of handler correctness.** Spaces still settle independently; waiting or continuation is not a delivery failure. This is an adjacent currentness design, not an OW54 timeout. |
| Terminal disposition | reuse `dropped`; reuse `error`; use only an entry-local `needs-attention` notice; pair the entry notice with a per-space unresolved-attention index | **New entry-local `needs-attention` terminal kind plus a derived per-space index.** The entry is authoritative; the index makes unresolved notices discoverable after a fresh client process. |
| Ordering release | never step over; release only the affected stream; release the space after the notice commits | **Release the space after durable cover.** The notice occupies the failed event's arrival position; later outcomes may commit in the same or a later wave, never without it. |
| Re-arm | automatically reopen the same entry on ACL/session change; explicit retry with a new event ID; terminal means no retry | **Explicit retry with a new event ID and `retryOf`.** The original stays terminal; current client authority is revalidated and exactly-once remains per event ID. |
| Commit-preparation crash | keep immediate error; leave unconsequenced; classify and budget with load failure | **Classify and budget.** Deterministic CFC policy refusals remain immediate errors; an actual preparation crash gets the same bounded `needs-attention` destination as dispatch failure. |
| Observability | per-attempt warnings only; counters only; transition logs + counters + client outcome | **All three surfaces, transition-oriented.** Keep work counters, add precise terminal/seal counters, rate-limit repeat logs, and add a structured client outcome. |

The following sections expand each row and mark the semantic choices the owner
must ratify.

## 4. Give-up predicate

### 4.1 Options

#### A. Attempt count

Terminalize after a fixed number of failed dispatches.

- Small and close to `EVENT_DEFERRAL_DROP_THRESHOLD`.
- Measures scheduler cadence, not user-visible time.
- A faster backend gives up sooner in wall time than a slower backend.
- Consecutive counts are gameable by a flapping session. #6365 already makes
  the cold-view guarantee “eight consecutive deferrals uninterrupted by a
  load-park failure”; a revoke/remount cycle can reset it forever.

**Recommendation: reject as the terminal predicate.** Keep counts for
diagnostics and tests.

#### B. Wall-clock age only

Persist the first observed failure time and terminalize when its age crosses a
single ceiling.

- Stable across retry cadence, remounts, and process restart.
- Directly bounds how long the user's action blocks the stream.
- Treats a known self-healing revocation and an unknown slow backend failure
  alike.
- Charges ordinary recovery work after the failed boundary has healed. A
  handler may legitimately need several scheduler passes, a flush-deadline cut,
  or a foreign-space input before its read closure is current.
- Requires an owner-approved duration and a policy for server clock skew.

**Recommendation: reject elapsed age from the first failure.** Use persisted
wall-clock intervals to measure only time spent in a confirmed failed state.

#### C. Failure-class-specific budgets

Assign each class its own count or duration.

- Can immediately terminalize a permanent authorization or protocol verdict
  while giving a session remount time to heal.
- Numeric per-class tuning creates policy surface before enough production
  data exists.
- Class changes can reset a poorly specified budget and recreate the flapping
  hole.

**Recommendation: use class only to choose recovery behavior and immediate
terminal classes. Use one cumulative failed-state duration for every
recoverable class.**

#### D. Explicit health signal only

Retry a revoked session only after a new session generation mounts; retry a
connection failure only after reconnect; retry an authorization failure only
after a relevant ACL revision.

- Stops the four-Hz retry and warning churn while nothing changed.
- Makes the healing fact explicit instead of inferred from elapsed time.
- A missing or broken health signal can block forever.
- Some failures, including an unknown commit-preparation crash, have no current
  recovery signal.

**Recommendation: use it to wake retries and to end a confirmed failure
episode, with cumulative failed-state duration as the escape from a signal that
never arrives.**

#### E. Hybrid: typed class, durable failed-state time, health-driven retry

On the first actual failure of the head event, persist a processing-side
checkpoint on its stream entry:

```ts
type DeliveryDeferral = {
  phase: "dispatch-load" | "commit-preparation";
  failureClass:
    | "session-revoked"
    | "connection"
    | "authorization"
    | "protocol"
    | "timeout"
    | "unknown";
  firstFailureAt: number;
  lastFailureAt: number;
  accumulatedFailureMs: number;
  activeFailureStartedAt?: number;
  state: "failed" | "recovering";
  recoveryEpoch?: string;
};
```

The checkpoint is not a consequence: it does not set `consequenced`, appear in
`consequenceOf`, or advance the watermark. It changes only on a failure or
recovery transition, including when a more specific failure class becomes
known. Per-attempt counts stay in stats rather than producing a durable write
every 250 ms.

The proposed policy is:

- a typed permanent authorization or protocol verdict terminalizes
  immediately as `needs-attention`;
- `session-revoked` and `connection` wait for a new storage recovery epoch and
  retry on that event, not every backstop tick;
- `timeout`, `unknown`, and `commit-preparation` receive one clean reattempt,
  then retry only on a relevant input/runtime change;
- an actual typed failure starts or resumes an active failure episode;
- a typed positive recovery signal for that same boundary closes the episode,
  adds its duration to `accumulatedFailureMs`, and wakes one retry; ordinary
  dirty-input settlement and pending replica loads are `recovering`, not
  `failed`;
- recovery, remount, failure-class change, and scheduler attempts never erase
  accumulated failed-state time; only a committed handler consequence or
  terminal notice clears the checkpoint; and
- when accumulated failed-state time reaches
  `MAX_EVENT_DELIVERY_FAILURE_BUDGET`, the server seals `needs-attention`
  without another load attempt.

For the last comparison, spent budget is
`accumulatedFailureMs + (now - activeFailureStartedAt)` while `state` is
`failed`, and only `accumulatedFailureMs` while `recovering`. Entering `failed`
schedules one policy wake at the remaining budget boundary. That wake evaluates
terminal disposition; it does not cancel or time out a storage operation and is
not a retry cadence.

The draft value is **60 seconds of confirmed failed-state time**, deliberately
much longer than the current roughly two-second cold-view creation-race window.
It bounds infrastructure failure without charging a legitimate multi-wave or
cross-space settle. This number is a recommendation, not a decision.

Barrier followers require a separate outcome from the failing head. The live
code currently sends `cause: "load-park"` for both. A later build must produce
something equivalent to:

```ts
type ServedDeferralOutcome =
  | {
    kind: "deferred";
    cause: "load-park";
    role: "failed-head";
    failure: unknown;
  }
  | {
    kind: "deferred";
    cause: "arrival-barrier";
    blockedBy: string;
  };
```

Only `role: "failed-head"` creates or evaluates a delivery-deferral checkpoint.
The follower remains pending and is tried normally after the head gets a
handler consequence or durable terminal cover.

**Recommendation: E.** It directly closes both failure modes in the simpler
age proposal: accumulated time survives a flapping session, while time spent
making legitimate progress does not terminalize the user's action.

### 4.2 Settlement and cross-space dependencies

A stale handler input is not itself a delivery failure. Preflight keeps the
event at the scheduler head, makes its read closure transiently demanded, and
recomputes invalid or never-run inputs before dispatch. If that recomputation
reads a foreign-space document whose replica load is in flight, the existing
CT-1795 gate parks the event until the load settles. Neither state creates or
ages a delivery-deferral checkpoint.

The spaces do not share or nest one wave. The home SpaceServer may finish in
the current wave when the foreign input arrives before its flush deadline. If
the deadline cuts first, it commits only work already safely sealed, does not
advance the event's coverage, and resumes in a continuation wave. The foreign
SpaceServer runs independently. A foreign commit wakes the home scheduler and,
if the event is still pending, causes preflight to run again; a commit after
dispatch is ordinary later input and never replays the at-most-once handler.

There is one adjacent currentness limit that OW54 must not hide. A foreign read
loads the target document's latest committed value and registers a future wake,
but does not by itself demand an undemanded derivation in the target space or
prove that target space quiescent. The semantic options are:

1. **Per-space snapshot:** the handler may use the latest committed foreign
   value visible to its home wave. A later foreign commit is ordinary next-wave
   input and never replays the at-most-once handler.
2. **Explicit foreign freshness obligation:** when a handler's closure needs a
   foreign derived value, the home server records target-side demand plus a
   coverage obligation, leaves the event pending, and resumes only after the
   target server publishes the required coverage or a typed failure. The two
   SpaceServers still run independent waves; there is no distributed wave or
   cross-space atomic commit.

**Recommendation: option 2 for foreign derived values whose freshness is part
of handler correctness.** Its implementation and cycle/non-progress semantics
are a separate currentness design, not part of OW54. Until that design exists,
OW54 must not turn lack of foreign progress into a fabricated load failure or
charge it against the delivery-failure budget.

### 4.3 Predicate owner questions

- **OQ-1:** Ratify the hybrid predicate, or choose A–D.
- **OQ-2:** Ratify the recommended 60-second cumulative failed-state budget,
  choose a different value, or make it deployment-configured.
- **OQ-3:** Ratify the immediate-terminal classes
  (`authorization`/`protocol`) and the initial recoverable class set.
- **OQ-4:** Is a persisted server wall-clock time acceptable across lease
  handoff? Recommendation: yes, with negative elapsed time clamped to zero and
  a conservative ceiling; a forward clock jump may terminalize early and must
  be observable.
- **OQ-5:** If `loadsSettled()` never settles, this policy cannot observe a
  failure and therefore cannot terminalize it without introducing an operation
  timeout. Recommendation: treat a never-settling load as a separate storage
  correctness defect; do not add an OW54 timeout around the promise.
- **OQ-19:** Does foreign currentness mean the latest committed per-space
  snapshot, or must a foreign derived read carry target-side demand and a
  coverage obligation? Recommendation: the explicit obligation when freshness
  is part of handler correctness, designed separately from OW54.

## 5. Give-up disposition and notice

### 5.1 Options

#### A. Widen T3 and seal `status: "dropped"`

This reuses every existing path but says a runnable handler may be dropped
because infrastructure stayed unhealthy. It erases the distinction #6365 was
built to restore and makes a recoverable user action look like an ordinary
unrunnable event.

**Recommendation: reject.**

#### B. Seal `error`

The client already recognizes error consequences. But `error` currently means
the handler ran and threw, or deterministic CFC enforcement refused its commit.
A pre-dispatch load failure did neither. Reusing it makes diagnostics and retry
policy ambiguous.

**Recommendation: reject for delivery exhaustion. Keep it for actual handler
errors and deterministic policy verdicts.**

#### C. Add an entry-local `needs-attention` terminal kind

The terminal cover is written on the event's existing stream entry:

```ts
type DeliveryFailureClass =
  | "session-revoked"
  | "connection"
  | "authorization"
  | "protocol"
  | "timeout"
  | "unknown";

type NeedsAttentionTerminalCover = {
  consequenced: true,
  status: "needs-attention",
  reason: "The action could not be delivered. Review and retry it.",
  attention: {
    phase: "dispatch-load" | "commit-preparation",
    failureClass: DeliveryFailureClass,
    code: "delivery-failure-budget-exhausted" |
      "permanent-delivery-failure",
    firstFailureAt: number,
    lastFailureAt: number,
    accumulatedFailureMs: number,
    recovery: "explicit-retry"
  }
};
```

The notice commit names the event in `consequenceOf` and advances the stream
watermark. Raw payload, credentials, cross-space document keys, and raw backend
errors do not enter the client-visible notice. The server log can carry those
details subject to the existing logging policy; the durable reason and code are
safe, stable summaries.

An unresolved `needs-attention` entry is not eligible for ordinary stream
compaction. A retry or explicit dismissal writes its resolution; only then may
the entry retire below the watermark. Without this retention rule an offline
client can reconnect after compaction and miss the only recovery handle.

The entry alone is not a complete discovery surface after a full client
restart: the new process may not know which stream sidecars to watch. The same
wave therefore adds a reference and safe summary to a well-known per-space
unresolved-attention index. The entry remains authoritative; the index contains
only `{ eventId, sidecarId, phase, failureClass, code, firstFailureAt }` and is
removed atomically with resolution. A client watches one index per open space,
then resolves the referenced entry before offering recovery actions.

**Recommendation: choose C plus the derived index.** It is the smallest shape
that is terminal and self-describing while remaining discoverable after a
fresh client process.

#### D. Make a separate attention-inbox document authoritative

This decouples attention retention from stream compaction and supports a global
inbox, but duplicates the terminal source of truth and needs its own dedupe and
reconciliation contract.

**Recommendation: reject as the authority.** Use the narrow derived index above
for discovery; a product-wide inbox may later project from it.

### 5.2 Seal owner questions

- **OQ-6:** Ratify `status: "needs-attention"` as a new terminal kind beside
  T3 drop.
- **OQ-7:** Ratify the authoritative entry-local shape, the unresolved
  compaction hold, and the derived per-space discovery index; or choose a
  separate authoritative attention document.
- **OQ-8:** Ratify the client-safe field set. Recommendation: stable phase,
  class, code, first/last failure times, accumulated failed-state time, count,
  and recovery mode; raw keys and raw error text stay server-side.
- **OQ-9:** Does explicit dismissal count as recovery, or may an unresolved
  notice be cleared only by a retry? Recommendation: support both, recording
  `dismissed` or the new retry event ID as the resolution.

## 6. Ordering release

### 6.1 Options

#### A. Never step over the event

This preserves the strongest reading of “process in arrival order” but leaves
the wedge permanent. A terminal notice would be visible yet would not restore
liveness.

**Recommendation: reject; it does not meet this design's purpose.**

#### B. Release only the failed stream

This permits other streams in the space to overtake the failed event. It
changes events.md §2's across-stream arrival guarantee and makes ordering
depend on which sidecar an action happened to use.

**Recommendation: reject unless the owner first narrows §2 to per-stream
ordering.**

#### C. The terminal notice occupies the event's arrival position

The `needs-attention` notice is a terminal outcome, like the existing drop or
error consequence. Later events may proceed once the notice is guaranteed to
commit in the same wave or has committed in an earlier wave. The failed
handler's domain writes are absent by definition, so later handlers observe
state without them. That is an explicit availability-over-intended-sequence
trade, never a claim that the skipped action succeeded.

If the notice cannot seal, the head stays pending and the arrival barrier stays
closed. In particular, a promise that resolves `{ error }` is a failed seal,
not success. The implementation cannot release ordering through OW58's known
resolved-error guard gap.

**Recommendation: choose C.** It preserves order between durable outcomes and
makes the exception visible at the exact skipped position.

### 6.2 Ordering owner questions

- **OQ-10:** Does events.md §2 permit a committed terminal
  `needs-attention` outcome to occupy the earlier event's arrival position so
  later events may proceed? Recommendation: yes.
- **OQ-11:** May later handlers run after the notice is accepted into the same
  wave, or only after that wave commits? Recommendation: same-wave execution is
  allowed only if the wave is atomic: the later consequences cannot commit
  without the earlier notice. A failed notice seal must withdraw or block every
  later outcome that would overtake it.

## 7. Re-arm and the original OW54 class

### 7.1 Re-arm options

#### A. Automatically reopen the same entry on ACL/session change

The event's watermark position has already advanced. Clearing
`consequenced` would put a pending entry below the idempotency frontier, and
reusing the event ID risks a second handler consequence if the original result
was ever ambiguous. It also replays an old actor after authorization changed.

**Recommendation: reject.** Health changes wake retries only while the entry is
still pending; they never reopen a terminal ID.

#### B. Explicit retry creates a new event ID

The current client explicitly requests retry. The runtime copies the original
stream and captured payload into a new entry, authenticates it as the current
client, and writes `retryOf: <originalEventId>` for audit. The original remains
terminal. Exactly-once remains ordinary: each ID can consequence once, and the
relation does not alter dedupe.

The original notice records `resolution: { kind: "retried", eventId }` only
after the retry append is durable. A dismissal records
`resolution: { kind: "dismissed" }`. Resolution permits later compaction; it
does not rewrite the original outcome.

**Recommendation: choose B.**

#### C. Terminal means no retry

This is safe for exactly-once but fails the recoverability requirement. A user
could manually repeat the action, but the system would lose the causal link and
could not distinguish deliberate retry from a new action.

**Recommendation: reject.**

### 7.2 Commit-preparation crash

Current main keys the OW54 terminal error seal on a message prefix:
`CFC enforcement rejected commit`. That prefix covers both deterministic CFC
policy verdicts and a modeled `CFC commit-prep crashed: ...` reason. The former
cannot converge and should remain an immediate error consequence. The latter
is a runtime/preparation failure; it may heal after state or code changes and
should not be called the user's handler error.

The recommended build separates them at the producer:

- `CfcCommitRefusalError` with typed verdict reasons remains an immediate
  `error` consequence;
- a typed `CommitPreparationError` enters the delivery-deferral checkpoint
  with `phase: "commit-preparation"`;
- a fresh attempt may run while the entry is pending, under the same
  cumulative failed-state budget;
- persistent preparation failure seals the same `needs-attention` shape; and
- a storage-time rejection with an ambiguous commit outcome is not eligible
  for explicit replay under this design. The initial build covers only failures
  proven to occur before storage.

This closes OW54's every-entry-terminal invariant without preserving the
historical no-cover bug or cementing the current transient-crash-as-error
subcase.

### 7.3 Re-arm and preparation owner questions

- **OQ-12:** Ratify explicit retry as a new event ID with `retryOf`, and reject
  automatic reopening of a terminal event ID.
- **OQ-13:** Must retry copy the exact original payload, or may the client edit
  it? Recommendation: exact copy for “Retry”; an edited action is a new action
  without `retryOf`.
- **OQ-14:** Ratify splitting commit-preparation crashes from deterministic CFC
  verdicts and routing only the crash class through this budget.
- **OQ-15:** Ratify the scope boundary: failures known to be pre-storage are
  retryable by explicit new-ID action; ambiguous storage-time outcomes are not.

## 8. Observability

### 8.1 Recommended counters

Keep `events.loadParkDeferrals` as the work counter #6365 defined: it counts
the failing head and barrier followers. Add:

- `events.loadParkFailures`: actual failed-head load outcomes only; barrier
  followers do not increment it;
- `events.deliveryDeferralsActive`: current pending entries with a durable
  delivery-deferral checkpoint;
- `events.deliveryFailuresActive`: checkpoints currently in the `failed`
  state, excluding recovery and dependency settlement;
- `events.maxAccumulatedDeliveryFailureMs`: greatest spent failure budget among
  active checkpoints;
- `events.needsAttention`: terminal notices whose wave committed, split by
  `dispatch-load` and `commit-preparation` in a nested `byPhase` object;
- `events.needsAttentionSealFailures`: attempts that failed to persist the
  terminal notice; and
- `events.explicitRetries`: accepted retry appends carrying `retryOf`.

`events.dropped` keeps its T3 meaning and must not include
`needs-attention`. Counters that describe durable terminal state increment on
wave outcome, not at the pre-commit decision. A refused notice therefore grows
`needsAttentionSealFailures`, leaves the entry active, and does not grow
`needsAttention`.

### 8.2 Recommended logs

Log transitions rather than every 250 ms attempt:

- `event-delivery-deferred` at first failure, with event ID, phase, typed class,
  safe space/stream identity, and server-only detailed cause;
- `event-delivery-class-changed` when classification becomes more specific;
- `event-delivery-recovery-observed` when a typed recovery signal closes an
  active failure episode and wakes a retry;
- `event-needs-attention` when the terminal notice commits, including
  accumulated failed-state time and the failed-head attempts observed during
  the current tenure;
- `event-needs-attention-seal-failed` when durable cover fails; and
- `event-retry-requested` with original and new event IDs.

Repeated attempts remain measurable in counters. A rate-limited summary may
report accumulated repeats; the current head-plus-backlog warning flood should
not remain the primary signal.

### 8.3 Client signal

The speculation overlay gains a fourth terminal outcome:

```ts
type DeliveryFailureClass =
  | "session-revoked"
  | "connection"
  | "authorization"
  | "protocol"
  | "timeout"
  | "unknown";

type NeedsAttentionClientOutcome = {
  kind: "needs-attention";
  eventId: string;
  reason: string;
  attention: {
    phase: "dispatch-load" | "commit-preparation";
    failureClass: DeliveryFailureClass;
    code: "delivery-failure-budget-exhausted" |
      "permanent-delivery-failure";
    accumulatedFailureMs: number;
  };
};
```

It retires the speculative echo exactly as drop/error does, but also exposes
Retry and Dismiss. The signal must cross the runtime-client boundary and reach
a persistent shell surface; an internal callback with no production consumer
does not satisfy “visible”. An in-process reconnect rediscovers the retained
entry through the restored stream watch; a fresh process discovers unresolved
entries through the per-space attention index and then verifies each referenced
entry before presenting it.

### 8.4 Observability owner questions

- **OQ-16:** Ratify the counter set and the rule that
  `events.needsAttention` counts committed notices, not decisions.
- **OQ-17:** Ratify transition-only warning logs plus counters instead of one
  warning per head and barrier deferral.
- **OQ-18:** Is a persistent shell attention surface in the implementation
  scope, or is a runtime-client API the ratified meaning of “visible to the
  client”? Recommendation: require the shell surface; otherwise no user can
  exercise recovery.

## 9. DRAFT contract text

Every quotation in this section is **DRAFT — pending owner ruling**. It is the
exact live-spec text this proposal would imply. None belongs in the live spec
until §10 is resolved.

### 9.1 events.md §2 — replace the ordering bullet

> **DRAFT — pending owner ruling.** Ordering is the order of durable terminal
> outcomes. Per stream, an event's handler consequence or terminal notice
> commits in stream commit-seq order. Across streams in one space, those
> outcomes commit in wave arrival order. An error consequence, a T3 dropped
> notice, and a `needs-attention` notice each occupy the event's arrival
> position. Once the earlier outcome commits in the same wave or an earlier
> wave, later events may commit even when the earlier handler produced no
> domain writes. A later outcome MUST NOT commit if the earlier terminal notice
> failed to seal. No global ordering claim exists beyond the space's commit
> sequence.

### 9.2 events.md §5 — add after the T3 drop predicate

> **DRAFT — pending owner ruling. The NEEDS-ATTENTION predicate.** A served
> event whose handler remains runnable but whose dispatch load or pre-storage
> commit preparation cannot recover does not satisfy T3 and MUST NOT be marked
> `dropped`. The first actual failure of that event records a processing-side
> delivery-deferral checkpoint on its stream entry. The checkpoint accumulates
> only intervals in which a typed delivery failure remains active. A typed
> positive recovery signal closes the active interval and wakes one retry;
> dirty-input recomputation, ordinary wave continuation, and an in-flight
> replica load are settlement, not failure, and spend no budget. Recovery,
> remount, failure-class change, and scheduler attempts do not erase accumulated
> failed-state time. Only a committed handler consequence or terminal notice
> clears the checkpoint. An event held only behind an earlier arrival records no
> checkpoint and spends no budget.
>
> **DRAFT — pending owner ruling.** A typed permanent authorization or protocol
> failure seals immediately. Every other covered failure retries when its typed
> recovery signal changes and may receive one clean reattempt, but seals when
> `accumulatedFailureMs` reaches `MAX_EVENT_DELIVERY_FAILURE_BUDGET` (DRAFT
> value: 60 seconds). Attempt counts are observations, never the terminal
> predicate. The budget does not cancel an in-flight operation and is evaluated
> only while the system holds an observed failure verdict.
>
> **DRAFT — pending owner ruling. Cross-space settlement.** Event preflight
> makes the handler's home-scheduler read closure current before dispatch. A
> pending foreign replica load parks the event and is settlement, not failure.
> Spaces run independent waves: a flush-deadline cut may move the pending event
> to a continuation home wave, and a foreign commit wakes the home scheduler;
> no wave nests another space's wave and no cross-space atomic commit is
> implied. A foreign derived value whose freshness is part of handler
> correctness requires the separately ruled target-side demand and coverage
> obligation; absent that mechanism, a foreign read means the latest committed
> per-space value, not proof of foreign-space quiescence.
>
> **DRAFT — pending owner ruling. Where the notice lives.** The terminal cover
> is `{ consequenced: true, status: "needs-attention", reason, attention }` on
> the event's own stream entry. `attention` carries a stable phase, failure
> class, reason code, first/last failure times, and
> accumulated failed-state time plus `recovery: "explicit-retry"`; it carries no
> payload, credentials, cross-space document keys, or raw backend error. The
> commit writes the notice as that event's consequence, names the event in
> `consequenceOf`, and advances `eventWatermark` past it. `needs-attention` is a
> terminal kind beside T3 `dropped`, not a widening of T3 and not a claim that
> the handler ran.
>
> **DRAFT — pending owner ruling. Retention and client signal.** An unresolved
> `needs-attention` entry is excluded from stream compaction. The same atomic
> wave adds its reference and safe summary to the well-known per-space
> unresolved-attention index; that index is for discovery and the entry remains
> authoritative. The client retires the speculative echo, emits a structured
> `needs-attention` outcome, and offers Retry and Dismiss. Retry appends the same
> captured stream and payload under the client's current authority with a new
> `eventId` and `retryOf: <originalEventId>`; the original entry remains
> terminal and records the new ID as its resolution after that append is
> durable. Dismiss records a dismissed resolution. Resolution atomically
> removes the index item, and a resolved entry may compact under the ordinary
> watermark rule. Neither action reopens the original event ID.
>
> **DRAFT — pending owner ruling. Commit preparation.** A deterministic CFC
> policy verdict remains an immediate error consequence. A typed crash while
> preparing the commit is a pre-storage delivery failure and follows the same
> checkpoint, failed-state budget, `needs-attention`, and explicit-retry rules
> as a failed dispatch load. An ambiguous storage-time commit outcome is outside
> this retry rule.

### 9.3 serving-loop.md §7 — extend the events block

> **DRAFT — pending owner ruling.** `events.loadParkDeferrals` counts all
> load-park deferral decisions, including arrival-barrier followers;
> `loadParkFailures` counts only heads whose required load actually failed.
> `deliveryDeferralsActive`, `deliveryFailuresActive`, and
> `maxAccumulatedDeliveryFailureMs` expose the current checkpoint population
> without counting ordinary settlement as failure. `needsAttention` counts
> terminal attention notices after their wave commits, split by failure phase;
> `needsAttentionSealFailures` counts failed attempts to persist that cover;
> and `explicitRetries` counts accepted new-ID retry appends. `dropped` remains
> exclusive to events.md §5's T3 disposition. Repeated failure attempts are
> counters; logs report state transitions rather than every retry.

### 9.4 verification-coverage.md — OW54 row amendment

> **DRAFT — pending owner ruling. OW54 FOLLOW-ON OPEN: terminal cover after
> bounded delivery failure.** The original no-cover defect is CLOSED: a served
> event's deterministic CFC pre-storage refusal seals an error consequence.
> Two residual classes share the open invariant. First, #6365 makes a failed
> head-event load park defer indefinitely, preserving the user's durable action
> and arrival order but holding the lease and same-space stream; at the 250 ms
> backstop it costs about four load attempts per second and about 44 warning
> lines per second for a ten-event backlog, with slow failures repeatedly
> occupying the head-serial scheduler. Second, the current CFC message-prefix
> discriminator terminalizes a possibly transient commit-preparation crash as
> an immediate error even though it is not a deterministic policy verdict.
>
> **DRAFT — pending owner ruling. Proposed close.** Distinguish an actually
> failing head from arrival-barrier followers; persist cumulative time in typed
> failed-state episodes; classify failures with typed producer data; pause the
> budget while recovery and dependency settlement make progress; retry on
> recovery epochs; and after the ratified failure budget seal an entry-local
> `{ status: "needs-attention", consequenced: true }` notice. The notice is a
> new terminal kind beside T3 drop, occupies the event's arrival position,
> blocks later durable outcomes until its cover joins a successful wave, stays
> uncompactable until Retry or Dismiss resolves it, is discoverable from a
> derived per-space unresolved-attention index, and reaches stats plus a
> client-visible attention surface. Retry creates a new event ID linked by
> `retryOf`; the original never re-arms. Deterministic CFC verdicts remain
> immediate error consequences; typed commit-preparation crashes use the same
> bounded attention path as dispatch-load failures. OPEN until the owner rules
> OQ-1 through OQ-19 in the design document and the later build lands with the
> flapping, seal-failure, order-release, client-reconnect, and exactly-once
> pins.

## 10. Owner ruling set

Nothing below is decided by this document.

1. **Predicate:** adopt hybrid typed class + health wake + cumulative durable
   failed-state time?
2. **Budget:** adopt 60 seconds of confirmed failed-state time, another
   constant, or deployment configuration?
3. **Classes:** which failures are immediately terminal, and which are
   recoverable?
4. **Clock:** accept persisted server wall clock and the stated skew behavior?
5. **Hung load:** keep a never-settling promise outside OW54 rather than adding
   an operation timeout?
6. **Terminal kind:** add `needs-attention` beside T3 drop?
7. **Storage:** keep the notice authoritative on the entry, retain it from
   compaction while unresolved, and add the derived per-space discovery index?
8. **Disclosure:** ratify the client-safe fields and keep raw cause server-side?
9. **Resolution:** allow both Retry and Dismiss, or Retry only?
10. **Ordering:** let the committed terminal notice occupy the event's arrival
    position and release later events?
11. **Same wave:** allow later outcomes in the same atomic wave as the notice?
12. **Re-arm:** retry only with a new event ID and `retryOf`?
13. **Payload:** require Retry to copy the exact captured payload?
14. **Preparation:** split typed preparation crashes from deterministic CFC
    verdicts?
15. **Ambiguity:** keep storage-time ambiguous outcomes outside explicit
    replay?
16. **Counters:** adopt the proposed counter set and committed-notice counting
    point?
17. **Logs:** replace per-attempt warnings with transition logs plus counters?
18. **Visibility:** require a persistent shell attention surface in the build?
19. **Foreign freshness:** does a foreign derived read mean the latest committed
    per-space value, or must handler preflight carry target-side demand and a
    coverage obligation when freshness is part of correctness?

The recommendation is **yes to all nineteen**, with the 60-second failed-state
budget called out as the least evidence-backed recommendation and therefore the
first one to replace if the owner has a product latency target. Question 19's
implementation remains a separate currentness design rather than expanding the
OW54 build.

## 11. Later build shape and blast radius

No file below is changed by this design pass. A later implementation train is
expected to touch these seams:

1. **Typed storage failure and recovery epoch** —
   `packages/runner/src/storage/interface.ts`, `storage/v2.ts`, and the memory-v2
   session/reconnect adapters. `loadsSettled()` must return a typed class and a
   recovery epoch or signal; message parsing in the scheduler is forbidden.
2. **Scheduler facade** — `packages/runner/src/scheduler/types.ts`,
   `scheduler/events.ts`, and `scheduler/facade.ts`. Split failed-head from
   arrival-barrier outcomes, carry typed failure data, and keep client/LT1
   behavior unchanged.
3. **Space-server drain state** —
   `packages/runner/src/executor/space-server.ts`. Persist failure-episode
   transitions and cumulative failed-state time, never erase spent budget on
   flapping epochs, terminalize only the failed head, keep settlement and
   followers budget-free, and release the barrier only through an atomic
   successful cover.
4. **Seal machinery** — the same `#sealEventConsequenceNotice` path plus wave
   outcome accounting. A resolved `{ error }` must be treated as seal failure;
   later consequences cannot commit past it. This is the OW58-sensitive part
   of the build.
5. **Commit-preparation taxonomy** —
   `storage/extended-storage-transaction.ts`, `storage/rejection.ts`, and the
   scheduler's commit disposition. Replace the message-prefix conflation with
   a typed preparation-crash class while leaving CFC verdicts immediate.
6. **Durable schema, discovery, and compaction** — `packages/memory/v2.ts`,
   memory-v2 event admission/engine compaction, stream-entry validation, and a
   well-known per-space unresolved-attention index. Admit no client-supplied
   processing fields; retain unresolved attention entries; update the index in
   the same atomic wave as terminalization and resolution.
7. **Stats** — `packages/runner/src/executor/stats.ts`, health serialization,
   and serving-loop.md §7 after the owner ratifies the exact shape.
8. **Client absorption and UI** —
   `packages/runner/src/speculation/overlay-destination.ts`, runtime-client IPC,
   and the shell's persistent attention surface. Retry must use current client
   authority and a fresh ID.
9. **Live contract and register** — events.md §2/§5, serving-loop.md §7, and the
   OW54 row only after the implementation proves the ruled sentences.

The build should be separated into small, reversible PRs: typed taxonomy and
checkpoint; load-park predicate and seal; commit-preparation routing; client
retry/retention; then spec/register closure. The terminal ordering contract
must not ship half-present: the server may not step over until durable cover,
client absorption, and retention all exist.

## 12. Required verification for the later build

The later build is not complete without red-first, mutation-watched pins for:

1. a failed head accumulates the full failure budget while a flapping session
   changes recovery epoch repeatedly; recovery intervals pause but never erase
   spent budget, and exactly one attention notice commits;
2. a barrier follower never creates a checkpoint or terminalizes merely
   because the head does;
3. a fast session-revocation recovery before the budget is spent runs the
   handler exactly once and leaves no attention notice;
4. a timeout/unknown failure stops four-Hz polling while waiting for recovery
   or terminal failure-budget exhaustion;
5. a notice commit that rejects or resolves `{ error }` leaves the head pending
   and prevents a later outcome from committing;
6. a successful notice occupies the earlier arrival position and later events
   then consequence in order;
7. the original terminal ID never runs again; explicit retry uses a new ID,
   runs at most once, and records `retryOf`;
8. reconnecting after terminalization still discovers an unresolved notice;
   compaction cannot retire it before resolution;
9. deterministic CFC refusal remains an immediate error consequence while a
   typed preparation crash follows the bounded attention path;
10. client-side and stream-entry-less LT1 events retain their existing
    behavior; and
11. stats distinguish barrier work, actual head failures, active failure time,
    committed notices, and failed notice seals without relying on log text; and
12. a dirty event input whose recompute reads a foreign space spends no failure
    budget while the load and continuation waves make progress, never nests the
    spaces' waves, and dispatches at most once after the ratified freshness
    condition holds.

Tests must use an injected clock and causal recovery/seal gates. No sleeps,
polling-based proof, or real-time wait is part of the contract.

## 13. Explicitly out of scope

- the #6365 review's wake-shaper barrier bypass (F1);
- exempting drain re-dispatches from wake shaping;
- OW63's cross-piece same-space shaper-order question;
- the general pre-queue sidecar-sync/view-lag hardening owed by OW45;
- a global product attention inbox beyond this event-entry notice;
- target-side foreign-derived demand, coverage, cycle detection, and
  non-progress implementation (OQ-19's separate currentness design);
- cancellation or timeout of a never-settling storage promise; and
- replay of any failure whose storage outcome may be ambiguous.
