---
status: historical
created: 2026-08-24
archived: 2026-08-24
reason: "Investigation record: the five uncovered lines that moved the `packages/runner` coverage count between a `main` run and the pull request measured against it."
---

# The fetch writeback refusal that one shard reached, August 2026

## Conclusion

[PR #6196](https://github.com/commontoolsinc/labs/pull/6196) changed no line of
`packages/runner/src/builtins/fetch.ts` or of
`packages/runner/src/builtins/fetch-utils.ts`, and its Coverage Check job
reported `packages/runner` at 5756 uncovered lines against a `main` baseline of
5751. The five lines were charged to a pull request about session identity, and
the debt was accepted with an override.

They are lines 262 and 263 of `fetch-utils.ts`, the arm of `tryWriteResult()`
that carries a refused commit back to its caller,

```ts
if (committed.error !== undefined) {
  return { written: false, commitError: committed.error };
}
```

and lines 708, 709 and 711 of `fetch.ts`, where `startFetch()` turns that
answer into a throw rather than letting the response go quiet.

```ts
if (written.commitError !== undefined) {
  throw new Error(
    `${kind.name} completion write failed: ${written.commitError.message}`,
  );
}
```

Reaching either takes a completion writeback whose commit the storage layer
refuses. Nothing in the suites asks for one. One shard of the `main` run
happened to produce a single refusal, and no artifact of the pull request's run
produced any.

## What the runs measured

The baseline is
[run 32590050985](https://github.com/commontoolsinc/labs/actions/runs/32590050985),
`main` at `b75acec4`. The pull request is
[run 32594150355](https://github.com/commontoolsinc/labs/actions/runs/32594150355),
whose head is `581c4efe`; like every pull request run it measures the merge ref
rather than that commit. Both files are byte-identical between `b75acec4` and
`581c4efe`, and no commit on `main` after `b75acec4` has touched either of them,
so whichever `main` the merge was rebuilt against contributed the same two
files. Their line numbers and counts compare directly.

Each run uploads 36 coverage artifacts, under identical names, of which 31
measure both files. In the baseline run, exactly one of the 31 records a hit on
any of the five lines: `coverage-profile-pattern-integration-5`, which counts
one on each. In the pull request's run all 31 report zero.

That artifact belongs to the `Pattern Integration Tests (5/10)` job. The
selector assigns pattern integration files to shards by measured weight, and
the file list is unchanged between the two commits, so shard 5 ran the same
nine files in both runs: `integration/all.test.ts`, `time-capability.test.ts`
and `time-capability-full.test.ts`, which run in every shard and divide their
own cases across the ten, plus `default-app`, `cfc-group-chat-demo`,
`sqlite-read-clearance-multi-runtime`,
`cfc-group-chat-chained-event-gate-multi-runtime`, `sx2-effect-channel` and
`sx2-speculation`. They run whole patterns in real runtimes, and two of them
stand several runtimes up and tear them down. That is the kind of place a
completion writeback is refused: the response arrives, `tryWriteResult()` opens
its transaction, and the commit meets a session that has already closed.
Nothing in them asserts that this happens, and nothing arranges for it to.

One caveat belongs on that comparison. The pull request edits
`sqlite-read-clearance-multi-runtime.test.ts`, which is one of shard 5's nine
and one of the two that tear runtimes down, adding a third harness session to
its cases. So the two runs ran the same files but not the same code in all of
them, and the difference sits in exactly the kind of case a refused writeback
comes out of. That weakens this pair as evidence of pure environment
dependence; it does not weaken the conclusion, because a line whose coverage
turns on when some unrelated suite tears a runtime down is environment-
dependent whether or not this particular pair of runs isolates it.

## The branch behind it, never reached at all

`fetch.ts` reports the second failure too: when the error-shaped result that
stands in for a refused completion cannot commit either, the claim is wedged
durably and the rethrow at lines 751 to 756 is what makes the tracked work
reject, so the outbox counts `outbox.failed` rather than recording a completion.
Those lines report zero in every artifact of both runs — permanent debt rather
than movement, and the next lines to move the day some run reached them.

## What was done

No source change: the failing operation is already a parameter. Both
`tryWriteResult()` and the builtin around it commit through a runtime they are
handed, so a test that hands them one whose commits are refused reaches both
reports without waiting for a machine to refuse a commit of its own accord.

`packages/runner/test/fetch-writeback.test.ts` states the three outcomes of
`tryWriteResult()` — the writeback that lands, the writeback superseded by
inputs that moved, and the writeback the storage layer refuses — because the two
that do not write are distinct for the caller and only the refusal must keep the
effect from retiring. It then drives `fetchJson` end to end against a held
response and refuses the writeback's commit, which is identified by the document
it writes rather than by its position, so the refusal lands on the completion
write and on nothing else. That case asserts the error-shaped result the
conversion produces, by message, and that the claim was released; a second case
refuses every commit from the response onward and asserts that the tracked work
rejects, that the report names the completion failure as its cause, and that the
claim is left pending. A version that swallowed either failure fails rather than
staying green on the line count.

What no case pins is the guard's choice of predicate. Within one replica every
route to a superseded writeback also aborts the request's signal, and
`startFetch()` returns on an aborted signal before the throw it would then have
raised becomes observable, so a version testing `written` where it now tests
`commitError` cannot be told apart from this side. The distinction between the
two answers is stated where it is decidable, on `tryWriteResult()`'s own
return.

That takes all five lines to a nonzero count from the new test file alone, and
takes the never-covered rethrow with them.
