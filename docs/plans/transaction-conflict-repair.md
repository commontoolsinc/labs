# Transaction conflict repair

Status: proposed design; implementation pending.

## Decision

Memory conflict recovery must deliver a rejected transaction's document
dependencies even when the application's graph watches cannot reach them.
Successful writes retain their optimistic path. Recovery creates temporary,
explicit document coverage owned by the operation that will consume the repair.

The correctness contract is:

> Successful repair readiness means that the receiving replica has installed
> authoritative bases for the rejected transaction's document footprint, sampled
> at a server cut at or after rejection, and that recovery keeps those bases
> covered until its owner finishes or cancels.

A transaction must be rebuilt against those bases. Repair does not change the
read versions of a transaction computed from stale data.

The acceptance fixture seeds a space output pointing to another space document
and an existing user instance of the output. A fresh runtime loads the space
output, then attempts to write the computed result into its user instance and
restore the space-to-user redirect atomically. The unseen user instance produces
a stale sequence-0 read. Awaited conflict repair must make the next freshly
computed transaction succeed without an explicit user sync.

The fixture belongs in `packages/runner/test/scoped-output-restoration.test.ts`
when the recovery implementation is added. This plan proposes behavior; it does
not report a passing implementation or a measured performance improvement.

## 1. Separate the three kinds of state

| State             | Purpose                                                             | Owner and lifetime                                         |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Graph watches     | Select live application data and establish execution demand.        | Application subscriptions.                                 |
| Repair coverage   | Keep the authoritative document bases needed by recovery available. | A recovery operation, through consumption or cancellation. |
| Delivery holdings | Describe the document versions the replica actually absorbed.       | The replica; declared when reconnecting.                   |

Repair coverage contributes to synchronization, but not to execution demand.
Holding a document does not by itself make that document application demand.

These distinctions have concrete implementation consequences:

- `SessionState.entities` can remain the delivery diff base for the union of
  graph and repair coverage. Execution demand must then be derived from graph
  provenance rather than from every entry in that delivery map.
- A document remains covered while either an ordinary watch or any active
  recovery owns it. Removing one owner cannot evict another owner's basis.
- `session.watch.set` replaces ordinary watches only. A request prepared before
  a conflict must not erase the conflict's independently owned repair coverage.
- Repair coverage uses direct document snapshots. Naming a normal graph root
  entails loading its metadata family; that is an execution-oriented contract
  and is too broad for repairing a transaction's previous-value reads.

The memory query specification's
[metadata-family rules](../specs/memory-v2/05-queries.md) and the server's
`demandedInstancesForSpace()` are the places to preserve this separation.

## 2. Addresses and the repair footprint

One repair belongs to one memory session and one rejected `localSeq`. Its
identity is the pair `(sessionId, localSeq)`; it is not a server-log sequence.
Repeated delivery or replay of the same rejected submission identifies the same
repair. Distinct rejected attempts have distinct repair identities.

The document footprint is the deduplicated union of:

1. `reads.confirmed` addresses;
2. `reads.pending` addresses;
3. document operation targets.

Each internal address contains space, branch, entity ID, scope, and resolved
scope instance. Confirmed reads use their explicitly named branch or the commit
branch; pending reads and operation targets use the commit branch. Scope
resolution must share the transaction validator's rules. An unresolvable scope
is a failure to repair, not permission to substitute a different instance.

The wire uses the ordinary recipient's scope vocabulary. Explicit foreign
instance keys remain subject to the existing lease-holder read authorization.
The acting principal used for delegated READ authority must not replace the
envelope identity used to resolve a transaction's user or session instance.

Paths determine conflict validation, but repair installs full document bases.
Deduplicate paths to document addresses only after validating their address
fields. Reads of outputs marked `ignoreReadForScheduling` remain in this
footprint: scheduling and commit validation have different dependency sets.

A SQLite operation has no JSON document target to manufacture. Its declared
document dependencies still participate. A conflict requiring non-document
repair needs an explicit recovery mechanism for that dependency kind; an empty
JSON footprint must not be called a successful repair of such a conflict.

