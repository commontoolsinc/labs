# Committed-write backpressure

How the scheduler keeps a committed write from being silently dropped when the
server rejects it under contention.

## The problem

The runtime is local-first and optimistic. When an event handler writes, the
write is applied to local replicated memory immediately and the transaction is
committed to the server in the background. The handler does not wait for the
server. The server can still reject the commit, most often with a per-entity
basis-sequence conflict: another writer advanced the entity's sequence between
the time this commit read its basis and the time it reached the server. On
rejection the optimistic write is rolled back (a "revert") and the originating
event is re-run.

The re-run used to have a fixed budget. An event handler retried five times
(`DEFAULT_RETRIES_FOR_EVENTS`) and then gave up: it logged "Event handler
transaction failed after exhausting all retries" and dropped the write. Nothing
surfaced to the user.

Under sustained contention that budget is exhausted before the contention
clears. The concrete case that motivated this work: profile appends issued while
the home space rehydrates. Loading a home that already has profiles produces a
burst of basis-sequence conflicts as reactive rehydration commits churn the home
entity. A profile append targeting the same entity loses the race over and over,
runs out of its five retries in a few milliseconds, and is dropped. Creating
three profiles left a durable count of one. "Drops data under load" is a
correctness cliff, not graceful degradation.

## The principle

A committed write that represents real user intent must converge or fail loudly.
It must never vanish. Under contention the system should get slower, not lossy.

That requires separating two kinds of rejection that the old fixed budget
treated the same:

- A **transient stale-basis conflict** (`ConflictError`). Re-running the handler
  against fresh confirmed state and committing again can succeed. These are
  exactly the rejections that a contention burst produces, and the ones that
  must keep being retried until they land.
- A **permanent precondition failure** (`PreconditionFailedError` —
  `receipt-exists`, `origin-committed`). Re-running can never succeed and must
  not happen. `receipt-exists` means the event was already durably handled by a
  prior delivery (idempotent dedup); `origin-committed` means the event's origin
  lineage did not commit, so the descendant must not apply.

A third group — handler-initiated aborts and system errors — are transient in
the sense that they are not permanent precondition failures, but they are not
contention either, so retrying harder does not help them.

## The model

The event-handler commit path classifies each commit result and acts on it
(`packages/runner/src/scheduler/events.ts`, `classifyCommitDisposition`):

- **Success** — done.
- **Stale-basis `ConflictError`** — the backpressure path. The event is
  re-queued for a later retry, parked via the existing `notBefore` mechanism with
  a capped exponential backoff plus jitter (`scheduler/backpressure.ts`,
  `computeBackoffDelayMs`). Backoff makes the scheduler slow down under
  contention instead of busy-looping; jitter keeps concurrent writers contending
  for the same entity from retrying in lockstep. The event keeps retrying for a
  bounded window (default 30 seconds), measured from the first conflict, which is
  long enough to outlast a rehydration burst. `idle()` and `settled()` already
  wait for a parked head event, so a write that converges still completes within
  a settle.
- **Window elapsed without converging** — a terminal `CommitConvergenceError` is
  surfaced through the scheduler error channel (`scheduler.onError`). The write
  fails loudly rather than disappearing. This is the bounded-resource backstop:
  if a conflict genuinely never clears, the system does not retry forever, it
  reports.
- **Permanent rejection** — never retried, exactly as before, and still
  observable through the `scheduler.event.commit` telemetry marker
  (`permanentRejection`).
- **Any other transient error** (abort, system error) — keeps the fixed
  `retriesLeft` budget and the previous retry-then-stop behavior. Backpressure
  would not help a handler that aborts itself, and retrying it within the window
  would loop pointlessly.

### Resource bounds

Backoff caps the retry *rate* (one parked timer per intent, capped delay), and
the window caps the total *duration*. Together they bound the work a single
contended write can generate to roughly tens of attempts over the window, not a
busy loop. The event queue still holds one entry per intent; a backoff retry
re-queues that same entry in place rather than fanning out.

### Event-queue ordering

The scheduler processes the event queue strictly head-first, and a parked event
(`notBefore` in the future) holds the head until its timer fires — this is the
same behavior the existing dirty-dependency throttle already relies on. A backoff
retry is parked at the head, so while a contended write is backing off, events
queued behind it wait. Under a transient storm (which clears in well under a
second) this is imperceptible. The visible effect is only on a write that keeps
conflicting for seconds: event processing behind it slows until the write either
lands or the retry window elapses and it fails terminally. That is the intended
backpressure — the system gets slower under sustained contention rather than
losing the write. `maxDelayMs` bounds how long any single backoff step holds the
head.

