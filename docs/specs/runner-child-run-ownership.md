# Runner child-run ownership

> **Status**: Implemented; this spec governs the current behavior and is
> updated with it.
> **Companion**: [Scheduler v2](scheduler-v2/README.md) §7.6 defines the
> lineage rules for work an event handler launches. This document covers the
> children a pattern launches, which those rules do not reach.

Running a pattern produces a *registration*: the scheduler actions the runner
holds for that result cell, indexed by the result's key. Starting a result
installs one; stopping it removes and cancels one.

The registration is not part of any transaction. The writes a setup stages
roll back when its transaction fails; the registration does not. A result is
also reachable from more than one place: a nested pattern inside its parent, a
list element inside its coordinator, and a page the user navigated to can all
name the same result. These two facts decide the four rules below.

## Releasing a child

A pattern that launches a child registers a *release* for it, which runs when
the launching pattern is torn down. A release stops the child's registration
only when both of these hold:

- The registration is the one this launch installed. A later attempt that
  replaced it owns itself, so a release that no longer recognises what it
  finds does nothing.
- Nothing holds an independent lifetime for the result (below).

## Independent lifetimes

A result acquires a lifetime of its own when something starts it in its own
right rather than as part of an enclosing pattern — `Runner.start`. Navigating
to a nested result opens it as a page, which is the case this rule exists for.
An enclosing pattern releasing such a result leaves it running; only stopping
it directly ends it.

A start that is still resolving may be about to acquire that lifetime and
cannot say so yet, so a release declines while one is in flight. A start that
then fails leaves the result registered until the runtime stops it, the same
bound the scheduler accepts for a start that exhausts its retries.

## Rolling back with the transaction

A run stages its setup in a transaction and installs its registration outside
one. When that transaction does not become durable, the registration is
stopped: the piece would otherwise run against writes that never landed, and
the memo that decides whether to materialize it again would describe a child
that exists nowhere.

A stale basis is the exception. A conflict or a local inconsistency is
resolved by re-running the same work against fresher state, and that re-run
reuses what is already there. [Settle
outcomes](space-model/5-transactions.md) states the rule and names the
classifier that draws the line.

## Commit-gated starts

A start gated on a commit has no registration until its callback installs one.
Ownership of it begins when the start is scheduled, so stopping the result
before that commit tombstones the pending start and the callback does not
install it. Without this a piece the user stopped starts anyway, moments
later.