A shared, browser-safe footprint builder belongs with memory's protocol types.
Both server staging and client reconnect declarations must use it. Recovery must
not parse an entity ID out of an error message.

The memory protocol's branch support does not require adding general branch
support to the runner's default-branch replica in this change. Receipt
validation must reject an address that its consumer cannot represent, rather
than allowing a same-ID default-branch record to satisfy it. Cross-branch
coverage is tested at the memory layer as well as at any consumer that supports
those branches.

## 3. Recovery ownership

The local recovery handle has two operations: await readiness, and release
ownership. Release is idempotent. The handle is attached to a server conflict
and propagated through the storage rejection adapter. `readyToRetry()` can
delegate to its readiness operation while callers migrate.

The runtime, rather than pattern authors, owns these handles. Low-level memory
callers that manage their own retries must explicitly release a recovery after
using it or deciding not to retry. Their documented helper should bracket the
recovery callback with release on every exit. Session close is the final cleanup
boundary, not the routine way to release a completed recovery.

| State     | Transition and obligations                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Waiting   | The verdict is a conflict. The server owes a complete repair; the client retains its footprint and waits for application of the repair.                            |
| Ready     | The replica has applied a complete repair at a sufficiently recent cut. Its owner may rebuild the operation; coverage stays live.                                  |
| Consuming | The rebuilt operation is running or settling. Keep the coverage through its completion, including a vacuous successful transaction.                                |
| Replaced  | A further conflict supplies another handle. Keep the earlier coverage until the next repair is installed and ownership transfers, then release the earlier handle. |
| Released  | The operation succeeded, gave up, was superseded, or was canceled. Remove this ownership and eventually retract documents with no remaining owner.                 |
| Failed    | Repair cannot satisfy its contract. Surface a typed failure, release ownership, and do not report successful readiness.                                            |

Transport disconnection suspends Waiting, Ready, or Consuming; it does not
release ownership. A change of logical scope identity invalidates the handle
instead of remapping its addresses to another user's or session's documents.

Readiness is a check of the current replica generation, not one permanently
resolved promise. If the replica loses its installed bases, invalidate the
receipt and return the handle to Waiting. A consuming transaction from the
discarded generation must abort and rebuild after rehydration. An ordinary
disconnect that preserves the replica does not discard its authoritative bases.

Cancellation can precede the verdict. Retain the cancellation disposition with
the outstanding submission until the verdict is processed; if a conflict then
arrives, release its repair instead of reviving a canceled operation. A late
receipt for a released repair may carry useful ordinary data, but cannot revive
the handle or schedule a retry.

If dependent local rejections share a repair, local handles share ownership with
reference counting. One consumer cannot release a basis another consumer still
needs. Purely local inconsistency or preemption does not create a new server
repair merely because it uses the same rejection classification.

No timer determines successful readiness or ownership expiry. Pending repairs
remain bounded by active recovery operations, with explicit resource failure if
the implementation's memory limit is exceeded. Resource pressure must not
silently discard an owned basis.

## 4. Protocol changes

Use a negotiated capability, provisionally `transactionRepairV1`. The names
below are proposed wire fields, not existing exports.

| Surface           | Proposed addition | Meaning                                                                                                                                                       |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conflict response | `repair.localSeq` | Identifies the repair staged from this rejected submission. Carries no document values.                                                                       |
| `SessionSync`     | `repairs`         | Complete repair receipts, each naming a `localSeq`, a server cut `atSeq`, and document address/version requirements. Values travel in the ordinary `upserts`. |
| `SessionSync`     | `repairFailures`  | Typed, per-repair failures when the server cannot assemble a valid repair.                                                                                    |
| `session.ack`     | `releaseRepairs`  | An explicit array of completed or canceled repair identities to release. This is independent of `seenSeq`.                                                    |
| `session.open`    | `repairs`         | The client's complete active recovery declarations, including the footprints of submissions whose verdicts remain unknown.                                    |

### Complete repair receipt

Each receipt lists the full document footprint and the authoritative version of
each address at `atSeq`, including a deletion marker when applicable. A
never-created document is represented explicitly with sequence 0 and absence; an
existing tombstone carries its actual revision. Membership is exact: a receipt
that omits a required scope instance cannot complete readiness.

