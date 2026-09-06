---
status: historical
created: 2026-09-04
archived: 2026-09-04
reason: "Decomposition of the CFC label join's cost across the two changes that closed it, the measurement behind the deduplication's scan limit, and a third accumulating fold that was measured and left alone."
---

# What the two halves of the CFC label join fix each bought, September 2026

The starting point was a finding left open by
[the persisted-flow-label investigation](2026-09-cfc-gate-read-set-eager-build.md):
`uniqueCfcAtoms` costs the square of its input, and the two callers that join
labels merge one entry at a time into an accumulator that is re-deduplicated at
every step, so joining N entries costs N times the square of the result. That
investigation counted 3.28 billion `deepEqual` comparisons inside
`uniqueCfcAtoms` over one connectors test run, with the largest single call
holding 3,402 atoms. Two changes closed it, and this records how much each was
worth, since neither could be inferred from the other.

The measurements below were taken against the fix that investigation shipped,
which stops the write gate resolving read labels that nothing consults. That
routes an unprotected write target around the cost rather than removing it, so
the benchmark writes to a target declaring a confidentiality ceiling, which is
what makes the gate consult the labels.

## The decomposition

Measured on an Apple M5 Max, Deno 2.9.4, with
`packages/runner/test/cfc-label-join.bench.ts`: one prepare that reads a
document at its root under `cfcFlowLabels: "persist"` and writes to a
protected target, over stored label maps of 8, 64 and 256 entries, each entry
carrying an integrity atom naming its own path so that no two contribute the
same atom. Only the prepare is timed. The figure is the fastest sample of
three interleaved rounds, the arms alternating within each round because the
machine was shared.

| entries | neither | join once | keyed dedup | both |
| ---: | ---: | ---: | ---: | ---: |
| 8 | 185.5 µs | 188.9 µs | 218.6 µs | 183.3 µs |
| 64 | 15.27 ms | 1.92 ms | 6.12 ms | 972.3 µs |
| 256 | 1.18 s | 27.65 ms | 66.86 ms | 8.61 ms |

Collecting a join's parts and deduplicating once carries most of it — 43
times at 256 entries on its own. Keying the deduplication carries 18 times on
its own, and multiplies what the first leaves: twice over the join alone at 64
entries and three times at 256. Together they are 137 times. At 8 entries the
transaction the prepare runs over is most of the number and none of the arms
separate.

The reason neither is redundant is that they remove different factors. The
join removes the repetition — one deduplication per entry merged becomes one
for the join — and the key removes the square inside whichever deduplications
remain. A workload where the surviving deduplication is small would see
almost nothing from the second, which is why the first measurement above was
the one that had to be taken rather than assumed: an adversarial review of
the change, given the diff and no measurement, predicted the key would not
pay and recommended dropping it.

## Where the scan limit came from

`uniqueCfcAtoms` scans while the kept set is short and groups past a limit,
because keying an atom walks the whole of it while a comparison against a
different atom stops at the first property where they differ. The ratio
between those two costs is a property of the atoms, not of the list, so no
limit is right everywhere. Measured over lists of distinct atoms, with the
scan and the grouped deduplication run against the same lists:

| n | same shape, scan | limit 8 | limit 16 | limit 32 | early, scan | limit 8 | limit 16 | limit 32 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 9 | 4.3 µs | 4.3 µs | 4.3 µs | 4.2 µs | 878.8 ns | 883.8 ns | 873.3 ns | 860.4 ns |
| 12 | 7.7 µs | 10.3 µs | 7.8 µs | 7.9 µs | 1.5 µs | 6.4 µs | 1.5 µs | 1.5 µs |
| 16 | 14.2 µs | 11.8 µs | 14.0 µs | 14.6 µs | 2.7 µs | 8.0 µs | 2.6 µs | 2.6 µs |
| 24 | 32.3 µs | 15.5 µs | 27.1 µs | 32.4 µs | 6.0 µs | 12.0 µs | 14.1 µs | 5.9 µs |
| 32 | 58.7 µs | 19.4 µs | 31.3 µs | 58.7 µs | 10.6 µs | 16.0 µs | 17.9 µs | 10.7 µs |
| 48 | 138.8 µs | 27.2 µs | 40.0 µs | 86.8 µs | 24.6 µs | 22.9 µs | 25.2 µs | 34.1 µs |
| 64 | 245.8 µs | 35.4 µs | 45.9 µs | 94.7 µs | 43.4 µs | 30.1 µs | 32.3 µs | 40.6 µs |
| 128 | 969.8 µs | 64.9 µs | 76.4 µs | 124.8 µs | 166.9 µs | 60.0 µs | 61.9 µs | 70.0 µs |

"Same shape" atoms agree until their last property, so a comparison walks the
whole atom. "Early" atoms differ at their first, so a comparison exits at once
and the key costs the most relative to it. Every limit leaves a band just
above itself where grouping loses to the scan on early-differing atoms, and
the band's depth falls as the limit rises — 4.3 times at a limit of 8, 2.3 at
16, 1.4 at 32 — because the band sits where the scan it replaces is longer.
What a higher limit costs is the scan it keeps doing before it switches, which
at 128 atoms is 18% between 8 and 16 and another 63% between 16 and 32. 16 is
where those two meet.

## A third accumulating fold, measured and left

`coalesceLabelEntries` in `packages/runner/src/cfc/prepare.ts` merges every
label-map entry sharing a (path, origin, class) key into one accumulator,
pairwise, which is the same shape as the two joins the change fixed. Counting
how many entries share one key within a single call, over the 179 runner CFC
test files, the largest was 20. That is short enough that the fold there is
not the cost the change is about, so it was left as it is. The count is per
call; the same key accumulates 330 entries across a whole test run, which is
the number to not mistake for it.

## How the labels were held fixed

Two ways, because the argument that the change is behavior-preserving by
construction is exactly the argument worth checking.

Every call to `uniqueCfcAtoms`, `labelForEntriesAtPath` and
`effectiveReadLabel` was made to compute the replaced version alongside the
new one and throw on any difference, and the runner, agents-host and piece
suites were run against that build. Separately, every CFC envelope the runner
CFC test files persist was recorded in canonical form on both arms and
compared: 720 writes, identical once each run's freshly minted identity and
entity tokens are normalized by first appearance. Two runs of the same arm
were compared first, to establish that the recording is reproducible at all.
