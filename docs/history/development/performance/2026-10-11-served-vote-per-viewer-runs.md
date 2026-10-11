---
status: historical
created: 2026-10-11
archived: 2026-10-11
reason: "Point-in-time record of where a served vote's derivation volume comes from: one run per connected session for every derivation downstream of a viewer read, measured on the lunch poll's vote burst, with the pattern change that removes it and the measurement window the burst now uses."
---

# A served vote costs one run per viewer: the lunch poll's derivation volume

All figures come from one 4-core container, at the code of
[commonfabric/labs#8691](https://github.com/commonfabric/labs/pull/8691)
after the serving-cycle plan closed
([the previous record](2026-10-11-serving-cycle-local-quiescence.md)). That
record left the 25-vote burst an order of magnitude above the client arm and
placed the remainder in what a vote re-derives on the serving side. This one
says what that is, and what a pattern change does to it. The last section says
how each number was taken.

## The measured window, first

The burst's clock used to stop at the voters' idle, their events' consequences
and the harness's settle, and on the OFF arm that is before the other voters'
pushed votes have reached a client. It now stops when every session's own vote
list, read at its runtime's quiescence and woken by the list's own changes,
holds exactly the round's rows, each voter's vote on each option at the value
cast this round: the moment each client's view is settled, on either arm. A
list that still holds a stale row never matches, however the counts come out,
so the window cannot close early on a partial delivery.

Under that window, five voters and five options, the poll as shipped:

| arm | burst, avg | range |
| --- | --- | --- |
| OFF | 445 ms | 350 to 800 ms, over two runs |
| ON, worker, read-through | 8.1 s | 6.6 to 8.8 s |
| ON, main thread, read-through | 10.6 s | 9.4 to 11.8 s |

The OFF figure is what the question was about: with the loop off, the time
until every client holds every vote is under half a second here, without a
renderer, where the earlier window read 408 ms. The ON arms sit where the
previous record left them; what follows is why.

## Where the serving thread's time goes

One burst on the main-thread arm with the read-through on, every timing span
the loop's realm emitted captured (44,388 spans over 14.7 s; the clients are
workers, so the realm is the serving runtime and the memory server):

| what | wall time, as a union of its spans |
| --- | --- |
| the whole burst | 14.7 s |
| scheduler passes (`scheduler/run`, 695 of them) | 8.6 s |
| of which action runs (2,175) | 5.1 s |
| of which re-subscription after a run (2,870) | 1.8 s |
| the memory server's fan-out to the five clients, on the same thread | 3.3 s |
| wave commits (91) | 1.5 s |

Per vote: 87 action runs in 28 scheduler passes, with 5 wave commits
interleaved as the 100 ms deadline cuts the settle. The traversals on this
thread are cheap and many (13,452 at 0.06 ms, 88% of them the memory server
re-walking a client subscription; the longest 12 ms), and the client is nearly
idle: one voter's realm emitted 1,101 spans over the same burst, 4.6 s of them
in its scheduler, 83 traversals in all with the longest at 66 ms inside a
handler's dependency pull. The 100 to 340 ms walks the previous records saw
were the serving runtime's own loads under the posture without the
read-through, and under the read-through they are on neither thread.

## The 87 runs: one per viewer

Grouping the action spans by the pass they ran in, each of the hot nodes runs
five times within one pass under five voters and three times under three,
whatever the option count:

| size (voters × options) | runs per vote | passes per vote | copies of one node within a pass |
| --- | --- | --- | --- |
| 5 × 5 | 87.0 | 27.8 | 5 (370 such groups), or 1 (325) |
| 3 × 5 | 58.2 | 28.1 | 3 (226), or 1 (195) |
| 5 × 3 | 72.7 | 24.9 | 5 (179), or 1 (195) |

That is the fan-out the specification states
([`docs/specs/server-side-execution/scopes.md`](../../../specs/server-side-execution/scopes.md)
§2): a derivation that reads a per-user value has one instance per demanding
user, one that reads a per-session value has one per demanding session, the
serving loop computes everyone's, and the scheduler's fan-out loop runs each
demanded instance in turn. Each voter here is one user with one session, so
the copies count the same at either scope: one per voter. The client arm never
meets it: each client computes only its own instance, and the poll's own
single-runtime test handles a vote in four passes.

What put the poll's whole graph on that path is one argument. `tallyOption`
took the viewer's profile to mark which vote in a tally is the viewer's own
(`isSelf` on each voter row), so the five option tallies were per-viewer, the
ranking over them was per-viewer, each card's rank and swatches were
per-viewer, and every one of them ran for every voter on every vote. The nodes
that ran five times per pass were exactly the tally, the ranking, each card's
rank, the option-card map and the cards' own lifts.