The client already has the failed submission, so it validates membership against
the shared footprint builder. The receipt carries version requirements so the
replica can distinguish actually installed data from a transport-level marker.
Schema documents required to interpret delivered snapshots must also be verified
and available before the receipt completes.

For the first delivery of a repair, send authoritative snapshots for its whole
footprint, deduplicated with the same frame's ordinary upserts. Do not elide
them solely because the server's delivery cache says they were sent. Reconnect
may elide a snapshot against declared, actually absorbed holdings, provided the
client can still satisfy the receipt from those holdings.

A newer authoritative local base can satisfy an older version requirement. A
pending optimistic overlay or a sequence number without its corresponding
authoritative value cannot. Exact accepted writes may qualify through the
existing accepted-write promotion rules; speculative values do not.

### Two completion conditions, without a second acknowledgement clock

`caughtUpLocalSeq` continues to order verdict application and accepted-write
promotion. It must not by itself complete a negotiated conflict repair. Conflict
readiness additionally requires the matching receipt to have been applied by the
replica, with `atSeq >= retryAfterSeq` for that rejection. Both values in that
comparison are server-log sequences from the same store epoch.

Explicit release discharges ownership after consumption; a separate cumulative
"repair acknowledged through" clock is unnecessary. Releases name exact repairs
because unrelated recoveries can finish out of order.

An acknowledgement containing releases must be sent even when `seenSeq` has not
advanced. A lost acknowledgement is harmless: retrying release is idempotent,
and the complete declaration on the next open omits locally released repairs.
Release is cleanup; it need not add an awaited round trip to a successful retry.

Ordinary watch mutations do not carry replacement repair declarations. This
avoids an in-flight watch request canceling a repair it could not yet know
about.

### Failure receipt

An unreadable branch, revoked authorization, corrupt schema closure, or
unrepresentable required instance produces an explicit failure for the repair.
Do not send a partial receipt claiming success. Unrelated valid sync work may
continue under its own contract.

The client preserves the original conflict as the cause of a typed recovery
failure. A rejected readiness promise is not converted into unconditional
resubmission. Connection recovery waits for the session's actual restoration
event; terminal failure stops that attempt until an appropriate external change
or explicit retry.

All wire parsers, response-error adapters, schema-table encoding, and session
frame forwarding must preserve these additions. `isEmptySync()` must treat a
receipt-only or failure-only frame as nonempty. A test must exercise this
through the actual transport and the runner's frame consumer, not only a
constructed receipt passed directly to the validator.

## 5. Server synchronization

Introduce a small repair component rather than adding separate ad hoc branches
to every early return in `syncSessionForConnection()`.

Its responsibilities are footprint ownership, direct snapshot assembly, receipt
construction, release, and reconnect declaration. It has no access to the
scheduler or pattern-binding machinery.

On a server conflict, while holding the existing per-space publication lock:

1. Register the repair footprint under the rejected session and `localSeq`.
2. Stage its receipt obligation and the existing verdict catch-up obligation.
3. Publish the conflict response before the corresponding live repair frame.
4. Let the existing batched fan-out deliver the repair.

For each fan-out pass:

1. Evaluate ordinary watched updates and any required repair snapshots at the
   same server cut, with the existing authorization and session-ownership
   checks.
2. Assemble the union once. A repair-only document uses `Engine.readState()` or
   the shared snapshot assembler, preserving its actual version and tombstone.
3. Add and validate the transitive schema-document closure. Reuse the closure
   assembly used by query delivery; do not duplicate schema interpretation.
4. Build ordinary upserts/removes and complete repair receipts. A remove is
   permitted only when neither watch nor repair ownership retains the address.
5. Commit delivery bookkeeping only when the complete frame is constructible.

Repair assembly does not recursively load ordinary value links, a piece's
pattern/argument/internal metadata family, or a whole space. It delivers the
explicit footprint and the schema closure needed to interpret it. If rebuilding
the transaction discovers another ordinary data dependency, the normal read
machinery handles that dependency. Further conflicts on newly discovered
dependencies do not violate the contract.

