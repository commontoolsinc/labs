---
status: historical
created: 2026-08-26
archived: 2026-08-26
reason: "Executed plan; bounded terminal cover and explicit event recovery shipped."
superseded-by: docs/specs/server-side-execution/events.md
---

# OW54 — terminal cover for a served event that cannot run

**Status: DRAFT FOR OWNER RATIFICATION — design only.** No sentence in this
document changes the server-execution contract, and no implementation may land
from it until the owner rules on every question in §10. Written against
the branch base `d0d0eb79c` and refreshed against `origin/main` at
`5f621cb92` on 2026-08-26, including #6378's served in-space name-resolution
retry.

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
3. **Terminal before release.** A later event cannot run past an earlier event
   until the earlier handler consequence or terminal notice durably commits.
   A notice that sealed into a wave but was rebased out or whose wave commit
   failed has not released the barrier.
4. **One event ID, one terminal outcome.** Reopening a terminal event ID is not
   a retry mechanism.
5. **Barrier victims do not inherit the head's failure.** A later event held
   only for arrival order has not itself failed dispatch and cannot spend a
   give-up budget.
6. **No string-based policy.** Failure class is typed at the producer; error
   text is diagnostic, not a control channel.
7. **Explicit policy exception, no operation cancellation.** A failed-state
   budget is an upper bound on eventual automatic delivery and therefore needs
   an explicit owner exception to this repository's no-timeout rule. It changes
   disposition only after an observed failure and never cancels a still-running
   load. At budget expiry, current recovery state is checked before sealing.
8. **Settlement is not failure.** Dirty-input recomputation, continuation
   waves, pending foreign replica loads, and #6378's bounded in-wave
   `RetryImmediately` requeue for served name resolution spend no
   delivery-failure budget.
9. **OFF is unchanged.** The design applies only to durable served entries.
   Client-only events have no durable entry for the server to re-drain or seal.

## 3. Option matrix

| Question | Options | Recommendation, pending owner ruling |
| --- | --- | --- |
| Give-up predicate | attempt count; elapsed age; class-specific count/age; explicit health signal; hybrid class + cumulative failed-state time + health wake | **Hybrid.** Persist cumulative time in confirmed failure episodes, classify the failure, pause after a positive recovery signal while its retry and dependency settlement progress, and terminalize at a failed-state budget. Waiting for a recovery signal remains failed time. This upper bound requires an explicit owner exception to the no-timeout rule; counts are observability only. |
| Cross-space settlement | latest committed foreign value; explicit target-side demand and coverage | **Explicit freshness obligation when freshness is part of handler correctness.** Spaces still settle independently; waiting or continuation is not a delivery failure. This is an adjacent currentness design, not an OW54 timeout. |
| Terminal disposition | reuse `dropped`; reuse `error`; use only an entry-local `needs-attention` notice; pair the entry notice with a per-space unresolved-attention index | **New entry-local `needs-attention` terminal kind plus a derived per-space index.** The entry is authoritative; the index makes unresolved notices discoverable after a fresh client process. |
| Ordering release | never step over; release only the affected stream; release the space after the notice commits | **Release the space only after durable cover commits.** The notice occupies the failed event's arrival position, but later handlers wait for the notice wave's successful outcome. This preserves the existing process-order sentence and avoids new cross-entry withdrawal machinery inside a partially committing wave. |
| Re-arm | automatically reopen the same entry on ACL/session change; explicit retry with a new event ID; terminal means no retry | **Explicit retry with a new event ID and `retryOf`, atomically CASed with resolution.** The original stays terminal; admission-verified payload provenance is copied by the server, current same-user authority is revalidated, concurrent/replayed requests return the one recorded retry ID, and exactly-once remains per event ID. |
| Commit-preparation crash | keep immediate error; leave unconsequenced; classify and budget with load failure | **Classify and budget.** Deterministic CFC policy refusals remain immediate errors; an actual preparation crash gets the same bounded `needs-attention` destination as dispatch failure. |
| Commit-phase residuals | leave the current re-drain cadence; cover proven-no-commit failures; cover every failed outcome | **Cover only outcomes that prove no commit occurred.** Add the deterministic `RowLabelCommitError` and typed pre-seal give-ups to the owner ruling; keep ambiguous storage outcomes outside replay. |
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
- Is a timeout-like upper bound on eventual automatic success and conflicts
  with the repository's ordinary no-timeout posture unless the owner explicitly
  approves this narrow terminal-disposition exception.
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

