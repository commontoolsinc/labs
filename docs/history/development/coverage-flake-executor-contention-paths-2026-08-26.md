---
status: historical
created: 2026-08-26
archived: 2026-08-26
reason: "Investigation record: the ten uncovered lines that moved the `packages/runner` coverage count between a `main` run and the pull request measured against it."
---

# The three executor contention paths that no test asked for, August 2026

## Conclusion

[PR #6371](https://github.com/commontoolsinc/labs/pull/6371) changed no line of
`packages/runner/src/executor/`, and its Coverage Check job reported
`packages/runner` at 5727 uncovered lines against a `main` baseline of 5717.
The ten lines were charged to a pull request about reserved CFC documents.

They are three separate paths, and every one of them runs only when something
else already holds the state the path is about:

- `host.ts` 490–493, the arm that unregisters a space whose `SpaceServer`
  refused to activate, and 524, the early return of the helper that puts a
  refused activation's warm notices back;
- `space-server.ts` 829–831, the refusal itself — the parking report and the
  `false` that `activate()` returns when the space's execution lease is
  already held;
- `wave.ts` 2252–2253, the `continue` that lets an event's consequence mark
  commute with a concurrent append to the same stream sidecar.

The lease pair needs another process holding the lease at the moment a space
activates. The wave line needs an append landing on the sidecar between a
wave's basis and its commit. Neither is a thing any test in the suite asks
for, so both were reached the way an accident is reached.

## What the runs measured

The baseline is
[run 32995442343](https://github.com/commontoolsinc/labs/actions/runs/32995442343),
`main` at `9eff0ce0`. The pull request is
[run 32996009150](https://github.com/commontoolsinc/labs/actions/runs/32996009150),
which merged into `3c6e296b`. All three files are byte-identical at those two
commits, so line numbers and counts compare directly.

Each run uploads eight `coverage-profile-runner-*` artifacts. For each of the
three paths, exactly one of the eight ever enters it, and it is the same one in
both runs.

`host.ts` and `space-server.ts`, in `coverage-profile-runner-1` from
`Runner Tests (1/8)`:

| line | what it is | baseline | pull request |
| --- | --- | --- | --- |
| 488 | `const activated = await server.activate();` | 51 | 49 |
| 490–493 | the `!activated` arm: unregister, re-buffer, return | 2 | 0 |
| 828 | `if (!lease.acquire()) {` | 51 | 49 |
| 829–831 | the refusal: report `lease-unavailable`, return `false` | 2 | 0 |
| 524 | `if (consumedWarm.length === 0) return;` | 2 | 0 |

`wave.ts`, in `coverage-profile-runner-8` from `Runner Tests (8/8)`:

| line | what it is | baseline | pull request |
| --- | --- | --- | --- |
| 2244 | the `if (` opening the stream-sidecar refinement | 2 | 1 |
| 2252–2253 | `continue;` — the mark commutes with the append | 1 | 0 |
| 2254 | `return false;` — the general conflict verdict | 1 | 1 |

The guards ran in both runs, and roughly as often: 51 activations against 49,
the refinement evaluated twice against once. What moved is whether the
condition inside them was ever true. Deno's projection of V8's block ranges
onto lines reports a line holding an unexecuted block as uncovered however
often the code around it ran, so a run in which the branch is never taken
reports its lines at zero.

Line 524 is the sharpest case, because it is the first line of a method that
another artifact calls constantly. `coverage-profile-runner-6` reports the
method's signature line at 2 in both runs and line 524 at 0 in both: the
warm-request suite reaches the helper only through the throwing arm, and always
with warm notices to re-buffer, so it takes line 525 and never the early return
above it. The only run of the early return in either run of the whole suite is
the refused activation on shard 1, whose warm list is empty.

## Where the accidents came from

Shard 1 held `executor-serving-loop.test.ts`, the one file in the repository
that installs a rival lease holder: its `parks on lease loss when a rival holds
the lease` case releases the serving tenure's row and takes it under
`did:key:rival-process`. A park that leaves a client session live can chain a
re-activation, and a re-activation while the rival's row stands is a refused
activation. Whether that chained activation runs before the host closes is a
matter of what the park raced, which the case does not assert — it asserts
that the space parks — so the refusal happened twice on the baseline and not
at all on the pull request.

Shard 8's route to the wave refinement is not identified to a case. Running the
two shard-8 files that touch stream sidecars — `executor-events-down.test.ts`
and `stream-data-server-execution.test.ts` — reaches line 2244 and never line
2252, so the producer is elsewhere in the shard, and it is producing a
concurrent append inside a wave's window rather than asking for one.

Running the two shards locally against the same source reaches none of the ten
lines. That is the third measurement of the same fact: the lines move with what
the suite happens to interleave, not with the code.

## What was done

No source change. All three paths are reachable by construction, and the state
each needs is a row or a commit a test can write directly.

`executor-space-server.test.ts` gains a case that takes the space's lease under
a rival holder and calls `activate()`: it returns `false`, reports
`lease-unavailable`, builds no runtime, leaves the rival's row as it found it,
and counts no lease held. `executor-serving-loop.test.ts` gains the host's half
— the rival's row held, a client session opened, and an authored admission
fired, then `close()`, which awaits every activation in flight and so lands on
the refusal rather than guessing at its timing. Releasing the row and repeating
the trigger serves the space, so the refusal is the lease's doing rather than a
trigger that never fired. That second case reaches the empty-list early return
as well, because a session-open activation carries no warm notices.

`executor-wave.test.ts` gains the wave's half: an event delivered onto a stream,
its consequence mark sealed into a wave the way the dispatch seals it, a second
event delivered onto the same stream after the wave's basis, and the commit.
Both entries survive and the marked event commits rather than requeueing.

Two mutations confirm the cases are not passing on the strength of code
elsewhere. Making `lease.acquire()` succeed unconditionally fails both lease
cases. Removing the stream-sidecar refinement requeues the event, which is how
the wave case was checked before the load that makes the mark commit as a patch
was added — an unloaded document commits as a whole-document set, and a set
never commutes with anything.

One line in the lease pair is not independently pinned, and is worth naming.
`host.ts` 490's `this.#spaces.delete(space)` is redundant with the parking
callback, which deletes the same entry by identity when `activate()` reports
`lease-unavailable`; removing line 490 changes nothing observable. It is
covered rather than pinned, and no test can do better without a seam that does
not exist.