Coverage remains live until release, so dirty changes to a retained repair
document can update its basis during recovery. Maintain repair wake keys
separately from graph demand keys. Ordinary execution-demand enumerators and
callbacks must use graph provenance; they must not infer demand from the union
delivery map.

Both the incremental and full-evaluation paths, including no-watch sessions,
must compose through the same repair assembly. A full refresh cannot retract a
repair-only document. Failed-send rollback restages receipt delivery without
dropping coverage. Replay of a rejected submission restages its complete receipt
idempotently, even if the server remembers sending it already.

Release itself schedules the coverage diff, including when there are no normal
watches or subsequent commits. It must not require unrelated traffic to reclaim
repair-only state. Resume and release composition use the same per-space
publication ordering as fan-out; any awaited authorization or engine-open step
precedes the snapshot cut and is followed by the ordinary session-owner check.

Multiple repairs share document snapshots and schema closure in one frame. They
retain separate completion identities and ownership. Processing a later repair
cannot declare an earlier incomplete repair complete through a maximum counter.

## 6. Replica application and reconnect

The storage replica applies a repair-bearing frame in this order:

1. Decode and validate the frame and its schema closure.
2. Apply authoritative upserts/removes under the normal monotonic-version and
   optimistic-overlay rules.
3. Check each repair receipt against its expected footprint and installed
   authoritative bases.
4. Complete only the satisfied repair waiters. Apply ordinary verdict markers
   according to their existing accepted-write semantics.
5. Finalize rejection rollback and schedule the owning operation's fresh run.

In particular, the replica must not quarantine a required document and then
complete the repair from the frame's marker. A receipt also must not reach the
memory client and release a runner waiter before the runner consumes the frame.
The two existing readiness layers must share the explicit repair identity.

On reconnect, retain active repair descriptors on the client and include them
with its declared holdings. Also declare the footprints of all submissions whose
outcomes remain unknown. Such a submission may have been rejected just before
disconnection, without its verdict reaching the client.

The server reinstalls this coverage before calculating resume differences. It
may authorize a redeclared footprint as a scoped read without proving that its
original conflict is durably recorded: the declaration grants no write or
verdict authority. It must not advance `caughtUpLocalSeq` merely because a
client declares a repair. Outstanding submissions still obtain their verdicts
through ordinary replay.

The client only completes a conflict's readiness once it knows that conflict's
verdict and has a sufficiently recent applied receipt. A snapshot obtained
before a replayed rejection is insufficient if the rejection names a newer
server cut. Replay restages the repair in that case.

This also covers a server restart or expired server-side session with the same
logical session identity: the client supplies coverage and holdings afresh.
Rejection waiters cannot depend on vanished server-side marker counters. If the
logical session identity changes, invalidate the old recovery and let the owner
reestablish its operation under the new identity; never reuse a session-scoped
basis under a different identity.

An ordinary server restart preserves the underlying store and its sequence
history. Restoring an older database or replacing the store is a different
operation: receipts from the retired history cannot establish freshness in the
replacement. This plan does not treat a maximum remembered sequence as evidence
that two different store histories are continuous.

Within one server session, coverage pins repair data through watch replacement
and reconnect. A release removes only the named owner. The next diff retracts
repair-only data after its last owner releases it; ordinary graph ownership
keeps overlapping documents live.

## 7. Runtime integration

| Owner                     | Required handling                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reactive scheduler        | Keep the handle with the action while waiting and while its fresh transaction runs. Release on successful settlement, terminal failure, action removal, or supersession; transfer ownership on a further conflict. |
| `Runtime.editWithRetry()` | Bracket the recursive fresh attempt with repair ownership. A consumed retry budget or teardown releases the handle. A failed readiness outcome must not become a successful wait.                                  |
| UI writes                 | Use the same `editWithRetry()` ownership; preserve newest-value lane semantics and the non-retry behavior of already-resolved CAS updates.                                                                         |
| Queued events             | Carry ownership with the queued event through any existing pacing, and release on completion, cancellation, opt-out, or convergence failure. A delay is not proof of repair.                                       |
| Piece startup             | Keep coverage through the permitted re-instantiation or load-from-served-state operation, using the existing cancellation/registration owner. Do not introduce a new permission to retry a terminal start failure. |
| Local dependent rejection | Borrow relevant recovery ownership from the failed dependency, or await local state repair for a purely local rejection; do not manufacture a server repair.                                                       |

