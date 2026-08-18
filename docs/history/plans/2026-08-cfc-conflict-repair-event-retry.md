---
status: historical
created: 2026-08-16
archived: 2026-08-16
reason: "Executed the event-retry and repair-generation correction required by the strict CFC browser regression."
---

# CFC conflict repair and event retry correction

This work order records one final necessary change found while verifying the
strict CFC rollout with two browser runtimes. The numbered section is one
commit. It follows the earlier rollout and repair work orders without changing
the two leading boundaries: the first commit contains only switch changes, and
the second contains only tests that directly inspect those switches.

## 1. Preserve event intent until overlapping repairs drain

The Lunch Poll browser regression completed concurrent votes but lost the next
option the host added. The click handler ran and cleared its form draft. Its
commit then conflicted with concurrent shared-state work. The event scheduler
made the same click eligible again after its backoff delay without awaiting the
conflict's readiness function. The retry read the already-cleared draft,
returned without writing an option, and eventually recorded a successful
no-op. Repeated retries could also run against another rejected optimistic
layer and continue the conflict cycle until the event convergence window
expired.

Coordinate semantic conflict repair by document. A repair generation includes
only commits already minted when that generation starts. Commits minted later
join a finite successor generation. Each generation stores an exact
Differential snapshot for every rejection that joins it. This retains leaf
paths introduced by later optimistic layers without invalidating the entire
document. A rejected commit drops its own layer, releases its generation
claim, and waits only for that finite generation before its commit promise
settles.

Keep retry readiness separate from commit settlement. Every active generation
for a document shares a document-drained promise. A conflict's readiness
function resolves only after the rejected layer is gone and the document has
no active repair generation. The event scheduler awaits that function before
putting a conflicted event back into its queue. A closed or replaced session
can reject the readiness function; that remains a control-flow signal, and the
event is requeued so its next commit determines the outcome.

Do not notify subscribers or sinks while another repair generation for the
same document is active. When a generation closes, transfer its exact snapshots
to a remaining generation. The last generation compares every transferred
snapshot with the repaired state and publishes one merged revert. Ordinary
syncs for that document are folded into the same final revert. Unrelated
documents continue to notify immediately.

Scheduler-observation batches can give several waiting semantic commits the
same rejection object. Copy that rejection for each semantic commit and attach
the current transaction before wrapping its readiness function. This prevents
one sibling from capturing another sibling's wrapper and forming a wait cycle.

Make an add-option event carry its required title. The UI reads the draft once
when the click is delivered and sends that string as the event payload. The
handler no longer falls back to mutable form state. Every retry therefore
replays the user's original intent, and clearing the presentation draft cannot
turn a rejected add into a successful no-op.

Cover the storage behavior with overlapping repairs, ordinary syncs during
repair, finite successor generations, exact leaf changes, independent copies
of a shared scheduler rejection, bounded commit settlement, and document-wide
retry readiness. Cover the scheduler boundary with a commit result whose
readiness stays pending and prove the handler does not rerun until it resolves.
Record the changed Lunch Poll argument contract in the append-only pattern
compatibility baselines. Keep the Lunch Poll pattern tests and the exact
two-browser scenario as the end-to-end proof. The two-browser scenario must
retain both concurrent votes, add a second option, and record its independent
vote.

## 2. Bound conflict readiness to its repair generation

The document-wide readiness promise introduced above could remain pending
forever. A later conflict created a successor generation for the same document.
When the earlier generation closed, it transferred its snapshots to that
successor and waited for the whole document to drain. A steady stream of
independent conflicts could always create another successor before the final
generation closed. The first event would then never become eligible to retry,
and subscribers would never receive a revert notification for any completed
generation.

Resolve each conflict's readiness function when the finite generation it joined
has settled. Later commits cannot join that generation because its local
sequence cutoff was fixed when the generation was created. Emit a merged revert
for every completed generation instead of moving its snapshots to a successor.
An active successor can therefore cause a bounded duplicate invalidation, but
it cannot extend the earlier generation's readiness or suppress its
notification. A retry that encounters the successor's optimistic state follows
the ordinary conflict path again and keeps the original event payload.

Extend the successor-generation test so the later repair remains blocked while
the earlier commit settles, its readiness resolves, and its revert is emitted.
Then release the successor and verify that it produces its own final revert.

## 3. Share one completed conflict repair with retry callers

Storage first waited for the conflict rejection's provider readiness function.
If that function did not settle, a fixed repair timer let storage move on to an
explicit selector refresh. Once the refresh completed, the rejected commit
settled with a repaired base. The surfaced readiness function called the same
provider function again before the event scheduler could requeue the handler.
That second call had no escape path. A provider that never produced its
caught-up marker could therefore strand the event even though the explicit
refresh had already repaired its reads.

Issue a one-shot graph query containing the rejected transaction's read
selectors. Unlike replacing the session's watch set, this query does not
re-evaluate every live watcher or feed their unchanged values back through the
scheduler. Accept the query as a repair only when its authoritative result
advances every conflicted read past the sequence used by the rejected commit.
An omitted root is an authoritative deletion at the query's server sequence.
Apply only the requested root addresses from the graph closure so linked
documents do not bypass their ordinary notifications. The normal notification
filter folds the conflicted root into the repair generation and reports changes
to any other queried read.

Start the query and the provider readiness function together. Apply a
successful query result as a silent conflict-repair sync before dropping the
rejected optimistic layer. Accept the first repair that succeeds. When the
query succeeds first, cancel and remove both provider caught-up waiters. When
provider catch-up succeeds first, cancel and remove the pending graph request.
Ignore a response that arrives after cancellation. This lets either
authoritative signal complete the repair without leaving a waiter or request,
or allowing a late response to overwrite newer subscribed state. Clear
stale-read admission floors only for the queried reads and only through the
rejected commit's local sequence. A later conflict's floor remains intact. Race
the repair with replica closure, which is an event the storage layer already
exposes. Remove the fixed repair timer.

Share that completed repair outcome with the readiness function carried by the
rejection. That function also waits for the local optimistic layer to be
removed and for its finite repair generation to settle. It never invokes the
provider or query repair again. Each caller can cancel its own wait without
canceling the shared repair or another caller's wait. An already canceled
caller does not start an unused wait on the shared repair.

Add storage regressions whose query returns the server's winning value or omits
a deleted conflict root. Prove that the local sequence and visible value are
repaired before the surfaced readiness function resolves. Count both repair
functions and prove that the surfaced readiness function does not repeat
either one. Hold a query response, deliver provider catch-up, and prove that
the commit and surfaced readiness settle while the graph request is canceled
and its response remains held. Cancel one surfaced readiness caller and prove
another caller still completes with the shared repair. Prove an already
canceled caller cannot leave an unobserved failure behind. Include an
unrequested graph-closure result and prove it is not silently applied. Make a
failed query application complete through the provider. Run the two-browser
Lunch Poll regression to prove that concurrent votes settle without repeatedly
re-evaluating the whole watch set.
