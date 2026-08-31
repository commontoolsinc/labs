---
status: historical
created: 2026-08-27
archived: 2026-08-27
reason: "Investigation record: which supersession guards in the builtins' abandoned-request endings a test can reach, which cannot be reached without a sleep, and the two guards that turned out to be wrong."
---

# The abandoned-request endings' supersession guards, August 2026

## Conclusion

Six builtins settle a request whose staging transaction was abandoned. Each
ending decides, inside the transaction that settles it, whether some other
request holds the cells it is about to write, and returns without writing when
one does. Those returns split cleanly in two, by what the guard reads.

Three guards read committed state, so a test arranges the state and the guard
follows: `fetch.ts` reads a claim id in its `internal` cell, `fetch-program.ts`
reads a cache entry, and `sqliteQuery` reads a stored request hash. All three
are now covered.

Two guards read a counter that lives only in the node's own closure:
`stream-data.ts` compares against `status.run` and `llm.ts` against
`currentRun`. Reaching either return needs a second run of the same node to
begin inside a window nothing signals, and no test can wait on it. They are
left uncovered.

The sixth, `llm-dialog.ts`, reads committed state like the first three — the
`requestId` in its `internal` cell — but its return decides almost nothing.
The only thing its ending writes is the pending flag, down. A turn that
finished left that flag down already, and a turn still running is one whose
flag the ending must not touch, which is what the guard is there for. So the
two arms differ only in the case where a previous turn left the flag up and
nobody is running: the write arm is what the case in
`builtin-abandoned-request.test.ts` reaches, and the return arm changes nothing
observable that a test could hold it to.

Arranging the first three turned up a defect in two of them. `fetch.ts` and
`sqliteQuery` were comparing identities alone, and a request that has finished
leaves its identity behind, so every request after the first one on a node read
that leftover as a takeover and wrote nothing. Both now ask whether the pending
flag says a request is live as well.

## Where the two counters make a window nobody can wait on

The ending runs from the transaction's abandonment, which the scheduler
dispatches when it decides no further attempt at the commit is coming. On the
reactive path that is `abandonAction()` in `packages/runner/src/scheduler/run.ts`,
called from the handler on the commit promise. It calls `abandonStagedWork()`,
which calls each staged effect's `abandon`, which calls the builtin's
`onRejected`, which calls `settleAbandonedRequest()`, whose `editWithRetry()`
runs its callback synchronously. So the guard's decision happens in the same
turn as the commit verdict.

`status.run` and `currentRun` are incremented at the top of each of the node's
runs. For either guard to return, run N+1 has to have begun before run N's
commit verdict was handled. The scheduler does allow that — it kicks off a
commit and carries on rather than waiting for it — but nothing reports when run
N's verdict is about to land, so a test can only make the window wider by
sleeping, which this repository does not do. Neither counter leaves a durable
trace, so unlike a claim id or a cache entry there is nothing a test can commit
in advance instead.

`llm.ts` has one more await than the others: `handleLLMError()` waits for the
scheduler to go idle before it opens its writeback transaction, so a run that is
already queued at that moment would advance `currentRun` and the guard would
return. Queuing one at that moment is the same unpinnable ordering, from the
other side.

`handleLLMError()` also opens with a second, earlier form of the same test:

```ts
if (thisRun !== getCurrentRun() && announce === undefined) return;
```

That return is reachable — an ordinary request that fails after a newer one has
started takes it — but a test of it could not fail without it. The later guard
makes the same decision one await further on, so removing the early return
changes nothing a test can observe except that an empty transaction is opened
and committed.

## The two guards that were wrong

`fetch.ts` asked whether the stored claim id was some other request's:

```ts
const claim = internal.withTx(settleTx).key("requestId").get();
if (claim !== undefined && claim !== "" && claim !== newRequestId) return;
```

A request that finishes does not clear its claim id — `tryWriteResult()` updates
the stored input hash and leaves the id alone — so the id of the last request
stands until some later run commits over it. The run that stages a request does
clear it when the inputs have changed, but that write rides the transaction the
ending exists to answer for, so it never lands. The result is that the ending
worked exactly once per node: on the first request, where there is no id yet.