### Idempotency

Retrying re-runs the same event with the same durable event id. The memory
engine's receipt machinery makes a re-delivery of an already-applied event a
permanent `receipt-exists` rejection, so a retry cannot double-apply. A retry
only happens after a rejection, where the optimistic write was reverted, so the
re-run reads fresh confirmed state (including profiles that landed in the
meantime) and reconciles — which is why three concurrent appends converge to a
list of three rather than clobbering each other.

### The `retries: 0` opt-out

`queueEvent`'s `retries` argument now gates whether conflicts are retried at all,
rather than bounding how many times. The default (`DEFAULT_RETRIES_FOR_EVENTS`,
used by every real user event through `cell.send`) is positive, so user events
get backpressure. A caller that sends with `retries: 0` — a speculative lineage
origin, an internal one-shot — opts out: a conflict gives up immediately, so a
descendant of a failed origin still drops deterministically. The exact positive
count no longer bounds conflict retries; the window does.

## Configuration

`RuntimeOptions.commitBackpressure` tunes the policy
(`scheduler/backpressure.ts`, `CommitBackpressurePolicy`): `baseDelayMs`,
`maxDelayMs`, `jitter`, `retryWindowMs`. Unset fields fall back to
`DEFAULT_COMMIT_BACKPRESSURE` and every field is clamped to a sane range, so a
caller-supplied policy can never disable backpressure (a zero window would
reintroduce silent drops). Tests use it to shrink the window and backoff.

## Observability

The `scheduler.event.commit` telemetry marker carries the new state:
`retryAttempt` and `backoffMs` on a backoff retry, and `terminal`
(`"permanent"` | `"convergence"`) when a commit reaches a terminal outcome.
A non-converging write also logs `commit-convergence-failed` and is delivered to
registered `scheduler.onError` handlers as a `CommitConvergenceError`.

## The reactive-action path

The reactive path (`scheduler/action-run.ts`) does not need this backpressure
and shares only the `isConflictRejection` classifier. A reactive action is a
re-derivation: its output is a function of its inputs. On a conflict it does not
retry at all — the write that caused the conflict dirtied the action's
still-subscribed reads, so reader-dirty propagation re-runs it with the latest
state. A conflict there is a wait, not a retry, and consumes no budget. Only
non-conflict transient errors fall back to the bounded `MAX_RETRIES_FOR_REACTIVE`
retry, and every attempt re-subscribes so the action recovers when its inputs
next change. The backpressure rework targets the event-handler path instead,
where a one-shot write *is* the user's intent and has no later input change to
recover it, so a conflict must be actively retried rather than waited out.

## Tests

- `packages/runner/test/scheduler-commit-backpressure.test.ts` — the validation
  of record. It drives the event-handler commit path against an emulated server
  that rejects commits on demand: a burst of transient conflicts longer than the
  old budget still lands; a permanent rejection is not retried and stays
  observable; a never-converging conflict surfaces a terminal error within the
  window with bounded attempts; and three whole-array appends
  (`list = [...list, value]`, the profile-append shape) survive a conflict storm
  so the durable count reaches three. This deterministically reproduces the
  silent-loss bug and proves the fix.
- `packages/runner/test/scheduler-event-lineage.test.ts` — adapted so a
  permanently failed origin is modeled without relying on budget exhaustion; it
  exercises the give-up (`retries: 0`) and terminal-convergence paths.
- `packages/patterns/integration/home-profile.test.ts` — unchanged browser-level
  profile-creation regression coverage; still passes (the fix does not regress
  the normal cross-space append).

## Reproduction status in this codebase

The motivating instance — profile appends swallowed by a rehydration conflict
storm, leaving a durable count of one — was confirmed in an earlier copy where
loading a home with existing profiles produced about nineteen basis-sequence
conflicts. In the current copy that storm is much milder: rehydrating a home
with a profile produces only a few reactive-commit conflicts, and they clear
before a profile append is issued, so the append's event commit does not hit a
conflict at all. A browser count-probe driven against this copy therefore does
not exercise the backpressure path (no event-handler conflict, no backoff), so
it cannot validate the fix end-to-end here, and any residual count discrepancy
under idle-only waits comes from cross-space rehydration timing rather than the
conflict-exhaustion this change addresses. The fix is validated instead at the
runner level, where the conflict storm is injected deterministically and the
committed write is shown to converge rather than drop.
