---
status: historical
created: 2026-08-07
archived: 2026-08-07
reason: "Investigation finding: the settle behind the lunch-poll click flake returned before a wish's sidecar surface had arrived, now covered by scheduler background work."
---

# A settled view was one a wish surface had not reached yet

The lunch poll's voting test aims a trusted click at "Continue as guest"
(`#lp-guest-button`) after settling the page. The content directly above that
button is the `#profile` wish's create surface, and it arrives on its own
schedule. When it arrived between the aim and the dispatch it pushed the button
down and the click landed on the surface instead.

That much was established by following the click to the element it reached.
This record is about the layer below: why the surface was still on its way at a
moment the runtime had already reported itself settled.

## What the settle covered

`commonfabric.viewSettled()` in the shell waits for two things in a loop: the
worker reporting itself idle, and the Lit elements in the page finishing their
updates. The worker side is `RuntimeClient.idle()`, which is the scheduler's
`idleWithPendingCommits()` — reactive quiescence plus durability of in-flight
commits.

The `#profile` wish, when the user has no profile yet, sends a `[UI]` of
`cf-render` bound to a result cell, and only then starts filling that cell: it
fetches `api/patterns/system/profile-create.tsx`, compiles it, and runs it into
the cell. The profile picker and the suggestion sidecar are built the same way.

Between the send and the landing the scheduler has nothing to run. It is quiet
because it is waiting on a fetch, and quiet was the whole of what idle tested
for, so idle resolved. Nothing else in the chain closed the gap either: the
fetch is not registered with `runtime.trackAsyncWork`, so `runtime.settled()`
would not have covered it, and no cell the settle consults reflects it.
`profileCreatePatternReadyCell`, the one readiness signal in the launch, is
read only by the wish's own action, to re-run it once the pattern is available;
no settle path consults it, and it is never written on the paths where the
launch fails.

## Measurements

An inventory taken inside the page at the instant the settle reported the view
done and the click target was marked, over 30 runs before and 30 after of
`packages/patterns/integration/lunch-poll-vote.test.ts`, five concurrent
instances plus ten busy loops on an eighteen-core machine. The test clicks
"Continue as guest" twice, once on each browser: the host's is the first
interaction of the run, the guest's comes later, after the host has joined.

| at the settle that marked the click target | browser | before | after |
| ------------------------------------------ | ------- | ------ | ----- |
| no `#profile-create-surface` in the page    | guest   | 19/30  | 0/30  |
| no `#wish-profile-name-input` in the page   | guest   | 19/30  | 0/30  |
| no `#profile-create-surface` in the page    | host    | 0/30   | 0/30  |
| no `#wish-profile-name-input` in the page   | host    | 29/30  | 0/30  |

The two rows per browser are the same gap seen at two depths. On the guest the
outer surface was often not in the page at all. On the host it was, but the
name input inside it was not, on all but one. Either way the page was going to
grow where the settle had just said it was done.

How often the outer surface is missing tracks how loaded the machine is. The
same arm has read 11, 16 and 19 of 30 here, and 27 of 40 against an earlier
tree under heavier contention. What does not vary: the name-input row
sits at or near the whole sample in every "before" arm, and every figure in the
"after" column has been 0 in every arm measured. So what moves is how far
behind the launch runs, not whether the settle covers it.

The click this leads to misses more rarely than the gap itself, because the aim
holds for a layout box that is stable across two frames and the dispatch
re-measures its point as it goes. A miss needs the surface to land inside what
those two leave. One of the thirty runs before the change had a dispatch that
did not reach "Continue as guest", on the guest browser, with the create
surface absent from the page at the settle that marked the target — this gap
and not another mover. An earlier arm caught two in thirty the same way. None
of the runs after the change, in any arm, has produced one.

## What the fix does

The scheduler already has the concept: `backgroundTasks` holds work the runtime
has undertaken off the graph and whose result the graph is waiting on — a piece
being started so a queued event can be delivered — and `idle()` waits for it,
then re-checks every quiescence condition from scratch. `trackBackgroundTask`
exposes that, and the wish registers each sidecar launch with it, so the barrier
spans the fetch, the run it starts, and the commits that follow.

Everything built on idle inherits it, including `commonfabric.viewSettled()`,
with no change to the client protocol.

`runtime.settled()` would have been the wrong barrier. It also waits for
in-flight LLM calls and pattern-issued fetches, which leave the view
interactive while they run; putting every caller of idle behind those would
have traded this problem for a worse one.

## Why the surface sometimes never arrived at all

Waiting for `#wish-profile-name-input` before clicking was tried as a fix and
was worse: five of the first sixty runs never saw that field.

The profile-create launch had no failure path. The sidecar cache swallows a
fetch or compile error and resolves to `undefined`, and resolves to `undefined`
a second way — when a later fetch for a changed API URL supersedes the one in
flight. The launch tested for a pattern and did nothing at all when it did not
get one. Nothing re-triggers it: the wish action's only dependency on the launch
is the readiness cell, which is written on success and not on failure, and the
cache's `retryOnFailure` only clears the memo for a launch that never comes. So
the surface stayed blank for the life of the piece, with no account of why —
and a test that waits for the field waits forever.

The launch now writes the failure into the same cell the surface renders from,
as the picker already did.