What it left behind is the state the ending exists to prevent. A pattern whose
url moves from A to B, where B's staging commit is refused, goes on showing A's
response with the pending flag down and no error. Nothing further runs to
correct it, because the action is not re-run without another input change.

`sqliteQuery` had the same shape against a stored request hash, with the same
consequence: the previous statement's rows left standing under a statement the
pattern no longer runs.

An identity on its own cannot answer the question, because a finished request
and a running one leave the same kind of mark. Two tests together can. One asks
whether a request is in flight: the pending flag is up under an identity that is
not this request's. The other asks whether anything has been written to
these cells since this request was staged, against what the staging run found
there — the cells whole rather than any field of them, since a request that
answers writes its result without moving the claim id and one that takes over
moves the claim id without writing a result. The ending steps around either.

Each covers a case the other misses. The in-flight test alone would let the
ending write over a later request that had already answered, since that request
leaves the flag down. The since-staged test alone would let it write over a
request that was already running when this one was staged, since that request's
identity has not moved. What neither treats as a claim is the leftover — an
identity from before this request was staged, with the flag down — which is what
made the ending work exactly once per node.

A third test asks something the store cannot answer: whether the node still
wants this request. A run whose inputs return to ones already answered reads
that answer and writes nothing, so both durable tests see exactly what the
refused request left behind, while the answer standing there is one the pattern
is now asking for. Only the node knows that, from the request identity its most
recent run recorded.

Of the three, only the in-flight test has a case. The other two turn on the
ending's body running a second time, later, which happens when its own first
commit is refused in a retryable way: `editWithRetry` awaits the conflict's
catch-up gate and runs the body again. That gate is a real seam a test can hold
open — `docs/development/COVERAGE.md` describes reaching a retry-only guard
exactly that way, and `packages/runner/test/fetch-writeback.test.ts` injects the
refusals. An attempt at it here got the first half and not the
second. Refusing the ending's own first commit works, and its body does run
again. What did not work was moving the node in between: the gate runs inside
the commit chain the ending is already in, and driving a fresh run of the node
from there is reentrant. Somewhere to start, rather than a dead end.

`fetch-program.ts` was not affected. Its guard reads the cache entry for this
request's own input hash, and a request with different inputs reads a different
entry, so a finished request's entry is never mistaken for a claim on this one.

## What each covered case needed

`packages/runner/test/builtin-abandoned-request-supersession.test.ts` covers the
`fetch.ts` and `sqliteQuery` guards from one runtime. The refused request is not
the node's first, so there is committed state for the ending to decide against:
a finished request's answer is replaced, and a running request's claim — kept
running by a held response — is left alone.

`packages/runner/test/fetch-program-abandoned-takeover.test.ts` needed two
replicas on one memory server, because the cache entry the ending steps around
has to belong to somebody, and the only entry state that both permits a takeover
and survives the refusal is another replica's claim gone stale. Two details of
that arrangement each produce a case that passes without reaching the guard.
The taker has to be able to see the holder's claim, and the builtin loads its
cache document from inside the run that would use it, so a replica's first run
always decides against an empty cache — the case runs the taker once while the
claim is still fresh, which stages nothing and leaves a loaded cache view
behind. And the refusal has to arrive without changing the request, since a
cache entry is keyed by the input hash: the case points the url slot at a
caveated cell holding the same url rather than editing the url.

## Reaching the refusal at all

Every one of these cases refuses a commit the same way the existing
`packages/runner/test/builtin-abandoned-request.test.ts` cases do, with an input
whose schema carries a confidentiality the result store does not declare, under
`cfcEnforcementMode: "enforce-strict"`.

Two facts about where that caveat can go were worth the time they took to find.

A run reads its inputs whole, so a caveat anywhere in them refuses the run
itself. For `llmDialog`, whose turn is staged inside the handler that appends
the user's message, that is the wrong transaction: the run is refused first, the
piece stops, and the handler is never registered, so the staging is never
reached. A context entry is where the two part company. The run materializes a
context entry as a cell reference without reading its fields, and the handler
reads a field to build the request the turn would send, so a caveat declared on
the field reaches the handler's transaction and not the run's.

Pointing an input slot at a caveated cell is how a caveat arrives after a
request has already been made. The slot's value is a link, so the read that
follows it carries the caveat while the value it resolves to — and therefore the
request hash — can stay exactly what it was.