- Can immediately terminalize an authorization or protocol verdict only when
  the producer supplies positive durable evidence that retrying the unchanged
  action under the current state cannot help. A generic unauthorized response
  is not that evidence.
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
  phase: "dispatch-load" | "commit-preparation" | "commit-finalization";
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
  failureCount: number;
  activeFailureStartedAt?: number;
  state: "failed" | "recovering";
  recoveryEpoch?: string;
};
```

The checkpoint is not a consequence: it does not set `consequenced`, appear in
`consequenceOf`, or advance the watermark. It changes only on a failure or
recovery transition, including when a more specific failure class becomes
known. `failureCount` increments only on a typed failed-head observation, which
already causes a checkpoint transition; scheduler-attempt counts stay in stats
rather than producing a durable write every 250 ms.

The checkpoint is a server-owned processing write stamped with §3d's existing
`bookkeeping` kind, not a fourth run kind and not an `event-handler`
consequence. A failed checkpoint write cannot be papered over by lease-local
memory: the event and its barrier remain pending, the failure is counted, and
the loop re-derives the checkpoint write on the next valid storage wake. If the
server loses tenure before any checkpoint version commits, a successor has no
durable failure age to inherit and starts from its first observed failure. That
fail-closed undercount may extend the wedge but cannot silently discharge or
prematurely terminalize the action. The proposed failed-state bound therefore
assumes the event's own processing-state writes can commit; making it survive a
total failure of that store would require a second authority and is not
recommended.

The proposed policy is:

- an authorization verdict is immediately terminal only when a typed result
  cites a current durable ACL revision that denies the acting user for this
  operation and distinguishes that denial from a revoked or missing session;
  a protocol verdict is immediately terminal only when versioned validation
  proves the captured entry or payload structurally invalid. Any producer that
  cannot supply that positive evidence defaults to a recoverable
  `session-revoked`, `connection`, or `unknown` class;
- `session-revoked` and `connection` wait for a new storage recovery epoch and
  retry on that event, not every backstop tick;
- `timeout`, `unknown`, and `commit-preparation` receive one immediate clean
  reattempt while remaining `failed`; the attempt and any wait for it continue
  to spend budget because no positive recovery evidence exists. After that
  reattempt they retry only on a relevant input/runtime change;
- an actual typed failure enters `failed` and starts or resumes an active
  failure episode. Waiting for the next recovery signal, including a long
  remount, reconnect, backoff, or relevant-input wait, remains `failed` and
  spends budget because the system has no positive evidence of progress;
- a typed positive recovery signal for that same boundary closes the active
  episode, adds its duration to `accumulatedFailureMs`, enters `recovering`, and
  wakes exactly one retry. That retry and the dirty-input, continuation-wave,
  and pending-replica-load settlement it starts remain `recovering` and spend no
  budget;
- if the recovery attempt returns a typed failure, the checkpoint re-enters
  `failed` at that observation and starts a new episode; a scheduled retry
  backoff by itself is not positive recovery evidence;
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
current typed recovery state before terminal disposition: a changed recovery
epoch or other positive signal enters `recovering` and receives its one retry;
only an unchanged active failure may seal. Activation after restart or lease
handoff performs the same recovery-state comparison before evaluating the
budget. The wake does not cancel a storage operation and is not a retry cadence,
but the terminal upper bound is still the explicit timeout-policy exception in
OQ-2.

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

The existing cold-view T3 counter is independent of this checkpoint. A
load-park failure neither increments nor clears the count of observations that
the handler itself cannot run. The current
`#eventDeferrals.delete(entry.eventId)` in the load-park arm should therefore be
removed in the later build: keeping the two predicates separate means not
mixing their increments, not erasing one predicate's history. A genuinely
unrunnable entry still reaches T3 after eight cold-view observations even when
load failures interleave; an entry with a runnable handler spends only the
delivery-failure budget. Whichever terminal predicate commits first ends the
entry, and neither counter transfers into the other.

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
- **OQ-2:** Ratify the recommended 60-second cumulative failed-state budget as
  an explicit narrow exception to the repository's no-timeout rule, choose a
  different value, choose deployment configuration, or reject automatic
  time-based terminalization.
- **OQ-3:** Ratify the immediate-terminal classes
  (`authorization`/`protocol`) only with the positive durable evidence above,
  with every ambiguous unauthorized response defaulting to recoverable, and
  ratify the initial recoverable class set.
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
- **OQ-22:** Ratify that a load-park observation neither increments nor clears
  the independent cold-view T3 count. Recommendation: remove the current reset
  so flapping cannot defeat the eight-observation hardening bound.