`Runtime.awaitCommitRetryReadiness()` currently combines a readiness wait with a
pull of `conflict.of` using the default scope. The implementation should replace
this ad hoc recovery with the shared typed mechanism for negotiated peers.
`toRejectedError()` must carry the recovery handle through without reducing its
identity to the error message's document ID.

Keep `ignoreReadForScheduling` for output diff reads. Do not add an eager sync
to every output write or expand `loadUnexaminedAbsences()` to probe every new
document creation. Those changes are not prerequisites for this recovery
contract.

The API migration must include low-level callers that intentionally decline to
retry. A recovery handle is a resource even when its error is simply returned.
Use explicit ownership and `finally` cleanup rather than garbage collection or
session expiry as routine cleanup. The reduced test may add cleanup for this
handle, but its behavioral assertion remains unchanged: after awaited repair, a
fresh second transaction succeeds without a manual scoped sync.

## 8. Performance and observability

For the scoped-output regression, the expected sequence is:

1. The space output points elsewhere; its earlier user instance exists. The
   replica reads that unseen user instance as absent and submits an output
   update plus the redirect restoration.
2. The server rejects the absence claim and creates repair coverage for both
   scoped addresses, regardless of the stored space link.
3. One frame delivers the user instance's actual value and revision along with a
   complete receipt. The replica installs it and completes readiness.
4. The fresh transaction recomputes the update. If the user value is already
   correct, it only needs to restore the redirect. Otherwise it writes the
   appropriate update against the actual previous value.
5. After that operation settles, it releases the repair. The restored graph's
   ordinary watch retains the user document if its selector reaches it.

With no intervening writer and no newly discovered dependency, there is one
initial conflict and one successful fresh attempt. Further identical conflicts
against the same repaired footprint indicate failed recovery, not contention.

The success path allocates no repair map entry, enumerates no additional
footprint, and sends no repair-specific field or request. An outstanding
commit's existing payload is enough to derive a repair declaration if reconnect
makes it necessary.

For a conflict batch, work is proportional to the unique document footprint plus
its required schema closure and the ordinary watch refresh. Group by branch,
deduplicate identical addresses and closure documents, reuse authoritative
snapshots already assembled for the frame, and avoid one RPC per dependency.

Keep temporary coverage through the current recovery sequence rather than
accumulating it for every rejected attempt. On repeated conflict, install the
replacement coverage before releasing superseded coverage. Distinct active
operations can share snapshots while retaining independent ownership.

Record aggregate counters for active repairs, unique repair-only addresses,
repair snapshot bytes, repair wait duration, receipts that fail validation,
reconnect redelivery, and coverage released. Diagnostic details may include
space/session/localSeq, scoped address, rejected basis, conflicting version, and
installed version; document values and identities' private material do not
belong in those diagnostics.

Measure both the normal path and conflicts. The acceptance target is no added
repair reads or round trips for uncontended successful transactions, one batched
repair for the reduced stale footprint, and return to zero temporary ownership
after the workload completes. Wall-clock performance must be measured rather
than inferred from those counts.

## 9. Compatibility and implementation sequence

The complete guarantee requires both peers to negotiate it. A server must not
create indefinitely retained repairs for a peer that cannot release them. An
updated client must not label an older peer's bare catch-up marker as complete
transaction repair.

Deploy the server capability before enabling it in clients. For a peer without
the capability, preserve normal successful transactions and surface an explicit
unsupported-recovery outcome when this automatic recovery would be required. Do
not hide the capability gap with an unbounded retry or add a second, permanently
maintained recovery implementation. Existing legacy behavior may remain for
legacy peers during rollout, but it does not satisfy this plan's acceptance
criteria.

