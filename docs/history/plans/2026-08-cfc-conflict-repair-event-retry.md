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