- **OQ-24:** If the first checkpoint write itself cannot commit, accept the
  fail-closed rule above—keep the event pending, count the write failure, and
  inherit only committed age across tenure—or introduce a second durable
  authority? Recommendation: fail closed and do not add a second authority.

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
  reason: string,
  attention: {
    phase: "dispatch-load" | "commit-preparation" | "commit-finalization",
    failureClass: DeliveryFailureClass,
    code: "delivery-failure-budget-exhausted" |
      "permanent-delivery-failure",
    firstFailureAt: number,
    lastFailureAt: number,
    accumulatedFailureMs: number,
    failureCount: number,
    recovery: "explicit-retry"
  }
};
```

`attention` above is the authoritative client-safe field set. `failureCount`
counts typed failed-head observations only, never arrival-barrier followers.
The runtime-client outcome carries this same object without dropping fields;
the unresolved-attention index remains a deliberately smaller discovery hint
whose entry reference resolves to the authoritative cover.

`attention.code` is the stable machine contract. `reason` is client-safe
presentation text selected by the product surface and is intentionally not a
fixed English sentence in the durable schema.

The notice commit names the event in `consequenceOf` and advances the stream
watermark. Raw payload, credentials, cross-space document keys, and raw backend
errors do not enter the client-visible notice. The server log can carry those
details subject to the existing logging policy; the durable reason and code are
client-safe, and only the code is the stable machine summary.

An unresolved `needs-attention` entry is not eligible for ordinary stream
compaction. A retry or explicit dismissal writes its resolution; only then may
the entry retire below the watermark. Without this retention rule an offline
client can reconnect after compaction and miss the only recovery handle.

The entry alone is not a complete discovery surface after a full client
restart: the new process may not know which stream sidecars to watch. The same
non-derivable terminal contribution therefore adds a reference and safe summary
to a well-known per-space unresolved-attention index; ordering releases only
after the wave outcome confirms that contribution committed. The entry remains
authoritative; the index contains only
`{ eventId, sidecarId, phase, failureClass, code, firstFailureAt }` and is
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
  and recovery mode in both the terminal cover and runtime-client outcome; raw
  keys and raw error text stay server-side.
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
error consequence. Its terminal processing decision may occupy the earlier
position without redefining events.md §2's existing process-order guarantee.
The failed handler's domain writes are absent by definition, so a later handler
that runs after durable cover observes state without them. That is an explicit
availability-over-intended-sequence trade, never a claim that the skipped
action succeeded.

There are two release points:

1. **Same-wave release.** Later handlers run after the notice transaction
   seals into the wave. This saves one wave, but current §3d does not make the
   whole wave atomic. It CASes per document and may rebase a non-derivable
   event-handler contribution out while committing unaffected contributions.
   This option therefore requires new cross-entry withdrawal machinery: if the
   notice is absent from the durable outcome for any reason, every later event
   that relied on it must also be withdrawn and requeued.
2. **Post-commit release.** The barrier remains closed until the notice wave's
   outcome confirms that the authoritative entry cover committed. Later
   handlers run in a following wave. A notice that throws, rejects, resolves
   `{ error }`, or seals successfully but is rebased out at commit releases
   nothing. This adds one wave of latency only on the terminal path and uses the
   existing barrier and wave-outcome report instead of new atomicity.

**Recommendation: choose post-commit release.** It keeps §2's process-order
language intact, avoids a new §3d coupling rule, and makes the exception visible
at the exact skipped position. Same-wave release remains a possible owner
choice only with the explicit cross-entry withdrawal rule above.

### 6.2 Ordering owner questions

- **OQ-10:** Does events.md §2 permit a committed terminal
  `needs-attention` outcome to occupy the earlier event's arrival position so
  later events may proceed? Recommendation: yes.
- **OQ-11:** May later handlers run after the notice seals into the current
  wave, accepting the new §3d cross-entry withdrawal obligation, or only after
  that wave durably commits? Recommendation: wait for the committed wave
  outcome; current waves are not atomic across contributions.
- **OQ-21:** Preserve §2's existing “events process in order” sentence and add
  only the terminal-position clarification, leaving OW63's question about
  whether across-stream order binds across pieces unresolved; or separately
  weaken §2 to outcome-commit order? Recommendation: preserve process order and
  reserve OW63 explicitly.

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

The current client sends an authenticated recovery request. The serving
recovery path copies the original stream and captured payload into a new entry,
authenticates it under the requesting client's current authority, and writes
`retryOf: <originalEventId>` for audit. The original remains terminal.

The retry's durable provenance is server-derived, never supplied by the
request. If the original admission verified `rendererTrusted: true`, the server
copies that attestation; it also copies the original
`runtimeInjectedEventKeys` alongside the exact payload. This is not a fresh
client claim: the authoritative original entry is the trust argument, and the
resolution transaction runs in the same serving trust environment that
re-mints those marks during ordinary served dispatch. If the original entry
lacks either field, Retry cannot add it.

`firedAt` is different: Retry stamps the requesting client's current session
rather than replaying the original session, so session-scoped effects land in
the session that actually requested recovery. The recommended authorization
rule permits that session change but requires the same acting user when the
original names one; a different user must submit a new action without
`retryOf`. A sessionless or userless original is not user-retryable until the
owner defines an explicit delegated system-retry authority. This avoids
silently replaying user A's captured payload as user B while still refusing an
expired session as authority.

Retry is one same-space atomic transaction with a compare-and-swap precondition
that the authoritative original notice is still unresolved. The winning
transaction appends exactly one fresh retry event ID, records
`resolution: { kind: "retried", eventId }` on the original, and removes the
unresolved-attention index item. A concurrent request that loses the CAS appends
nothing and returns the already-recorded resolution. A replay after a lost
response likewise returns that same retry event ID instead of minting another.
Exactly-once remains ordinary: each ID can consequence once, while the atomic
resolution guarantees at most one retry ID per terminal original.

Dismiss uses the same CAS, writing `resolution: { kind: "dismissed" }` and
removing the index item without an append. A Retry/Dismiss race therefore has
one winner and no half-resolved state. Resolution permits later compaction; it
does not rewrite the original terminal outcome. Clients cannot write processing
fields directly—the authenticated recovery request reaches the serving path
that owns the resolution field and performs the atomic transaction.

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

This closes the dispatch-load and commit-preparation part of OW54 without
preserving the historical no-cover bug or cementing the current
transient-crash-as-error subcase. It does not by itself close every
commit-phase re-drain class.

### 7.3 Commit-phase residuals

The OW54 build report and live register name two adjacent families with the
same durable shape:

- a deterministic storage-time `RowLabelCommitError` refuses the wave, reports
  the affected event contribution requeued, and leaves the entry
  unconsequenced; and
- pre-seal non-CFC give-ups—transport, authorization-at-commit, and handler
  abort—settle the scheduler copy without a consequence, after which the
  durable entry re-drains.

Neither family is covered merely by excluding an **ambiguous** storage
outcome. `RowLabelCommitError` proves the wave did not commit. Some pre-seal
give-ups can also prove no storage attempt occurred. The safe boundary is
therefore outcome evidence, not phase name: a typed failure may enter a
terminal-cover policy only when the producer proves that no handler consequence
committed. Ambiguous transport or storage outcomes remain ineligible for
explicit replay.

The recommended later design includes the proven-no-commit subset with a
`commit-finalization` phase: a positively evidenced permanent authorization or
protocol refusal terminalizes immediately, a transient typed transport failure
uses the failed-state checkpoint, and an explicit handler abort becomes a
handler error consequence rather than an infrastructure retry. A
`RowLabelCommitError` remains pending after the refused wave and may stage its
terminal cover in a later wave. Each classification needs its own producer
type; no message prefix decides it. If the owner declines that expansion, both
families must remain explicitly open in the OW54 register and this design must
not claim the every-entry-terminal invariant closed.

### 7.4 Re-arm and failure owner questions

- **OQ-12:** Ratify explicit retry as one new event ID with `retryOf`, created in
  the same CAS transaction that resolves the original and removes its index
  item; reject automatic reopening and non-atomic append-then-resolution.
- **OQ-13:** Must retry copy the exact original payload, or may the client edit
  it? Recommendation: exact copy for “Retry”; an edited action is a new action
  without `retryOf`.
- **OQ-14:** Ratify splitting commit-preparation crashes from deterministic CFC
  verdicts and routing only the crash class through this budget.
- **OQ-15:** Ratify the scope boundary: explicit new-ID retry requires positive
  evidence that no handler consequence committed; ambiguous storage-time or
  transport outcomes are not retryable by this path.
- **OQ-20:** Ratify retry provenance and actor carriage. Recommendation: the
  server copies admission-verified `rendererTrusted` and
  `runtimeInjectedEventKeys`, never accepts them from the request, stamps the
  requesting session, permits Retry only for the original acting user, and
  leaves sessionless/system retry for a separate delegated-authority design.
- **OQ-23:** Should proven-no-commit `RowLabelCommitError` and pre-seal
  non-CFC give-ups join this terminal-cover design? Recommendation: yes, with
  the typed disposition above; keep any ambiguous outcome outside replay and
  keep the register row open until these residuals are built or explicitly
  declined.

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
  `dispatch-load`, `commit-preparation`, and `commit-finalization` in a nested
  `byPhase` object;
- `events.needsAttentionSealFailures`: attempts that failed to persist the
  terminal notice; and
- `events.deliveryCheckpointWriteFailures`: failed attempts to persist a
  processing checkpoint; and
- `events.explicitRetries`: accepted retry appends carrying `retryOf`.

`events.dropped` keeps its T3 meaning and must not include
`needs-attention`. Counters that describe durable terminal state increment on
wave outcome, not at the pre-commit decision. A refused notice therefore grows
`needsAttentionSealFailures`, leaves the entry active, and does not grow
`needsAttention`. This intentionally differs from the existing
`events.dropped` implementation, which counts the T3 decision before its notice
commits and can therefore count the same still-pending entry again after a
refused notice. The later build does not silently change that legacy counter;
the live serving-loop text must name the different counting points, and any
alignment of `dropped` to commit-time counting is a separate observability
change.

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
    phase: "dispatch-load" | "commit-preparation" | "commit-finalization";
    failureClass: DeliveryFailureClass;
    code: "delivery-failure-budget-exhausted" |
      "permanent-delivery-failure";
    firstFailureAt: number;
    lastFailureAt: number;
    accumulatedFailureMs: number;
    failureCount: number;
    recovery: "explicit-retry";
  };
};
```