Implement in the following stages. Intermediate work can be reviewed with the
capability inactive; do not enable a partial lifecycle in deployed clients.

1. [ ] Define the protocol types, recovery ownership interface, and failure
       classification. Update memory specs for explicit repair coverage,
       receipts, and release. The shared footprint builder and its branch/scope
       membership tests are implemented in
       [transaction-repair.ts](../../packages/memory/v2/transaction-repair.ts)
       and
       [its unit tests](../../packages/memory/test/v2-transaction-repair.test.ts).
       Server conflict staging uses that builder; it still repairs through graph
       watches until the following stages supply independent coverage.
2. [ ] Implement the server repair component and shared snapshot/schema
       assembly. Compose it into incremental/full/no-watch sync paths and
       separate execution demand from delivery holdings. Verify a direct
       memory-client conflict on an unwatched document.
3. [ ] Implement receipt validation, explicit release, and reconnect
       declarations in the memory client and runner replica. Exercise lost
       frames, unknown verdicts, changed logical identity, and unchanged
       server-sequence release.
4. [ ] Migrate every runtime recovery owner and every non-retry exit. Remove
       scope-losing recovery pulls for negotiated peers. Verify cancellation,
       supersession, local dependents, and cleanup without session close.
5. [ ] Make the runner regression and all relevant protocol, storage,
       scheduling, event, UI-write, and startup tests pass. Measure normal-path
       cost and batched conflict cost. Exercise server execution OFF and ON
       independently.
6. [ ] Rehearse the six-step source round trip in a throwaway empty space,
       review the full change, and enable the negotiated capability after the
       lifecycle and performance gates pass. Archive this plan when
       implementation ships.

Principal implementation seams:

| File                                                                                                                                                                                                                                           | Responsibility                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [memory/v2.ts](../../packages/memory/v2.ts) and [memory/interface.ts](../../packages/memory/interface.ts)                                                                                                                                      | Protocol shapes, scope vocabulary, rejection/recovery interface.                                                        |
| [memory/v2/session-registry.ts](../../packages/memory/v2/session-registry.ts)                                                                                                                                                                  | Per-session repair ownership and restoration.                                                                           |
| [memory/v2/server.ts](../../packages/memory/v2/server.ts)                                                                                                                                                                                      | Rejection staging, publication ordering, coverage composition, release, authorization, and execution-demand provenance. |
| [memory/v2/query.ts](../../packages/memory/v2/query.ts) and [server-sync.ts](../../packages/memory/v2/server-sync.ts)                                                                                                                          | Shared snapshot/schema assembly and union delivery differences.                                                         |
| [memory/v2/client.ts](../../packages/memory/v2/client.ts)                                                                                                                                                                                      | Recovery handles, receipts, release batching, and reconnect declarations.                                               |
| [runner storage/v2.ts](../../packages/runner/src/storage/v2.ts)                                                                                                                                                                                | Applied-repair gate, rejection rollback, handle propagation, and holdings.                                              |
| [runtime.ts](../../packages/runner/src/runtime.ts), [scheduler/run.ts](../../packages/runner/src/scheduler/run.ts), [scheduler/events.ts](../../packages/runner/src/scheduler/events.ts), and [runner.ts](../../packages/runner/src/runner.ts) | Recovery consumption and cancellation ownership.                                                                        |

## 10. Acceptance tests

Use the real in-process memory server with manual fan-out and explicit verdict,
receipt, disconnect, and cancellation barriers. Tests must not depend on sleeps,
polling, or a large retry count.

