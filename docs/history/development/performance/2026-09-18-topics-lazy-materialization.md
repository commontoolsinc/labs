---
status: historical
created: 2026-09-18
archived: 2026-09-18
reason: "Measurement record of the headless Topics computation-cost matrix under lazy materialization on and off."
---

# Topics computation cost under lazy materialization on and off

The headless Topics computation-cost probe's full matrix, run once in each
mode, plus a repeat subset for a timing distribution. Taken for the
"Measurement and acceptance" section of `docs/plans/topics-computation-cost.md`,
which asks for both modes measured before the baseline report, in runs labeled
by mode.

Every sample, both arms, the repeat subset, the machine's load samples, and the
derived per-workload figures are in
[`2026-09-18-topics-lazy-materialization.results.json`](2026-09-18-topics-lazy-materialization.results.json)
beside this file. The figures below come from that file. This record says what
was measured and under what conditions; the interpretation belongs to the
baseline report.

## What ran

`scripts/topics-computation-cost.ts` at `fd9fa9a44b`, all 85 cases, once per
mode, with `--max-old-space-size=8192`. Each arm wrote an environment record,
85 samples across 85 distinct case ids, and a completion marker. No case
reached a heap limit in either arm. Every sample carries the mode its runtime
resolved, which the probe reads back off the runtime rather than taking from
the command line. Of the 85 cases, 59 are measured; the other 26 are `board`
cases, which the probe records as not measured and which start no process.

Wall clock: 1311 seconds with lazy materialization on, 1488 with it off.

The repeat subset ran later, at `2303bcc151`, five rounds per arm over the
`all-backlinks` cases at 4, 32 and 128 topics. The three 512-topic
`all-backlinks` cases were left out: they account for 1090 of the matrix's 2799
seconds and show no shape the smaller sizes do not.

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

The `none`-graph cases at 32 and 128 topics are the two of each pivot workload's
26 where mention removal is not measured, for the reason the probe records: no
topic mentions the focus topic.

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

## Timings, and where they support nothing

The two matrix arms ran on a shared machine carrying load averages of roughly
20 to 40 against 10 logical CPUs, with unrelated Deno, Python and Xcode
processes competing, and two toolsheds and a `cf piece new` were started during
the off arm. Their elapsed times are two single samples under contention. They
support no latency conclusion and the 1311-against-1488-second comparison
should not be read as one. The load samples are in the results file.

The repeat subset ran later at load averages of 2.7 to 6.7. Per case, five
rounds per arm, the phase time summed over each run:

| case, `high-degree` `all-backlinks` | on min/median/max | off min/median/max | median ratio |
| --- | --- | --- | --- |
| `mentions-3/topics-4` | 0.11 / 0.12 / 0.14 | 0.12 / 0.13 / 0.15 | 1.02x |
| `mentions-4/topics-32` | 0.61 / 0.68 / 0.71 | 1.01 / 1.05 / 1.07 | 1.55x |
| `mentions-4/topics-128` | 3.96 / 4.05 / 4.57 | 10.45 / 10.66 / 10.78 | 2.63x |
| `mentions-16/topics-128` | 5.92 / 6.06 / 6.25 | 24.26 / 24.82 / 25.50 | 4.10x |

Within an arm the spread is 1.03x to 1.22x. On the lower three cases the two
arms' ranges do not overlap, so those three support a latency statement. On the
4-topic case they do overlap, and the 30 milliseconds separating the medians is
the noise floor: that case supports no conclusion about the mode's cost, which
is a different statement from a 1.02x effect.

## What the counters do not vary with

Each case of the repeat subset produced one distinct set of counters across its
five rounds, in each arm, and that set equals the matrix arm's counters for the
same case. The second half of that also settles the head difference between the
subset and the matrix: the commit between them touched browser benchmark files
and documentation only, and the counters agreeing is the evidence that the
difference is inert for this measurement.

## What is not measured here

Server execution. The headless fixture builds its runtime over an emulated
storage manager in one process, with no memory server and no serving loop,
while the ON posture's serving loop is an `ExecutorHost` constructed over a
co-hosted memory server. Both modes in this record hold `serverExecution` off.
That posture is measured in the browser tier, which runs against a toolshed.