It retires the speculative echo exactly as drop/error does, but also exposes
Retry and Dismiss. Its `attention` value is byte-for-byte the authoritative
client-safe object in §5.1.C; the runtime-client boundary does not project away
fields. The signal must cross the runtime-client boundary and reach
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

### 9.1 events.md §2 — add after the existing ordering bullet

> **DRAFT — pending owner ruling. Terminal positions.** The existing process
> order is unchanged. An error consequence, a T3 dropped notice, and a
> `needs-attention` notice each complete processing at the event's arrival
> position even when the handler produces no domain writes. A terminal decision
> sealed into a wave does not release later events: the arrival barrier opens
> only after the wave outcome confirms that the authoritative consequence or
> notice durably committed. A notice that fails before seal, resolves
> `{ error }`, is rebased out at commit, or belongs to a refused wave leaves the
> earlier event pending and later handlers blocked. This paragraph does not
> decide OW63's separate question of whether the existing across-stream order
> binds across pieces.

### 9.2 events.md §4 — add after the compaction allowance

> **DRAFT — pending owner ruling.** The ordinary allowance to compact a stream
> entry at or below `eventWatermark` does not apply while that entry carries an
> unresolved `needs-attention` notice. Retry or Dismiss records the resolution;
> only a resolved entry may compact under the ordinary watermark rule.

