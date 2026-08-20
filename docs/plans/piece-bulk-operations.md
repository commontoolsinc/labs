# Bulk piece operations

**Status:** proposed, unbuilt. The design and build sequence for changing
many pieces in one space as one reviewable, resumable operation. Driven by
recurring Topics board upgrades.

## The short version

**Three operations over many pieces share one spine and differ only in what
they apply.** Retargeting a piece's source, repairing its stored data, and
rolling either back are the same problem — select a set, record what each
piece looks like now, apply serially, verify, and resume from wherever it
stopped — with three different apply steps hanging off the end.

Building any one of them alone produces a tool that cannot become the other
two. Retarget is one source across many pieces; rollback is many pieces each
returning to a different recorded source; repair does not go through the
source path at all. A design that starts from "apply one source to a list of
pieces" has already excluded two thirds of the subject.

## The consumer

The Topics board is upgraded on a recurring basis, and every upgrade is a
bulk operation: a retarget of every topic piece plus the board that holds
them, ordered children-first. Around it sit the other two — a repair when an
upgrade exposes stored data that no current write path would produce, and a
rollback when one goes wrong under a quiet window.

That recurrence is the requirement. Tooling that is built when an upgrade is
already looming is tooling that gets its first real exercise during the
operation it is supposed to make safe. So the goal is not only that these
operations exist, but that they are **known to work before anyone needs
them** — which is what the drill below is for, and why it is a success
criterion rather than a nicety.

## The three operations

| | selects | applies | reverses with |
| --- | --- | --- | --- |
| **Retarget** | pieces on a given pattern, or an explicit list | one source package to every selected piece | rollback |
| **Repair** | pieces whose stored data matches a predicate | a change to each piece's own stored data | a second repair, or restore from an export |
| **Rollback** | pieces a plan previously moved | each piece's own recorded prior source | a second retarget |

They are one subject because the risky parts are identical: deciding what is
in scope, proving each piece is in the state you think it is, not losing your
place when the run stops, and telling afterwards whether it worked. They are
three operations because the write paths, the preconditions, and the
reversibility differ, and a tool that conflates them will get one of those
three wrong for two of the operations.

## The spine

```text
select → plan → check preconditions → apply serially → verify → resume
```

**Select** names the set. The selector is not assumed to be pattern identity:
it may be a pattern, a parent's membership array, a stored-data predicate, or
an explicit list. Identity is one selector among several, and treating it as
the axis is what makes a tool topic-shaped or migration-shaped instead of
general.

**Plan** freezes the selection into an artifact. See below.

**Check preconditions** proves, before touching anything, that every piece is
in the state the plan recorded. A piece that is not is reported and the run
does not start.

**Apply serially**, in plan order, stopping at the first failure. Serial is
not a limitation to be optimized away — a parent recomputing over children
mid-change is the failure this ordering exists to prevent.

**Verify** is a separate pass, never a side effect of applying. An apply that
exits zero is not a verdict: the source-update path reports success for a
piece whose source committed but whose running instance failed to refresh.

**Resume** re-derives what is outstanding on every invocation, so a stopped
run is continued by re-running the same command.

## The plan is the artifact

A plan is a list of rows, each naming a piece, the state it must be in, and
what to do to it:

```text
piece                          precondition                     operation
of:fid1:aaa…  pattern-identity=PB0Gum…   retarget=topic.tsx@<rev>
of:fid1:bbb…  pattern-identity=PB0Gum…   retarget=topic.tsx@<rev>
of:fid1:ccc…  stored.schema=true         repair=drop-property:schema
```

Four properties follow from making this a file rather than a command line:

- **Rollback is the same plan with two columns swapped.** The precondition
  becomes what the retarget produced; the operation becomes each piece's own
  recorded prior source. This is the property a one-source-many-pieces
  interface cannot have.
- **It is reviewable before it runs, and diffable before it runs again.** A
  plan generated against a clone and a plan generated against production
  should differ only in ways someone can explain.
- **It carries order.** Children before parents is a correctness constraint,
  not a preference, and it belongs in the artifact rather than in the
  operator's shell history where nothing can check it.
