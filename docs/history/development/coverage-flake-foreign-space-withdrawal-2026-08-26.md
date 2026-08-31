---
status: historical
created: 2026-08-26
archived: 2026-08-26
reason: "Investigation record: the one uncovered line that moved the `packages/runner` coverage count between a `main` run and the pull request measured against it."
---

# The wave withdrawal skip that depended on what else was in the wave, August 2026

## Conclusion

[PR #6368](https://github.com/commontoolsinc/labs/pull/6368) changed no line of
`packages/runner/src/executor/wave.ts`, and its Coverage Check job reported
`packages/runner` at 5724 uncovered lines against a `main` baseline of 5723.
The one line was charged to a pull request about pattern contract checks.

It is line 1923 of `wave.ts` as that file stood at the measured commit — the
skip at the top of the loop that withdraws a wave's contributions when a
foreign space's co-hosted engine could not be resolved:

```ts
const failed = contribution.spaces.some((sealed) =>
  sealed.space !== this.#space &&
  this.#failedForeignSpaces.has(sealed.space)
);
if (!failed) continue;
```

Reaching it takes a wave that is carrying two different things at once: a
contribution that sealed into the space that failed, which is what puts the
loop in motion, and another contribution that did not, which is what the skip
is for. The first is what a test asks for. The second is whatever else the
serving loop happened to have sealed into the same wave by the time the failure
was decided, which nothing asserts.

## What the runs measured

The baseline is
[run 33013891004](https://github.com/commontoolsinc/labs/actions/runs/33013891004),
`main` at `66ee259d`. The pull request is
[run 33016462719](https://github.com/commontoolsinc/labs/actions/runs/33016462719),
which merged into that same commit. `wave.ts` is untouched by the pull request,
so line numbers and counts compare directly.

Each run uploads 36 coverage artifacts. Thirty-one of them measure `wave.ts`,
and in both runs exactly one of the thirty-one enters the withdrawal loop at
all: `coverage-profile-runner-6`, from `Runner Tests (6/8)`. The two runs' rows
for that one artifact are the whole story.

| line | what it is | baseline | pull request |
| --- | --- | --- | --- |
| 1911 | the `size > 0` guard around the block | 32 | 32 |
| 1912 | the loop header | 1 | 1 |
| 1913–1921 | the loop body up to the `failed` test | 2 | 1 |
| 1923 | `if (!failed) continue;` | 2 | 0 |
| 1924–1925 | the event-handler requeue arm | 1 | 1 |
| 1927–1929 | the derivation drop arm | 0 | 0 |

The guard ran the same number of times in both. What differs is how many
contributions the wave held when it ran: two on the baseline, one on the pull
request. On the baseline the second contribution had not crossed into the
failed space, so the `continue` was taken and the line counted. On the pull
request the wave held only the crossing itself, the `continue` was never taken,
and Deno's projection of V8's block ranges onto lines reports the line as
uncovered — a zero-count block sitting inside a line zeroes that line however
often the code around it ran.

The producing test is
`packages/runner/test/executor-cross-space.test.ts`'s F1b case, which is the
only place in the repository that makes `engineForSpace` reject and so the only
route to `failForeignSpace`. It provokes the failed crossing from the serving
runtime and then, separately, moves a client-side input so that a served
derivation has to keep committing. Whether those two land in one wave is a
matter of when the serving loop closed the wave, so the case proves the home
space keeps serving — which is what it is for — without settling how many
contributions the withdrawal loop sees.

## The arms nothing reached at all

Lines 1927 to 1929, which drop a crossing *derivation* and count its withdrawn
home writes, report zero in every artifact of both runs. So do lines 1917 and
1918, the skip for a contribution some earlier seeding already withdrew. The
loop had one of its four arms exercised, by accident, and the arm that flapped
was not that one.

## What was done

Two days after this measurement, a pull request about WebSocket compression
was charged for the same line and paid it, adding
`commits contributions that do not target a failed foreign space` to
`packages/runner/test/executor-wave.test.ts` under the log line
`test(runner): stabilize foreign failure coverage`. That case seals a crossing
handler and a home-only derivation into a wave, fails the space, and asserts
the two dispositions. It settles the skip, and it leaves the drop arm beside it
where it was.

No source change here either: the wave is already a constructible object.
`WaveAccumulator` takes its space, lease, and replica lookup as arguments, and
`failForeignSpace` is a public method, so a test can seal the contributions it
wants into a wave, fail a space, and commit — with no serving loop deciding
what the wave contains.

The case that replaced it builds the wave with all three kinds of contribution
in it: an event handler that crossed into the space that fails, a derivation
that crossed into the same space, and a home-only derivation that did not. The
two cases set up the same wave, so keeping both would have stated the skip
twice and the drop arm not at all. It asserts the disposition of each — requeued,
dropped, committed — the requeued event id, the one withdrawn home write the
drop counted, that only the home space was ever handed a batch, that the failed
space's engine did not advance, and that of the three home writes only the
bystander's landed.

Two mutations confirm the case is not passing on the strength of the code being
correct elsewhere. Removing `if (!failed) continue;` withdraws the bystander
too, and the dispositions assertion fails on it. Disabling the withdrawal block
entirely leaves the crossings in the wave, a batch is built for the failed
space, the sink refuses it, and the wave aborts with `foreign-commit-failed`
where the case expects no abort.

That takes the skip to a nonzero count from the test file alone, and takes the
never-covered derivation drop arm with it. Lines 1917 and 1918 are left
alone: reaching them needs a wave in which one event's seal failed *and* a
foreign space failed to resolve, and stacking two unrelated failures to buy two
lines would be a worse test than the debt is worth. They are permanent debt in
both runs rather than movement, and are stable in the way that matters here —
nothing in the suite approaches them from either side.
