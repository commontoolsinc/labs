---
status: historical
created: 2026-09-18
archived: 2026-09-18
reason: "Measurement record of the headless Topics computation-cost matrix under lazy materialization on and off, with the server-execution engagement probe beside it."
---

# Topics computation cost under lazy materialization on and off

The headless Topics computation-cost probe's full matrix, run once in each
mode, an alternating repeat subset for a timing distribution, and a probe of
whether server execution's ON posture engages at all. Taken for the
"Measurement and acceptance" section of `docs/plans/topics-computation-cost.md`,
which asks for both modes measured before the baseline report, in runs labeled
by mode.

Every sample, both arms, both orderings of the repeat subset, the engagement
probe, the machine's load samples, and the derived per-workload figures are in
[`2026-09-18-topics-lazy-materialization.results.json`](2026-09-18-topics-lazy-materialization.results.json)
beside this file. The figures below come from that file. This record says what
was measured and under what conditions; the interpretation belongs to the
baseline report.

## What ran

`scripts/topics-computation-cost.ts` at `fd9fa9a44b`, all 85 cases, once per
mode, with `--max-old-space-size=8192`. Each arm wrote an environment record,
85 samples across 85 distinct case ids, and a completion marker. No case
reached a heap limit in either arm.

Of the 85 cases, 59 are measured. Each of those carries the mode its runtime
reported, read back off the runtime rather than taken from the command line.
The other 26 are `board` cases: the probe records them as not measured, they
start no process and no runtime, and their samples carry the mode the run was
given, which is the only statement of it available where nothing ran.

Wall clock: 1311 seconds with lazy materialization on, 1488 with it off.

## The effect depends on the workload

With lazy materialization off, `backlinksOf` re-runs for every topic on the
`all-backlinks` workload and does not change its run count at all on the
others. Counted over the mention-removal phase, in the cases where that phase
is measured:

| workload | cases measured | `backlinksOf` run count changes | link-resolution ratio |
| --- | --- | --- | --- |
| `topic-open` | 24 | 0 | 0.74x to 5.71x |
| `all-backlinks` | 24 | 24 | 2.95x to 1019.69x |
| `aggregates` | 7 | 0 | no backlinks demanded |

The `none`-graph cases at 32 and 128 topics are the two of each pivot
workload's 26 where mention removal is not measured, for the reason the probe
records: no topic mentions the focus topic.

`aggregates` is a third answer rather than a variant of the other two: that
workload demands every topic's comment count and last activity and no
backlinks, so mention removal moves nothing in it either way.

The largest ratio and the largest absolute count fall on different cases.
`pivot/low-degree/mentions-4/topics-512/all-backlinks` goes from 1,544 link
resolutions to 1,574,400, a factor of 1019.69.
`pivot/high-degree/mentions-4/topics-512/all-backlinks` reaches the same
1,574,400 from 2,051, a factor of 767.63. Both re-run `backlinksOf` 512 times
against once.

On `topic-open` the link resolutions move in both directions, and which way
turns on mentions per source rather than on the mention graph's shape. At 128
topics, high-degree: 515 to 387 at one mention per source, 515 to 771 at four,
515 to 2,307 at sixteen.

## Proxy accesses do not exist with lazy materialization off

All 59 measured cases carry nonzero `proxyAccesses` in the on arm, and none of
the 59 does in the off arm. Summed over every measured phase of every case:
4,309,029 completed-body accesses and 4,309,029 transaction-attempt accesses
on, against zero and zero off. Three of the five counts a read-budget limit
gates are proxy-access counts, which is why the probe's `--derive-limits` path
takes the default mode and refuses `--mode`.

## Timings

The two matrix arms ran on a shared machine carrying load averages of roughly
20 to 40 against 10 logical CPUs, with unrelated Deno, Python and Xcode
processes competing, and two toolsheds and a `cf piece new` were started during
the off arm. Their elapsed times are two single samples under contention. They
support no latency conclusion and the 1311-against-1488-second comparison
should not be read as one. The load samples are in the results file.

