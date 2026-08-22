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
name the same result. These two facts decide the rules below.

## Two ways a registration ends

Two operations end a registration, and they carry different authority.

An explicit *stop* is authoritative over the result. It ends whatever
registration it finds, discards any lifetime the result holds, and reaches
starts that hold no registration yet: a start still resolving a link to this
result terminates when it resolves.

A *release* is authoritative over the registration its own launch installed,
and over nothing else. A pattern releases a child it launched when that
pattern is torn down, and a launch releases its own registration when the
transaction staging its setup does not become durable. A release leaves a
replacement registration alone, leaves a result that holds a lifetime of its
own running, and leaves a start it cannot see to settle on its own terms.
Pending commit-gated starts are the exception: a release cancels every one
held for the result, including one another launch scheduled, because a start
that has installed no registration yet offers nothing to tell launches apart
by.

Each rule below is one of these two authorities applied to a case.

## Releasing a child

A pattern that launches a child registers a *release* for it, which runs when
the launching pattern is torn down. A list coordinator releases a child
earlier than that: when the list no longer holds the element that child
belongs to. The child would otherwise run, and hold a result nothing reads,
for as long as the coordinator lives.

A release stops the child's registration only when both of these hold:

- The registration is the one this launch installed. A later attempt that
  replaced it owns itself, so a release that no longer recognizes what it
  finds does nothing.
- Nothing holds an independent lifetime for the result (below).

The second condition reaches only the starts a release can see. A start that
has not yet resolved its link to this result is indexed under no key the
release consults, so a release cannot tell that one is in flight. That
release proceeds: it ends the registration its own launch installed, and
leaves the start running. The start may go on to install a registration of
its own and claim a lifetime for it, by the rule below. A stop of the same
result instead terminates that start when it resolves.

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

The lifetime is claimed when the start settles, and only when its target is
still current at that moment: no stop has tombstoned the target for this
start or replaced the target's registration since this start discovered it.
A start whose target a stop superseded while it was resolving claims nothing:
any registration under the result's key belongs to whatever installed it
after the stop, not to this start. Such a start reports that it did not leave
the piece running. The judgment is about the target alone — a stop of an
intermediate link doc the start resolved through does not touch the target's
registration, so it voids neither the claim nor the report.

## Rolling back with the transaction

A run stages its setup in a transaction and installs its registration outside
one. When that transaction does not become durable, the launch releases its
registration: the piece would otherwise run against writes that never landed,
and the memo that decides whether to materialize it again would describe a
child that exists nowhere.

The rollback is a release rather than a stop, so it compensates the
registration this launch installed and reaches no further. A result someone
opened in its own right stays running, and a start still resolving is left to
settle against whatever state became durable.

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
later. Releasing the child cancels the pending starts held for that result
too, at the width the exception above describes. A launch whose child is
still gated holds that child through the pending start and nothing else, so a
release that passed it over would let the child start after the pattern that
launched it is gone.

The callback installs the registration while staging the start's own setup
transaction. If that transaction conflicts, the callback removes only the
registration it installed, waits for the conflict's `readyToRetry` catch-up
gate, and constructs the start once more against the fresh state. A stop or
release while the gate is pending prevents that reconstruction. A conflict
without a catch-up gate, a non-conflict failure, or a second conflict settles
the pending start without another attempt.