### 9.3 events.md §5 — add after the T3 drop predicate

> **DRAFT — pending owner ruling. The NEEDS-ATTENTION predicate.** A served
> event whose handler remains runnable but whose dispatch load or pre-storage
> commit preparation cannot recover does not satisfy T3 and MUST NOT be marked
> `dropped`. The first actual failure of that event records a processing-side
> delivery-deferral checkpoint on its stream entry. The checkpoint accumulates
> only intervals in which a typed delivery failure remains active. A typed
> failure remains active, and spends budget, while the system waits without
> positive recovery evidence—including during remount, reconnect, backoff, or a
> relevant-input wait. A typed positive recovery signal closes that active
> interval, enters recovery, and wakes one retry. That retry's dirty-input
> recomputation, ordinary wave continuation, and in-flight replica loads are
> settlement, not failure, and spend no budget. A served
> `RetryImmediately` requeue used to resolve an in-space name inside the
> current settle is also settlement and never creates or ages the checkpoint.
> A typed failure from the retry starts a new active failure interval. Recovery,
> failure-class change, and scheduler attempts do not erase accumulated
> failed-state time. Only a committed handler consequence or terminal notice
> clears the checkpoint. An event held only behind an earlier arrival records
> no checkpoint and spends no budget. A load-park observation neither
> increments nor clears the independent cold-view T3 count.
>
> **DRAFT — pending owner ruling. Checkpoint durability.** The processing
> checkpoint is a server-owned `bookkeeping`-stamped write, not a consequence
> and not a new run kind. If that write cannot commit, the entry and arrival
> barrier remain pending, the server counts the write failure, and the loop
> re-derives the checkpoint on a valid storage wake. Only committed checkpoint
> age survives restart or lease handoff; an uncommitted first observation may
> undercount and extend the wedge but MUST NOT authorize early terminalization.
>
> **DRAFT — pending owner ruling.** Authorization seals immediately only when a
> typed verdict cites a current durable ACL revision and distinguishes a denial
> from a revoked or missing session. Protocol seals immediately only when
> versioned validation proves the captured action structurally invalid. An
> unauthorized or protocol-shaped failure without that positive evidence
> defaults to a recoverable class. Every recoverable failure retries when its
> typed recovery signal changes. `timeout`, `unknown`, and
> `commit-preparation` also receive one immediate clean reattempt while staying
> `failed` and spending budget; no positive recovery evidence exists merely
> because that attempt was scheduled. A covered failure seals when
> `accumulatedFailureMs` reaches `MAX_EVENT_DELIVERY_FAILURE_BUDGET` (DRAFT
> value: 60 seconds). Attempt counts are observations, never the terminal
> predicate. On a budget wake, activation, restart, or lease handoff, the server
> evaluates current typed recovery state before the budget: a new positive
> signal receives its recovery retry; only an unchanged active failure may seal.
> The budget does not cancel an in-flight operation, but its upper bound on
> eventual automatic delivery is an explicit owner-approved exception to the
> repository's no-timeout rule.
>
> **DRAFT — pending owner ruling. Cross-space settlement.** Event preflight
> makes the handler's home-scheduler read closure current before dispatch. A
> pending foreign replica load parks the event and is settlement, not failure.
> Spaces run independent waves: a flush-deadline cut may move the pending event
> to a continuation home wave, and a foreign commit wakes the home scheduler;
> no wave nests another space's wave and no cross-space atomic commit is
> implied. Until a separately ruled target-side demand and coverage mechanism
> exists, a foreign read means the latest committed per-space value, not proof
> of foreign-space quiescence. A future mechanism for handlers whose correctness
> requires a current foreign derived value MUST leave the event pending until
> that explicit obligation is covered or fails; OW54 does not define that
> mechanism or charge its wait as delivery failure.
>
> **DRAFT — pending owner ruling. Where the notice lives.** The terminal cover
> is `{ consequenced: true, status: "needs-attention", reason, attention }` on
> the event's own stream entry. `attention` carries a stable phase, failure
> class, reason code, first/last failure times, and
> accumulated failed-state time, typed failed-head count, and
> `recovery: "explicit-retry"`; it carries no payload, credentials, cross-space
> document keys, or raw backend error. The commit writes the notice as that
> event's consequence, names the event in
> `consequenceOf`, and advances `eventWatermark` past it. `needs-attention` is a
> terminal kind beside T3 `dropped`, not a widening of T3 and not a claim that
> the handler ran.
>
> **DRAFT — pending owner ruling. Retention and client signal.** An unresolved
> `needs-attention` entry is excluded from stream compaction. The same
> non-derivable terminal contribution adds its reference and safe summary to
> the well-known per-space unresolved-attention index; the wave outcome must
> report that contribution committed before ordering releases. That index is
> for discovery and the entry remains authoritative. The client retires the
> speculative echo, emits a structured
> `needs-attention` outcome carrying that same complete client-safe `attention`
> object, and offers Retry and Dismiss. An authenticated Retry is one atomic
> same-space transaction: compare-and-swap the original from unresolved,
> append the same captured stream and payload under the original acting user's
> current authority with one new `eventId` and `retryOf: <originalEventId>`,
> record that ID as the original's resolution, and remove the index item. The
> server copies admission-verified `rendererTrusted` and
> `runtimeInjectedEventKeys` from the original entry; the request cannot supply
> or elevate them. The new `firedAt` names the requesting user's current
> session, never the expired original session, and a different user cannot use
> Retry to replay the captured payload. A concurrent or replayed request that
> loses the CAS appends nothing and returns the recorded retry ID. Dismiss
> atomically CASes the unresolved original to a dismissed resolution and
> removes the index item without an append. A resolved entry may compact under
> the ordinary watermark rule. Neither action reopens the original event ID,
> and clients never write processing fields directly.
>
> **DRAFT — pending owner ruling. Commit preparation.** A deterministic CFC
> policy verdict remains an immediate error consequence. A typed crash while
> preparing the commit is a pre-storage delivery failure and follows the same
> checkpoint, failed-state budget, `needs-attention`, and explicit-retry rules
> as a failed dispatch load. A typed pre-seal give-up or refused-wave
> `RowLabelCommitError` may join the `commit-finalization` phase only when the
> producer proves no consequence committed; an explicit handler abort becomes
> a handler error consequence rather than an infrastructure retry. An ambiguous
> storage-time or transport outcome is outside this retry rule.