## The change

Two copies of the poll were measured the same way on the same thread before
the pattern was changed:

| poll | runs per vote | five-copy groups per burst | action time per burst | probe burst |
| --- | --- | --- | --- | --- |
| as shipped | 87.0 | 370 | 5.1 s | 14.7 s |
| tallies without the viewer (the marker dropped) | 30.5 | 25 | 1.7 s | 7.0 s |
| tallies without the viewer, the marker decided at the leaf | 34.7 | 63 | 1.9 s | 6.5 s |

The third row is the shape the pattern now has, with one difference: the
copy compared a key string the row carried with a key the viewer's profile
yielded, and the pattern compares the row's voter cell with the viewer's
profile cell by `equals`, in a `computed` at the swatch: the key comparison
did not ring the viewer's swatch in the poll's own test, and `equals`, which
the marker used before, does. The tally rows carry the voter cell and nothing of the viewer, so
the tally, the ranking and each card's rank are one derivation each; what runs
per viewer is the swatch's comparison. The burst under the measured window,
the pattern as it now is:

| arm | burst, avg | range | waves (cut) | scheduler settle per event |
| --- | --- | --- | --- | --- |
| OFF | 463 ms | 400 to 550 ms | — | — |
| ON, worker, read-through | 3.7 s | 3.1 to 4.3 s | 17 (15) | 50 ms |
| ON, main thread, read-through | 4.8 s | 4.5 to 6.1 s | 36 (34) | 72 ms |

The OFF arm does not move, since a client only ever derived its own instance.
The served burst halves and more: 8.1 s to 3.7 s under the worker, 10.6 s to
4.8 s on the main thread, the waves per burst from 36 to 17 under the worker,
and the derivations the scheduler runs after each vote's handler from 150 to
300 ms down to 50 to 72 ms. What remains over the client arm is now eight
times rather than eighteen, and it is still the serving runtime's derivation
per vote, no longer multiplied by the sessions: the pass count per vote, which
is the graph's depth, is what the next measurement is about.

The rule this leaves behind is in `docs/common/patterns/multi-user-patterns.md`
under "Keep the viewer out of shared derivations", and the pattern-dev and
pattern-critic skills point at it: a shared derivation that reads the viewer
is one derivation per viewer, per user or per session by what it read,
wherever a server derives it for everyone, so the viewer belongs at the leaf
that needs it.

## What this says about the three questions the previous record left

- **What the runs are.** Above: fan-out across sessions of a graph whose root
  reads the viewer, times the depth of that graph.
- **Why a pass costs 11 to 14 ms.** It does not, as such: a pass is one level
  of the graph, run once per viewer, at about 2.3 ms an action plus 0.6 ms to
  re-subscribe the union of the instances' reads. Five instances of one node
  is 12 ms. The pass count per vote, 28, is the graph's depth under the pull
  scheduler's one-frontier-per-iteration settle and does not change with the
  fix; the copies in each pass do.
- **The 100 to 340 ms schema walks.** The serving runtime's loads under the
  posture without the read-through, as the previous record placed them; with
  the read-through on, no traversal on the serving thread exceeds 12 ms and
  none on a client exceeds 66 ms over a burst.

## Read-through on the main thread

The previous record's main-thread read-through figures (14.4 and 15.0 s) were
taken while a type check or a test suite shared the box. Interleaved on an
otherwise idle box, the main thread runs the burst in 12.7 s without the
read-through and 10.0 s with it; a second pair, which overlapped with the
probes above, read 11.7 s and 13.7 s. The read-through is not slower on the
main thread; the difference between runs is the box.

## How the numbers were taken

The burst: `lunch-poll-vote-burst.bench.ts` at five voters and five options,
with `EXPERIMENTAL_SERVER_EXECUTION`, `SERVER_EXECUTION_WORKER` and
`SERVER_EXECUTION_STORE_READ_THROUGH` set per arm, under the measured window
this change gives it. The spans: a throwaway probe hosting the same harness in
the test process with the loop on its thread, `CF_TIMING_MEASURES` on for one
burst after two warm-ups, the loop realm's measures taken from its own
timeline and one voter's through the harness's `timingMeasures()`, both read
with the perf-investigation scripts (`attribute-measures.ts
--key=scheduler/run/action --detail` for the runs by node, `--key=traverse
--heavy` for the walks, `wall-time.ts` and a union over spans for the table).
The two poll copies were untracked copies of `packages/patterns/lunch-poll`
with the fixture's import pointed at them, and were deleted. The single-runtime
figure is `lunch-poll/read-cost.test.tsx` under `cf test --verbose
--stats-threshold 0`.
