---
status: historical
created: 2026-08-20
archived: 2026-08-20
reason: "Investigation record: the five uncovered lines that moved the `packages/runner` coverage count between a `main` run and the pull request measured against it."
---

# The resume-seed failure report that one shard reached, August 2026

## Conclusion

[PR #6094](https://github.com/commontoolsinc/labs/pull/6094) changed no line of
`packages/runner/src/builtins/map.ts`, and its Coverage Check job reported that
group at 4565 uncovered lines against a `main` baseline of 4562.

The five lines are 341 to 344 and 346 of that file: the warning the list
coordinator's resume recovery emits when the write that seeds its empty result
container is refused.

```ts
}).then(({ error }) => {
  if (error) {
    logger.warn(
      "resume-seed",
      "seeding the empty result container failed",
      { error },
    );
  }
});
```

Reaching them takes a seed whose commit fails. Nothing in the suites asks for
that. One shard of the `main` run happened to produce three of them, and no
shard of the pull request's run produced any.

## What the runs measured

The baseline is
[run 32410534083](https://github.com/commontoolsinc/labs/actions/runs/32410534083),
`main` at `0eaf16f4`. The pull request is
[run 32411330694](https://github.com/commontoolsinc/labs/actions/runs/32411330694).
`map.ts` is byte-identical between the two commits, so their line numbers and
counts compare directly.

Each run uploads 36 coverage artifacts, of which 31 measure `map.ts`. In the
baseline run, exactly one of them records hits on lines 341 to 346:
`coverage-profile-workspace-7`, which counts three on each. In the pull
request's run, all 31 report zero.

That artifact belongs to the `Test (7/8)` job, and the package set a workspace
shard runs is decided per run rather than fixed. In this one it was `cli`
(shards 1 and 4 of 10), `agents-host` (shard 1 of 3), `dashboard`, `lib-shell`,
`felt` and `llm`. Those suites start and tear down whole runtimes, which is the
kind of place a container seed can be refused: the resume pull settles, the
seed opens its transaction, and the commit meets a session that has already
closed. Nothing in them asserts that this happens, and nothing arranges for it
to.

## The same branch, three times over

`filter.ts` and `flatmap.ts` carried character-for-character copies of the same
recovery, warning under the same two message keys. Their copies of the
`resume-seed` warning, and all three copies of the `resume-pull` warning that
reports a rejected pull, were uncovered in both runs — permanent debt rather
than movement, and three more lines apiece waiting to move the moment a run
reached one of them.

## What was done

The recovery moved into
`packages/runner/src/builtins/list-result-container-seed.ts` as
`seedResultContainerWhenPullSettles()`, which the three builtins now call.
It takes the runtime, the container the coordinator still holds, the pull to
wait on, and the logger to report through, so a test can hand it a pull that
rejects and a runtime whose commits are refused.

`packages/runner/test/list-result-container-seed.test.ts` drives both failure
reports along with the recovery's ordinary outcomes: a container the pull left
absent is seeded, a container that arrived during the pull keeps the value it
arrived with, a coordinator that no longer holds a container writes nothing, a
rejected pull is reported and seeds anyway, and a seed the storage layer
refuses is reported. Each case asserts the message key and the error carried
with it, so a report that changed which failure it named would fail rather than
stay green on the line count.

That takes every line of the recovery to a nonzero count from the new test file
alone, and removes the two duplicate copies of it from the package's uncovered
total.

The dead line inside the recovery went with it. The seed re-read the
coordinator's `active` flag inside the transaction body, after testing it
immediately before opening the transaction, and `editWithRetry()` calls that
body synchronously — so the inner test could never see a different answer than
the outer one. It read as uncovered on every run.