### 9.4 serving-loop.md §3d — add after non-re-derivable writes

> **DRAFT — pending owner ruling. Terminal-notice release.** A processing
> checkpoint is an internal `bookkeeping`-stamped write. A terminal error,
> drop, or `needs-attention` notice is an `event-handler`-stamped
> non-re-derivable contribution carrying that event's consequence and watermark
> advance. Sealing that contribution into a wave is not durable success: the
> per-document rebase/refusal rules still apply. The serving loop MUST keep the
> event's arrival barrier closed until the wave outcome confirms that the
> complete terminal contribution committed. It MUST NOT run later events on the
> assumption that a merely sealed notice will commit. Same-wave release would
> require a separate rule withdrawing and requeueing every dependent later
> event whenever the earlier notice does not durably commit; this contract does
> not add that machinery.

### 9.5 serving-loop.md §7 — extend the events block

> **DRAFT — pending owner ruling.** `events.loadParkDeferrals` counts all
> load-park deferral decisions, including arrival-barrier followers;
> `loadParkFailures` counts only heads whose required load actually failed.
> `deliveryDeferralsActive`, `deliveryFailuresActive`, and
> `maxAccumulatedDeliveryFailureMs` expose the current checkpoint population
> without counting ordinary settlement as failure. `needsAttention` counts
> terminal attention notices after their wave commits, split by failure phase;
> `needsAttentionSealFailures` counts failed attempts to persist that cover;
> `deliveryCheckpointWriteFailures` counts failed processing-checkpoint writes;
> and `explicitRetries` counts accepted new-ID retry appends. `dropped` remains
> exclusive to events.md §5's T3 disposition and retains its legacy
> decision-time counting point; unlike `needsAttention`, a refused T3 notice may
> therefore be decided and counted again. Repeated failure attempts are
> counters; logs report state transitions rather than every retry.

### 9.6 verification-coverage.md — OW54 row amendment

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
> Two commit-finalization residuals are also open: proven-no-commit pre-seal
> give-ups and a refused-wave `RowLabelCommitError` both leave the durable entry
> unconsequenced and re-draining. #6378's served `RetryImmediately`
> name-resolution requeue is settlement inside the current settle and is not a
> member of any failure checkpoint.
>
> **DRAFT — pending owner ruling. Proposed close.** Distinguish an actually
> failing head from arrival-barrier followers; persist cumulative time in typed
> failed-state episodes; classify failures with typed producer data; spend
> budget while waiting without positive recovery evidence; pause after a
> recovery signal while its retry and dependency settlement make progress;
> retry on recovery epochs; and after the explicitly ratified failure budget,
> seal an entry-local `{ status: "needs-attention", consequenced: true }`
> notice. The notice is a
> new terminal kind beside T3 drop, occupies the event's arrival position,
> blocks later handlers until the wave outcome confirms its cover committed,
> stays
> uncompactable until Retry or Dismiss resolves it, is discoverable from a
> derived per-space unresolved-attention index, and reaches stats plus a
> client-visible attention surface. Retry atomically CASes the unresolved
> original, creates exactly one new event ID linked by `retryOf`, records that
> resolution, and removes the discovery item; the original never re-arms.
> Deterministic CFC verdicts remain immediate error consequences; typed
> commit-preparation crashes use the same
> bounded attention path as dispatch-load failures. Proven-no-commit
> commit-finalization failures are included only if the owner ratifies OQ-23;
> otherwise the register continues to name them as open and this row makes no
> every-entry-terminal closure claim. OPEN until the owner rules OQ-1 through
> OQ-24 in the design document and the later build lands with the flapping,
> checkpoint-write, seal-failure, order-release, provenance, client-reconnect,
> and exactly-once pins.

