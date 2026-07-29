# Document release

Every document a space replica pulls stays in `SpaceReplica`'s document map, and
every watch it installs stays on the server, for as long as the tab is open.
Nothing is ever released. A view that pages through a large collection therefore
costs memory per page visited and never gets any of it back. This document
describes the mechanism that hands documents back, which is implemented behind
`experimentalDocumentRelease` and off by default —
[the experimental options registry](EXPERIMENTAL_OPTIONS.md) records what has to
be settled before it can be the default.

What that costs, and what releasing documents does to it, is measured in
[the release record](../history/development/performance/2026-07-document-release.md).

## What counts as interest

A document is wanted while any of these holds.

**A live reactive reader.** The scheduler's trigger index maps each document to
the actions that read it. Every `Cell.sink`, every running pattern node, and
every view subscription is an action, and its reads are registered there when it
runs and withdrawn when its read set changes or it is cancelled. That index is
the runner's whole answer to "is anything still reading this?", and
`Scheduler.hasDocumentReaders` exposes it.

**An unfinished local write.** A record carrying pending versions is holding
writes that have not been confirmed, and replaying them needs the record.

**A conflict that has not caught up.** An identifier under a stale floor is
waiting for the sequence number that clears it.

**A provider-level `sink` subscriber.** These do not go through the scheduler.

**An outstanding pull waiting for it.** Every document a pull is waiting for,
not only the ones that pull is fetching: an entry an already-installed watch
covers is one the caller is still waiting for, and giving up the covering watch
would leave the pull resolving onto a document the server has stopped tracking.

Everything else is releasable. Note what is *not* on the list: holding a `Cell`
object does not retain its document. A `Cell` is a reference, not a
subscription; reading through one outside a reactive action was only ever
working because the document happened to still be cached.

### The precondition this rests on

Reads marked `ignoreReadForScheduling` deliberately register no trigger, and
there are many of them — sixty-odd across the runner, in pattern binding, link
resolution, schema traversal, and the runner's own bookkeeping. None of them can
cause a document to be released out from under the code making them, and the
reason is structural rather than a property of any individual call site.

A release candidate can only be an entity the trigger index already held. Both
routes into the record start from registered reads: `removeActionFromEntities`
takes the entity set an action registered, and `applyActionReadDelta` takes the
entities a re-run stopped reading. So a document that has only ever been read
without registering a trigger is never a candidate, and is never released.
`packages/runner/test/scheduler-trigger-index.test.ts` pins that.

What remains is a document that *was* tracked, whose tracked readers have all
gone, and which a non-registering read then touches. That read gets what a read
of a never-pulled document gets — absent, and a load — which is the same thing
it would get in a replica that had just started. Code that is correct against a
cold replica is correct here.

## How release travels

The scheduler collects entities whose reader set has just emptied, in
`SchedulerTriggerIndex`. When the scheduler reaches quiescence — no action is
part-way through a run, and the read sets left behind are the ones that
matter — it re-checks each candidate and hands the ones that still have no
reader to `IStorageManager.releaseDocuments`. Filtering at quiescence rather
than at the moment the reader goes is what stops a document that a page change
drops and immediately re-reads from making a pointless round trip.

The manager groups them by space and passes them to each replica, which adds
its own reasons to keep a document before acting.

## The server decides what may be dropped

A replica may not discard a document on its own initiative. The server tracks
which entities each session holds, and `session.watch.add` deliberately does not
resend an entity the session already holds at the current sequence number
(protocol §4.3.6). A document the client dropped without telling the server
could therefore never be pulled back: every later request for it would be
answered with nothing.

**The invariant: a client must never discard a document without giving up the
watch that covers it.** The server does not resend what it believes you hold, so
a document dropped without telling the server is a document you can never get
back. Anything that throws documents away — `reset()` is the one such path
today, and it has no production callers — has to give up the watches behind them
in the same breath, or leave the replica able to serve reads it can no longer
keep current.

So the replica shrinks its *watches*, and takes the server's answer as the
authority for what it may then forget:

1. Each pull installs a watch spec rooted at the document it asked for. The
   replica keeps that spec list as a mirror of the server's.
2. Releasing a document gives up the specs rooted at it, with
   `session.watch.remove`.
3. The server recomputes the union of the surviving watches and answers with
   `removes` for every entity that left it.
4. Those, and only those, are discarded.

A server too old to advertise the `watchRemove` capability gets an equivalent
`session.watch.set` carrying the survivors instead.

A document that leaves the union while this replica still wants it — a dropped
watch was covering it as well as its own root — is pulled again instead of
discarded, and its value stays readable in the meantime. "Still wants it" is
either arm of the interest test: a live reader, or one of the replica's own local
reasons. That is a safety valve rather than a normal path: in a paging view, a
page's rows lose their readers together with the spec that covers them.

A background refresh whose re-evaluated union turned out smaller reports
`removes` too. With release off those documents are handled exactly as before —
the record stays, with its confirmed value cleared — so nothing about the
default configuration changes.

`session.watch.remove` names only the watches that go, so it is independent of
what else is happening and never has to wait. The two shrinks that instead have
to name the watches that *survive* — the one after a replica reset, which has no
ids to name, and the fallback for a server without the verb — are built from a
snapshot of the watch set, and watch mutations reach the server in issue order,
so a snapshot taken before a concurrent refresh would take that refresh's new
watches straight back off. Those two wait for the wire to be free of refreshes,
and hold refreshes off for their own round trip.

That is the reason the verb exists at all. Both forms cost the server the same
work — dropping any watch means re-evaluating the union of the survivors — but
the request bodies differ by orders of magnitude. Measured over a paging walk holding
roughly thirteen hundred live watches, a replacement request carried 590 to 757
kilobytes of surviving watch specs regardless of how little was being dropped,
against 0.5 to 36 kilobytes of identifiers for a removal.

## Reading a released document

A released document reads exactly as a document this replica has never pulled:
absent. The read path already handles that case — it is the fresh-replica read
asymmetry that link resolution and schema traversal kick a background load for,
recording the read reactively so the reader re-runs when the value lands, and
registering the load so `Cell.pull()` and `storageManager.synced()` wait for it.

Release is what makes that kick fire again: it retracts the one-shot
reservations that say a load for the document has already been kicked
(`StorageManager`'s pull kicks and `Runtime`'s missing-document kicks) and drops
the document's selectors from the watch selector tracker, so the pull is neither
suppressed as a duplicate nor skipped as already covered.

A one-shot read taken between the release and the reload therefore sees absent
where a value exists. This is the same contract, and the same one-round-trip
window, that a read of a never-pulled document has always had. It is bounded by
what release covers: nothing that a live reader depends on is released, so the
reads that can land in that window are the ones taken from outside the reactive
graph.

That window is not yet closed everywhere, which is why the flag is off. Run the
runner suite with release forced on and three files hang and eleven cases fail;
the same suite is clean with it off. A list projection whose elements were
released comes out with an empty aggregate in all three builtins, and conflict
handling can wait forever for a sync frame that only arrives over a watch the
release gave up. [The experimental options
registry](EXPERIMENTAL_OPTIONS.md) lists the reproducers.

The way to judge this is to run the suite with the flag forced on — one line in
`defaultSettings` — not to reason about which shapes are affected. Hand probes
of individual shapes have twice suggested the problem was gone when it was not:
the shrink-then-regrow shape releases no element document at all, so a probe
built on it cannot reach the condition it appears to test.

## Observing it

`ISpaceReplica.retentionStats()` reports how many documents a replica holds, how
many it watches, and how many watch specs it has installed. Two things read it.
`packages/runner/test/document-release.test.ts` pins the property this exists
for: sliding a window of subscriptions across a collection holds a replica to a
bounded set of documents with release on, and grows it monotonically without.
`packages/runner/test/measure-document-retention.ts` is the same walk at scale,
run by hand, printing the counts and the retained heap per page — that is where
the numbers in the release record come from.