- **It is the record of what the pieces looked like beforehand**, which is
  what makes both resume and rollback possible.

The plan is produced by a command, not by a pipeline transcribed from a
runbook. A plan that has to be re-derived by hand for each operation is
re-derived differently each time.

## Resume is decided from recorded pre-state

A piece is outstanding when it still satisfies its recorded precondition.
Not when it differs from some target.

This distinction is what makes resume cheap and correct. "Does this piece
already run the source I am about to apply?" requires compiling the candidate
and still does not see the source transition, revision history, or repository
metadata the update path owns — so it cannot be answered honestly. "Has this
piece left the state the plan recorded for it?" is answerable by reading the
store, needs no compile and no candidate, and is exactly the question resume
has to answer.

The consequence is that resume costs one read per piece and is decided before
any write, which is why re-invoking a stopped run is safe and nearly free on
the pieces that already landed.

It also bounds what resume can claim. A piece that left its recorded state is
known to have moved; it is *not* thereby known to be healthy. Verification is
the separate pass for that, and no amount of pre-state checking substitutes.

## What a stop leaves behind

A run that stops has produced a partially changed space, and there is no
transaction to hide behind. So the stop is designed rather than incidental:

- Every piece that landed keeps its change.
- The pieces not attempted are written out **by name**, not counted, so the
  remainder is addressable without reconstructing it by hand.
- The failure is classified — a refusal about one piece, or the server having
  gone away — by a state check made *after* the failure. Never by a
  wall-clock probe before it: a healthy server here has been measured taking
  over a minute to answer while still completing writes, so a timeout would
  abort working runs.

Mid-run failure is expected, not exceptional. Resource exhaustion on a large
store is a known outcome, and the design assumes it.

## Where batching lives

Batching is an execution strategy under the apply step, not an operation and
not the subject. Two strategies exist:

- **A process per piece.** Simple, isolated, and pays session start-up,
  replica warm-up, and source resolution once per piece.
- **One session for many pieces.** Amortizes all of that. The source package
  is resolved and pinned once, and the linked-document warm-up is paid once
  because subsequent pieces meet an already-warm replica.

The second is worth having and is bounded by questions the first does not
raise: every updated piece stays running in the shared session for the rest
of the run, so memory and cross-piece interference scale with the batch, and
neither has been measured at the sizes that motivate it. A strategy that has
not been measured at its intended scale is not yet a strategy.

Whichever strategy applies, order stays serial and the spine above is
unchanged. That is the point of putting batching underneath it: the plan,
the preconditions, the stop behavior, and the verification do not change when
the execution strategy does.

## Building it

Five stages. Each one leaves something usable on its own, and the order is
chosen so that the next Topics upgrade is unblocked by the first two rather
than by all five.

### 1. The plan, and retarget

A command that produces a plan from a selector, and a driver that consumes
one: checks every row's precondition before writing, applies serially in plan
order, stops at the first failure naming the remainder by piece, and
recomputes what is outstanding on each invocation.

- [ ] A plan is generated from a selector and checked in as an artifact.
- [ ] Preconditions are proved for every row before the first write.
- [ ] A retarget of a seeded board runs to completion from a checked-in plan.
- [ ] A run interrupted partway is completed by re-invoking the same command,
      and the pieces that landed are not rewritten.
- [ ] A stopped run names every unattempted piece, not a count of them.

### 2. Verification as its own pass

A pass that reads every row's current state and reports it against what the
plan expected, exiting nonzero while anything is outstanding. It reports; it
does not repair.

- [ ] Verification is a separate invocation from application, and applying
      never implies it.
- [ ] The pass distinguishes "moved as planned", "still outstanding", and
      "moved to something the plan did not ask for".
- [ ] It composes with the existing space-level checks rather than replacing
      them; those remain the acceptance gate.

### 3. Rollback

The same plan read in the other direction — each row returning its piece to
the source the plan recorded for it.

- [ ] A completed retarget is fully reversed from its own plan, with no
      second artifact needed.
- [ ] Rollback checks preconditions the same way, so a piece changed by
      something else since the retarget stops the reversal rather than being
      overwritten.