## 10. Owner ruling set

Nothing below is decided by this document.

1. **Predicate:** adopt hybrid typed class + health wake + cumulative durable
   failed-state time?
2. **Budget:** explicitly except this terminal-disposition budget from the
   repository's no-timeout rule and adopt 60 seconds of confirmed failed-state
   time, another constant, or deployment configuration—or reject automatic
   time-based terminalization?
3. **Classes:** require positive durable evidence before treating authorization
   or protocol as immediately terminal, default ambiguous unauthorized failures
   to recoverable, and ratify the remaining initial class split?
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
11. **Release point:** keep later handlers blocked until the notice wave commits,
    or add new §3d cross-entry withdrawal machinery to permit same-wave release?
12. **Re-arm:** retry only with one new event ID and `retryOf`, atomically CASed
    with original resolution and index removal so concurrent/replayed requests
    append nothing and return the recorded ID?
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
20. **Retry provenance and actor:** copy the original admission-verified
    `rendererTrusted` and `runtimeInjectedEventKeys` server-side, stamp the
    requesting current session, restrict Retry to the original acting user, and
    leave sessionless/system retry for a delegated-authority design?
21. **Process order:** preserve events.md §2's existing process-order sentence,
    add only the terminal-position rule, and reserve OW63's across-piece scope;
    or separately weaken the contract to outcome-commit order?
22. **Cold-view composition:** stop load-park failures from clearing the
    independent cold-view T3 count, so interleaving cannot defeat its
    eight-observation hardening bound?
23. **Commit-phase residuals:** include proven-no-commit
    `RowLabelCommitError` and typed pre-seal give-ups in the terminal-cover
    taxonomy, while leaving ambiguous outcomes outside replay?
24. **Checkpoint write failure:** fail closed when the processing checkpoint
    itself cannot commit—retain the event, count the failure, and inherit only
    committed age across tenure—rather than introducing a second authority?

The recommendations are the bold choices argued in §§4–9: adopt the hybrid
with OQ-2's explicit policy exception; preserve process order; wait for the
notice wave to commit; preserve verified retry provenance under the same acting
user; stop resetting the independent cold-view count; cover only
proven-no-commit commit-phase failures; and fail closed on an unpersistable
checkpoint. The 60-second failed-state budget is the least evidence-backed
recommendation and therefore the first one to replace if the owner has a
product latency target. Question 19's implementation remains a separate
currentness design rather than expanding the OW54 build.

## 11. Later build shape and blast radius

No file below is changed by this design pass. A later implementation train is
expected to touch these seams:

1. **Typed storage failure and recovery epoch** —
   `packages/runner/src/storage/interface.ts`, `storage/v2.ts`, and the memory-v2
   session/reconnect adapters. `loadsSettled()` must return a typed class and a
   recovery epoch or signal; message parsing in the scheduler is forbidden.
2. **Scheduler facade** — `packages/runner/src/scheduler/types.ts`,
   `scheduler/events.ts`, and `scheduler/facade.ts`. Split failed-head from
   arrival-barrier outcomes, carry typed failure data, keep client/LT1 behavior
   unchanged, and preserve #6378's served `RetryImmediately` carriage as
   settlement outside the checkpoint.
3. **Space-server drain state** —
   `packages/runner/src/executor/space-server.ts`. Persist failure-episode
   transitions as `bookkeeping`, count and fail closed on checkpoint-write
   failure, never erase spent budget on flapping epochs, stop load park from
   clearing the independent cold-view T3 count, terminalize only the failed
   head, keep settlement and followers budget-free, and release the barrier
   only after the notice wave reports the cover committed.
4. **Seal machinery** — the same `#sealEventConsequenceNotice` path plus wave
   outcome accounting. A resolved `{ error }` must be treated as seal failure;
   a notice rebased out or carried by a refused wave must also leave the barrier
   closed. Later handlers run only after a committed cover. This is the
   OW58-sensitive part of the build.
5. **Commit-preparation taxonomy** —
   `storage/extended-storage-transaction.ts`, `storage/rejection.ts`, and the
   scheduler's commit disposition. Replace the message-prefix conflation with
   a typed preparation-crash class, require positive durable evidence for an
   immediate authorization/protocol terminal, and—if OQ-23 is ratified—type the
   proven-no-commit pre-seal give-ups and `RowLabelCommitError` without widening
   to ambiguous outcomes.