The timing claims come instead from a repeat subset of four `high-degree`
`all-backlinks` cases — `mentions-3/topics-4`, `mentions-4/topics-32`,
`mentions-4/topics-128` and `mentions-16/topics-128` — which the probe selects
by `--filter`. The three 512-topic `all-backlinks` cases are left out because
they account for 1090 of the matrix's 2799 seconds.

That subset was run twice. The first run was batched, five rounds of one arm
then five of the other; the second alternated, on and off in turn for five
rounds, as the plan requires so that drift over a sitting falls on both arms
rather than correlating with one. Both are in the results file. **Only the
alternating run is used below**, and the two disagree enough to matter: they
differ by up to 16% on individual ratios, and they disagree about whether the
4-topic case separates at all.

Alternating, five rounds per arm, phase time summed over each run, in
milliseconds:

| case | on min/median/max | off min/median/max | median ratio | gap between ranges |
| --- | --- | --- | --- | --- |
| `mentions-3/topics-4` | 114.7 / 115.8 / 121.5 | 122.0 / 126.8 / 134.9 | 1.09x | 0.5 |
| `mentions-4/topics-32` | 569.2 / 613.4 / 707.7 | 1046.7 / 1102.4 / 1384.7 | 1.80x | 339.1 |
| `mentions-4/topics-128` | 4335.2 / 4718.9 / 4972.8 | 10657.4 / 11346.4 / 11665.8 | 2.40x | 5,685 |
| `mentions-16/topics-128` | 5914.5 / 6108.5 / 6974.4 | 24615.5 / 25440.7 / 27329.3 | 4.17x | 17,641 |

The two arms' ranges do not overlap on any of the four. On the three larger
cases the gap between them runs from 339 milliseconds to 17.6 seconds, far
wider than the spread within either arm, and those three support a latency
statement. The 4-topic case is separated by 0.5 milliseconds on a
116-millisecond operation: its five rounds happen to fall either side of a
line, the batched run put it the other way, and it is better read as suggestive
than as established.

## What the counters do not vary with

Each case of the alternating subset produced one distinct set of counters
across its five rounds, in each arm, and each set equals the matrix arm's
counters for the same case.

Rounds 2 to 5 of the alternating subset ran with uncommitted edits in the tree,
to browser benchmark files and documentation, which the headless probe does not
load. Those rounds' counters equal round 1's, taken with a clean tree, and
equal the matrix arms'. That equality is the evidence the edits are inert here;
alternating also puts any effect they could have had on both arms. The same
argument covers the head difference between the subset and the matrix.

## Server execution engages, and its cost is not measured here

The headless fixture builds its runtime over an emulated storage manager in one
process, with no memory server and no serving loop, while the ON posture's
serving loop is an `ExecutorHost` constructed over a co-hosted memory server.
Both modes above hold `serverExecution` off, and nothing in the matrix
exercises that posture.

A separate probe established that the posture does engage where a toolshed
runs. Two source-run toolsheds on `fd9fa9a44b`, identical but for
`EXPERIMENTAL_SERVER_EXECUTION`: the ON one logged its serving loop starting,
carried a `servingLoop` block on `/api/health/stats`, and reported
`serverExecution: true` on `/api/meta`; the OFF one did none of the three. That
block is present exactly when an `ExecutorHost` runs in the process, so its
presence is the host running rather than a proxy for it.

Deploying the Topics pattern at the ON toolshed with `cf piece new` moved the
counters: `activeSpaces` reached 2 while the session was open, and the
cumulative counters recorded 10 waves, 2 authored transactions seen and 10
derived commits across two spaces, with no structure-load failures. So the loop
served the work rather than merely existing. `activeSpaces` is a gauge and
reads 0 once the session closes; the cumulative counters are what persist.

That probe establishes engagement only. Its client was the `cf` CLI rather than
a browser, and a source-run toolshed serves no built shell, so it says nothing
about whether a browser arm runs coherently — which needs a shell built at the
same posture as the toolshed serves at. The cost of server execution is not
measured in either tier.
