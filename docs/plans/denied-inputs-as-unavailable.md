# Denied inputs as unavailable data

**Status:** proposed; no stage has started. Investigated against `main` at
`67dbfce051` (2026-10-15), with three open pull requests it builds on or
replaces: #4677 (explicit unavailable data flow), #8919 (client-executed
session documents stay local) and #8695 (the `localFold` flag). Paths are under
`packages/` unless they start with `docs/`.

**Summary.** A principal can read a space without being able to read every
space that space links to. A reactive computation that follows such a link
today reads an absence, indistinguishable from a document nobody wrote, and
computes a plausible value from incomplete information. That value disagrees
with what a principal who can see everything computes, and the two then fight:
through refused commits where the reader cannot write the output, and through
accepted ones where it can. This plan makes the read say what happened, as a
`FabricUnavailable` error, and makes the rule that follows from it explicit.

The contract, stated up front: **a value read that reaches a space the
principal has been refused returns an unavailable marker, not an absence; and
nothing computed from that marker is committed to shared state.**

## The problem

The shape is a principal holding READ on a space whose data links into a space
it cannot read. A Loom member whose roster lists a profile in someone else's
space is the case that surfaced it (#8244): the member's roster computation
builds a different label map from the owner's, because the profile reads as
absent.

What happens next depends on whether the reader may write the computation's
output.

- **The reader cannot write the output.** The space refuses the commit. The
  revert wakes the computation, which writes the same value and is refused
  again, until the scheduler's reactive retry budget is spent; each later
  change to an input buys another round. The local fold (#8329) keeps the
  refused write as the replica's own value instead, so the computation settles.
  #8695 puts the fold behind `localFold`, off by default.
- **The reader can write the output.** Its commits succeed, and every client
  that sees everything rewrites the output, which wakes the reader to rewrite
  it back. Only the scheduler's remote-echo breaker (#8587) bounds this, and it
  bounds it without settling it.

The two meet one computation downstream. A measurement on `main` plus #8695
had a reader derive a value in a space it can only read, and a second
computation copy that value, plus one, into a space both principals can write.
The owner ran the second computation as well.

| | Refused commits | Reader's writes downstream | Owner's writes downstream | Echo breaker |
| --- | --- | --- | --- | --- |
| Fold on | 1 | 13 | 13 | tripped |
| Fold off | 27 | 12 | 13 | tripped |

With the fold on, the reader's folded value feeds the downstream computation
as though it were confirmed, and the fight moves there. With it off, the
downstream computation reads the pending write before its refusal returns, and
a refused commit cascades only to dependent commits in its own space, so the
downstream commit in the other space lands anyway. Neither arm keeps a value
computed from incomplete information out of shared state.

## What the runtime does today

### A denied read and an absent one are the same read

A client read two targets through links in a space it can read: a document in
a space it holds no grant on, and a document nobody wrote.

| What the computation reads | Denied space | Missing document |
| --- | --- | --- |
| The cell's value | `undefined` | `undefined` |
| The raw value | `NotFoundError` | `NotFoundError` |
| The raw document | empty, no error | empty, no error |

This is deliberate. The storage interface says that a denied cross-space link
"stays a silent absent read" (`runner/src/storage/interface.ts`, the
`authorizationError()` doc comment).

### The verdict exists, per space

ACLs are per space, and `session.open` requires READ, so a principal refused a
space learns it once, when the session is refused, before any document is
read. The storage manager keeps the verdict: `spaceAccessError(space)` returns
it, `subscribeSpaceAccessChange()` reports denial and readmission, and
`retrySpaceAccess()` asks again and repeats the failed loads on admission. A
space with no ACL is not a denial: outside the memory server's explicit-ACL
mode, such a space is open to every authenticated principal.

Pattern code already reaches the verdict through `spaceAccess(target)`
(`docs/features/space-access.md`), which returns `"none"` on a client the
server has refused the space for good. Its implementation registers the running
action with `runtime.spaceAccessWatch` so a refusal or readmission runs it
again, and it narrows the computation's read scope to `user`, a narrowing that
carries downstream to every computation reading its value.

One path already refuses rather than reading silently: a served handler under
server execution that reads the value of a document in a refused space fails
permanently (#8585, `docs/specs/server-side-execution/events.md` §5). Reactive
computations on a client do not.

### Unavailable data

`FabricUnavailable` is on `main` (`data-model/src/api.ts`): reasons `pending`,
`syncing` and `error`, and for `error` a closed set of kinds, `general`,
`schemaMismatch`, `invalidInput`, `network`, `decode`, `compile`, `provider`
and `sync`. None of them says "denied".

#4677 adds the propagation contract (`docs/specs/data-unavailability.md` on its
branch). Before a computation runs, its inputs are walked; an unavailable input
the computation did not opt into is **written to the computation's output**,
and the implementation is not called. A computation opts in to a reason with a
guard such as `hasError()`. A value not yet locally available reads as
`syncing`. A linked document whose load failed becomes an `error` of kind
`sync`, but only where the argument's schema refuses the absence: an optional
link into a refused space still materializes as `undefined`, and the
computation runs on it.

### Parking a run whose input is not available

`main` already disposes of a run without committing it when its input is not
available, for speculative transactions restricted to local reads
(`runner/src/storage/local-read-policy.ts`). `parkUnavailableRun()` in
`runner/src/scheduler/run.ts` aborts the transaction, marks the node
`unavailable`, and wakes it when the input becomes available.

### Session documents that stay local

#8919 keeps session-scoped documents in the client's local replica when server
execution is off: their reads and writes never reach the server.

## Design

### 1. The read says it was denied

A value read whose target lies in a space classifies by that space's state.

| The target space | The read returns |
| --- | --- |
| open, document absent | absent, as today |
| not yet answered, or refused with a retriable denial | `syncing` |
| refused permanently | `error`, of a new kind `access` |

The check sits at the transaction's value read, the boundary #4677 already
uses for an unavailable ancestor (`runner/src/storage/read-availability.ts` on
its branch), so the read policy and CFC checks run first as they do for any
read. It consults the storage manager's per-space verdict only when the replica
holds no record for the document, which keeps it off the path of every
ordinary read.

The marker's message is fixed text saying the space is not readable by the
current principal. It names no document, so it reveals nothing the refused
session has not already told the client.

A read that returns the `access` marker registers the running action with
`runtime.spaceAccessWatch`, as `spaceAccess()` does, so a readmission runs it
again and it reads the document then.

`access` rather than `sync`: a reconnect or a retry does not change a denial,
and a grant does. A pattern that tells the person "you can't see this" needs to
tell it apart from "this failed to load".

### 2. Propagation follows #4677

An `access` marker is an `error`, so #4677's preflight propagates it like any
other. A computation that does not guard for errors is not called. One that
guards with `hasError()` runs and sees the marker.

### 3. Nothing computed from a denial is shared

#4677 writes a propagated marker to the output, which is correct for the
markers it was designed around: a fetch that failed failed for everyone, so
every principal computes the same marker. An `access` marker differs by
principal. Written to a shared document, it overwrites the value a principal
who can read the space computed, and the fight this plan exists to end starts
again. So a run whose transaction read an `access` marker is principal-relative,
and its writes are not committed to shared state.

- **A propagating run parks.** The callback was not called, so there is nothing
  of its own to write. The run is disposed of through `parkUnavailableRun()`,
  marked `unavailable`, and woken by `spaceAccessWatch`. The output keeps
  whatever the store holds, which is the value computed by a principal who can
  see every input. The reader's downstream computations read that value, so
  they agree with everyone else's.
- **An observing run writes to a session-scoped output.** A computation that
  guarded the marker produced something for this principal only, such as a
  "not visible to you" row. Its read scope narrows to `session`, as
  `spaceAccess()` narrows to `user`, and the narrowing carries downstream. With
  #8919, a session document on a client stays in the local replica, so the
  value is shown and never committed. `user` scope is not enough: a per-user
  instance in a space the reader can only read is still refused.

The transaction latches the fact that a read returned an `access` marker, as
the local read policy latches its failure, and the commit path checks the latch,
so a body that catches or discards the marker cannot commit what it built on
it.

### 4. The local fold retires

Once the read says it was denied and nothing computed from that is committed,
a refused derived write no longer arises from incomplete information. What is
left is a reader that sees every input and still computes a different value,
which is a determinism bug in the computation rather than an access question,
and the reactive retry budget is the right bound for it. `localFold`, the fold
machinery in `runner/src/storage/v2.ts` (`#foldRefusedWrite()`, the
whole-document conversion and its added reads, the `localFold` marker on a
confirmed version), the `derivedWrites` transaction flag and §3.8.3 of
`docs/specs/memory-v2/03-commit-model.md` go together. #8334's model of local
folds is rescoped or closed.

## Stages

1. **The `access` error kind.** Add it to `UnavailableErrorKind` and the
   tables in `data-model/src/fabric-primitives/FabricUnavailable.ts`, with its
   default message and its conformance fixture. Independent of everything else.
2. **Classify the read** (section 1), behind an experimental flag registered in
   `docs/development/EXPERIMENTAL_OPTIONS.md`. Sequenced after #4677: without its
   preflight, a computation would receive the marker as an ordinary value.
3. **Park and narrow** (section 3). Parking needs only `main`; the
   session-scoped output needs #8919.
4. **The Loom roster** guards its members' profiles and shows a member whose
   profile the viewer cannot read as one, rather than dropping it from the label
   map.
5. **Turn the flag on**, soak, then retire the fold (section 4) and the flag.

## Tests

- The denied-versus-absent read, at every level in the table above, returns
  absent for a missing document in an open space, `syncing` before a refused
  space answers, and the `access` error after.
- A grant after a denial runs the computation again and it reads the document;
  a revocation while it runs parks it.
- The two-computation measurement above, with this design on, shows no refused
  commits, no downstream writes by the reader, and no breaker trip, and the
  reader's downstream value equals the owner's.
- A computation that catches the marker inside its body and writes anyway
  commits nothing.
- `toolshed/test/loom-cold-reader.test.ts` counts no refused pushes from the
  READ viewer.
- A serving runtime reads every space as its owner, so it never sees an
  `access` marker; a served run's outputs are unchanged.

## Open questions

- **Server execution on.** #8919 keeps session documents synchronized under
  server execution, so an observing run on a client has no local-only output
  there. Served runs read as the owner and never see the marker, which may make
  the client's own run moot under that posture; that needs confirming against
  how a client speculates.
- **A refusal inside a readable space.** CFC can withhold a value inside a
  document the principal may read. That value is principal-relative in the same
  way, and the same rule could apply to it. It is outside this plan, and any
  change there goes through the CFC specification first
  (`docs/development/cfc-spec-correspondence.md`).
- **The owner's value as seen by the reader.** Parking leaves the reader
  looking at the stored value, which was computed from the inputs the reader
  could not read. That document is in a space the reader may read, and its CFC
  labels govern what renders, as they do today. This plan changes neither.
- **Patterns that default a missing link.** A `?? fallback` over a link into a
  refused space now meets a marker instead of `undefined`. #4677's migration
  hazard applies to it, and the patterns that do this need finding before the
  flag turns on.