6. **Durable schema, discovery, and compaction** — `packages/memory/v2.ts`,
   memory-v2 event admission/engine compaction, stream-entry validation, and a
   well-known per-space unresolved-attention index. Admit no client-supplied
   processing fields; retain unresolved attention entries; update the index in
   the same non-derivable terminal contribution and confirm that contribution
   through the wave outcome before release. Resolution uses a server-owned
   same-space CAS transaction that also appends the one retry when selected and
   removes the index item.
7. **Stats** — `packages/runner/src/executor/stats.ts`, health serialization,
   and serving-loop.md §7 after the owner ratifies the exact shape.
8. **Client absorption and UI** —
   `packages/runner/src/speculation/overlay-destination.ts`, runtime-client IPC,
   and the shell's persistent attention surface. The client outcome carries the
   complete authoritative safe field set. Retry submits authenticated current
   same-user authority to the atomic recovery path, receives server-copied
   admission provenance and a fresh current-session `firedAt`, and returns its
   recorded fresh ID on concurrent/replayed requests.
9. **Live contract and register** — events.md §2/§4/§5, serving-loop.md §3d/§7,
   and the OW54 row only after the implementation proves the ruled sentences.

The build should be separated into small, reversible PRs: typed taxonomy and
checkpoint; load-park predicate and seal; commit-preparation routing; client
retry/retention; then spec/register closure. The terminal ordering contract
must not ship half-present: the server may not step over until durable cover,
client absorption, and retention all exist.

## 12. Required verification for the later build

The later build is not complete without red-first, mutation-watched pins for:

1. a failed head accumulates the full failure budget while waiting without a
   positive recovery signal; a flapping session's signaled recovery attempts
   pause but never erase spent budget, each repeat failure resumes it, and
   exactly one attention notice commits;
2. a barrier follower never creates a checkpoint or terminalizes merely
   because the head does;
3. a fast session-revocation recovery before the budget is spent runs the
   handler exactly once and leaves no attention notice;
4. a timeout/unknown failure stops four-Hz polling while waiting for recovery
   or terminal failure-budget exhaustion;
5. a failed `bookkeeping` checkpoint write leaves the head and barrier pending,
   increments `deliveryCheckpointWriteFailures`, and never lets lease-local age
   survive a restart as though it had committed;
6. cold-view observations still reach T3 after eight such observations when
   load-park failures interleave, while load-park observations neither increment
   that count nor inherit it into the failed-state budget;
7. a notice that rejects, resolves `{ error }`, seals and is rebased out, or
   belongs to a refused wave leaves the head pending and prevents any later
   handler from running; a mutation that releases on seal rather than committed
   wave outcome must fail the pin;
8. a successfully committed notice occupies the earlier arrival position and
   later handlers then run and consequence in order;
9. the original terminal ID never runs again; concurrent Retry/Retry,
   Retry/Dismiss, and lost-response replay races produce at most one appended
   retry ID, return the recorded winner, atomically resolve/remove the index,
   run that ID at most once, and record `retryOf`; the new entry copies the
   original admission-verified `rendererTrusted` and
   `runtimeInjectedEventKeys`, rejects request-supplied elevation and
   cross-user Retry, and stamps the requesting current session;
10. reconnecting after terminalization still discovers an unresolved notice;
   compaction cannot retire it before resolution;
11. a current-ACL permanent denial and structurally invalid versioned protocol
    entry take the immediate path, while removing the positive-evidence bit or
    presenting #6365's revoked-session unauthorized shape defaults to a
    recoverable class;
12. deterministic CFC refusal remains an immediate error consequence while a
    typed preparation crash follows the bounded attention path and its first
    clean reattempt remains `failed` and spends budget;
13. if OQ-23 is ratified, `RowLabelCommitError` and each typed
    proven-no-commit pre-seal disposition reach their ruled terminal cover,
    while an ambiguous transport/storage outcome cannot be explicitly replayed;
14. #6378's served `RetryImmediately` keeps its served carriage, reruns in the
    current settle or durable-drain continuation, and never creates or ages a
    delivery checkpoint;
15. client-side and stream-entry-less LT1 events retain their existing
    behavior;
16. the terminal cover, runtime-client outcome, and persistent shell receive the
    same client-safe phase, class, code, first/last failure times, accumulated
    failure time, failure count, and recovery mode; stats distinguish barrier
    work, actual head failures, active failure time, committed notices, and
    failed checkpoint/notice writes without relying on log text, and the pin
    distinguishes `needsAttention` commit-time counting from `dropped`'s legacy
    decision-time count; and
17. a dirty event input whose recompute reads a foreign space spends no failure
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
- cross-user Retry and sessionless/system Retry without a separately ruled
  delegated authority (OQ-20);
- unless OQ-23 includes them, the OW54 build report's deterministic
  `RowLabelCommitError` and pre-seal non-CFC give-up families remain named open
  residuals rather than covered by the dispatch/preparation mechanism;
- target-side foreign-derived demand, coverage, cycle detection, and
  non-progress implementation (OQ-19's separate currentness design);
- cancellation or timeout of a never-settling storage promise; and
- replay of any failure whose storage outcome may be ambiguous.