| Case                                                                        | Required assertion                                                                                                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Existing hidden user output, desired value already `null`                   | Initial conflict; applied repair; next fresh transaction succeeds without explicit user sync.                                 |
| Existing hidden output differs from desired result                          | The rebuilt diff uses the stored value and produces the desired result without losing unrelated preserved fields.             |
| General stale computation                                                   | A result derived from an absent input is recomputed from the repaired value; changing only the exported sequence cannot pass. |
| Truly new output                                                            | First attempt succeeds; zero repair reads, requests, and ownership entries.                                                   |
| Read-only stale dependency, separate write target                           | Both the input and output bases are covered, including when neither has a normal watch.                                       |
| Existing nonzero stale version                                              | Repair is not restricted to sequence-0 reads.                                                                                 |
| Tombstone and never-created document                                        | Their versions remain distinguishable after repair.                                                                           |
| Same ID across branches, user instances, and sessions                       | Only the rejected transaction's authorized addresses satisfy the receipt.                                                     |
| Output diff read ignored for scheduling                                     | It remains a commit-repair dependency without establishing an output-triggered computation.                                   |
| Required document or schema quarantined                                     | Readiness fails explicitly; an empty/partial frame marker cannot release the retry.                                           |
| Receipt-only or failure-only frame                                          | The real wire and replica-consumer paths forward it and settle only the correct handle.                                       |
| Foreign write after rejection                                               | The receipt covers a cut at or after rejection; a further genuinely newer conflict remains valid.                             |
| Several coalesced rejected submissions                                      | Shared snapshots are sent once; each repair has complete membership and independent completion.                               |
| Delivery throws or socket loses a sent frame                                | Replay or resume delivers missing bases before readiness.                                                                     |
| Server remembers sending data the replica never installed                   | Declared holdings and receipt validation cause redelivery.                                                                    |
| Disconnect before the verdict                                               | The outstanding submission's footprint survives; replay determines its outcome.                                               |
| Server restart or expired session with stable logical identity              | Client declarations reconstruct coverage and readiness without old server marker state.                                       |
| Logical session identity changes                                            | Old session-scoped recovery is invalidated, never silently remapped.                                                          |
| Local replica loses installed data                                          | A previously completed receipt cannot make the replacement replica ready without rehydration.                                 |
| Watch replacement between repair and retry                                  | It cannot retract the owned repair basis.                                                                                     |
| Two recoveries share a document                                             | Releasing either one leaves the other's coverage intact.                                                                      |
| Further conflict during recovery                                            | Replacement coverage installs before old ownership releases; completed sequences do not accumulate.                           |
| No-op retry, cancellation, supersession, non-retry exit, or thrown callback | Ownership is released without requiring session close.                                                                        |
| Cancellation precedes the conflict verdict                                  | The late verdict or receipt cannot resurrect the canceled recovery or leak ownership.                                         |
| Release with unchanged `seenSeq`                                            | Cleanup is transmitted and applied; duplicate or lost release is safe.                                                        |
| Release followed by no other traffic                                        | Its scheduled diff reclaims repair-only delivery state.                                                                       |
| Repair-only computed document under server execution ON                     | Delivery introduces no graph execution demand or whole metadata-family load.                                                  |
| Ordinary subscriptions overlap repair                                       | Last-owner release preserves normal delivery and ordinary execution demand.                                                   |
| Mixed accepted and rejected transactions                                    | Accepted-write parking, optimistic overlays, and exact accepted-write promotion retain their semantics.                       |
| Unsupported peer                                                            | Successful writes still work; automatic repair does not claim readiness from an unsupported contract.                         |

Run the existing conflict-reconciliation, stacked-commit, memory subscription,
effect-conflict-recovery, event-disposition, edit-with-retry, UI-write, and
piece-start tests alongside the focused additions. Run the repository's required
format, lint, type, documentation, and package test gates before publishing a
changeset. Browser rehearsal follows the repository's sandbox and local-server
instructions.

## 11. Scope and remaining verification

This design changes generic transaction recovery. Compiler node identities,
source migration, persisted graph cleanup, the shell debug helper's scope
option, and classification of the CLI `piece-start-commit-failed` observation
are separate work. A passing recovery test does not establish a universal claim
about how many source applies are safe.

Before enabling the capability, implementation must demonstrate the exact
resource accounting and release paths, schema-closure reuse without execution
metadata traversal, and serving-runtime demand separation. Those are acceptance
gates with the tests above, not assumptions that a successful lunch-poll reload
can substitute for. Capability field names and internal module boundaries may be
refined during implementation while preserving the explicit ownership, complete
receipt, and unchanged successful-write path specified here.