- [ ] A rollback is itself resumable.

### 4. Repair

A predicate selector and an in-place data operation, which forces the
narrow-write decision below. The first case is data that no current write
path would produce, found on the oldest pieces of a board.

- [ ] A predicate selects pieces by stored data, not only by pattern.
- [ ] A repair changes what it names and demonstrably leaves the rest of each
      piece's stored document unchanged.
- [ ] Re-running a completed repair is a no-op, decided by the same
      precondition check.

### 5. Session reuse

An execution strategy under the apply step: one session serving many pieces,
so session start-up, replica warm-up, and source resolution are paid once.
Last, because it is an optimization over a spine that must exist first, and
because it is the only stage gated on measurement.

- [ ] Measured at the piece count a real board carries, not a sample of it —
      wall-clock, peak memory, and whether every piece completes.
- [ ] The spine is unchanged by the strategy: same plan, same preconditions,
      same stop behavior, same verification.
- [ ] A failure under the shared session degrades to the same stop report,
      with the same remainder named.

## The drill

Every stage above is finished by a drill that runs in continuous integration
against a seeded space, in the manner of the content-safety drill that
already guards export and restore: deploy a board, seed it, take the store
snapshot, run the operation, and assert the outcome.

The drill is what converts this design from documentation into a standing
guarantee. Its subject is the real pattern, so a change that breaks bulk
operations should break the drill, and the answer to "does the migration
tooling still work?" is a CI result rather than an expedition. Without it,
each upgrade re-discovers the tooling's condition at the moment it is least
affordable to.

An interrupted run is part of what the drill exercises, not an edge case
left to production: stopping a run midway and completing it by re-invocation
is the property most likely to rot silently, because nothing else exercises
it.

## Open decisions

Each is named with the stage that forces it, so none of them has to be
settled before work starts.

1. **How bulk is spelled** — *stage 1*. Whether the existing per-piece
   commands grow a repeatable target, or bulk operations get their own verb,
   decides whether the word for "one piece" stays consistent across the
   command surface. This interacts with
   [CLI surface shape](cli-surface-shape.md), and it is the first decision
   because every later stage inherits it.
2. **Where preconditions are evaluated** — *stage 1*. Reading a piece's
   current state from a store file is cheap and offline, but requires
   filesystem access to the space. The same question has to be answerable
   over the API for a space reached only that way. Whether both are
   supported, or one is canonical, is undecided.
3. **Scope of a compatibility override** — *stage 1*. An override that lets
   one refused piece through is a per-piece decision today. Applied to a
   plan, one flag covering every row turns many decisions into one, which is
   a different risk from the same flag used many times. Per-row or per-run is
   a real choice, not a detail.
4. **Whether repair gets a narrow write** — *stage 4*. Today the only write
   for stored data replaces a piece's whole input document, so "change one
   property" is a whole-document read-modify-write per piece. That is a large
   blast radius for a small change, and it is the same path that has been
   observed freezing a stale schema into a live board. Either repair gets a
   narrower primitive, or the design accepts the wide one and says why.
5. **Whether one session is viable at the sizes that motivate it** —
   *stage 5*, and open until measured.

## Out of scope, and where it goes

**What durable state answers "has this piece been migrated?"** The pre-state
check above answers "has it moved", which is enough for resume and rollback
and is deliberately all this design relies on. A stronger claim — that a
piece has been migrated, by a particular plan, to a particular source — would
need durable per-piece state that does not exist today, or an idempotence
property on the source-update path. Both are questions about piece semantics
rather than about tooling, and belong with whoever owns the piece source
transition rather than being settled here.

## Related

- [The space-clone rehearsal procedure](../development/space-clone-rehearsal.md)
  is the operating loop a bulk operation runs inside: clone, serve, verify,
  reset.
- [Topics board migration](topics-migration-rehearsal.md) is a worked
  instance of the retarget operation, with a manifest, an ordering, and a
  rollback record.
- [CLI surface shape](cli-surface-shape.md) governs the command vocabulary
  that decision 4 above would change.
