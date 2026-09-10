---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Initial incremental aggregate read-work and paired update measurements."
---

# Incremental aggregate comparison

Measured the aggregate implementation on `codex/incremental-aggregates`, based
on `89e5524c23` (instrumentation PR #7246), with Deno 2.9.4 on an Apple M5.
These measurements cover compiled patterns using explicit `Writable` array
inputs. The implementation and its contracts are described in
[collection aggregates](../../../features/collection-aggregates.md).

At 1,000 independently linked rows, all six named operations reduced update
read work and had lower observed p75 update time than generic reductions.
Initialization was more expensive. Other validation processes were active on
the machine: the timings are exploratory observations under contention, not
isolated-machine performance estimates. The deterministic read-budget tests
provide the stronger evidence about scaling.

## Measurement boundaries

`packages/runner/test/aggregate-comparison.ts` constructs a fresh generic and
incremental graph for each operation and size. It settles initialization,
disables read accounting, performs one warmup update, then times twelve updates
while alternating which implementation runs first. Each timed update includes
the source commit, scheduler settlement, result pull, and correctness check.
A separate update enables counters and records all completed scheduler actions,
including result sinks and pulls. Disposal is outside the timing.

Initialization time includes read accounting, source commit, graph startup, and
initial settlement; it excludes pattern compilation and staging source cells.
Initialization read counts cover scheduler actions, not source construction.
Consequently initialization and update milliseconds have different accounting
settings and should not be compared as equal-cost samples.

Count uses a numeric-field predicate. Sum/min/max operate on links to numeric
fields. The By forms score linked row objects and return the original element.
Extrema updates alternate between making the changed row the winner and making
another row the winner. These fixtures use finite integers and distinct scores,
so both implementations agree despite their different floating-point and tie
contracts outside this workload.

Reproduce the JSON-line report from the repository root:

```sh
ENV=test deno run --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders packages/runner/test/aggregate-comparison.ts
```

`packages/runner/test/aggregate.bench.ts` additionally registers conventional
Deno benchmarks for the same six names and three sizes. Each benchmark
invocation initializes a fresh graph and times its first committed update.

## Update time at 1,000 rows

| Operation | Generic p75 ms | Incremental p75 ms | Observed ratio |
| --- | ---: | ---: | ---: |
| count | 255.04 | 140.15 | 1.82x |
| sum | 191.84 | 90.72 | 2.11x |
| min | 200.24 | 54.20 | 3.69x |
| max | 196.50 | 34.68 | 5.67x |
| minBy | 275.81 | 103.58 | 2.66x |
| maxBy | 194.19 | 57.08 | 3.40x |

## Proxy-access scaling

Each cell shows generic / incremental accesses during the separate counted
update. Every counted update also checks the settled result.

| Operation | 10 rows | 100 rows | 1,000 rows |
| --- | ---: | ---: | ---: |
| count | 21 / 23 | 201 / 57 | 2001 / 77 |
| sum | 11 / 21 | 101 / 71 | 1001 / 113 |
| min | 11 / 41 | 101 / 110 | 1001 / 146 |
| max | 11 / 41 | 101 / 110 | 1001 / 146 |
| minBy | 31 / 54 | 301 / 123 | 3001 / 159 |
| maxBy | 31 / 54 | 301 / 123 | 3001 / 159 |

## Whole-graph work at 1,000 rows

Each cell shows generic / incremental counts. Distinct documents are counted
separately per action and summed, rather than deduplicated across the graph.

| Operation | Runs | Link resolutions | Document reads | Registered dependencies |
| --- | ---: | ---: | ---: | ---: |
| count | 3 / 9 | 1005 / 93 | 1008 / 78 | 5018 / 258 |
| sum | 3 / 8 | 1005 / 94 | 1008 / 79 | 3018 / 340 |
| min | 3 / 8 | 1005 / 102 | 1008 / 87 | 3018 / 425 |
| max | 3 / 8 | 1005 / 102 | 1008 / 87 | 3018 / 423 |
| minBy | 3 / 8 | 1009 / 106 | 1010 / 85 | 5026 / 438 |
| maxBy | 3 / 8 | 1009 / 106 | 1010 / 85 | 5026 / 436 |

## Initialization and small-input timings

Each cell shows generic / incremental measurements. Startup costs include the
additional durable tree and, for predicate count, per-element callback runs.
Small inputs often favor the generic reduction. These are single initialization
observations and twelve-sample update p75s, with the contention noted above.

| Operation | Rows | Initialization ms | Initial runs | Initial proxy accesses | Update p75 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| count | 10 | 117.5 / 220.4 | 4 / 17 | 21 / 41 | 16.34 / 17.50 |
| count | 100 | 672.5 / 3826.6 | 4 / 114 | 201 / 410 | 163.34 / 116.45 |
| count | 1,000 | 2325.5 / 53854.1 | 4 / 1070 | 2001 / 4094 | 255.04 / 140.15 |
| sum | 10 | 41.0 / 95.7 | 4 / 10 | 11 / 22 | 15.50 / 18.92 |
| sum | 100 | 144.9 / 1316.2 | 4 / 16 | 101 / 235 | 108.84 / 111.11 |
| sum | 1,000 | 499.6 / 4901.8 | 4 / 72 | 1001 / 2343 | 191.84 / 90.72 |
| min | 10 | 66.7 / 78.7 | 4 / 10 | 11 / 42 | 13.67 / 18.58 |
| min | 100 | 254.3 / 1455.0 | 4 / 16 | 101 / 418 | 157.10 / 129.14 |
| min | 1,000 | 922.3 / 2674.2 | 4 / 72 | 1001 / 4158 | 200.24 / 54.20 |
| max | 10 | 22.4 / 336.6 | 4 / 9 | 11 / 42 | 13.96 / 25.08 |
| max | 100 | 165.0 / 1897.4 | 4 / 16 | 101 / 418 | 45.68 / 252.96 |
| max | 1,000 | 865.0 / 2972.1 | 4 / 72 | 1001 / 4158 | 196.50 / 34.68 |
| minBy | 10 | 145.0 / 258.6 | 4 / 8 | 31 / 54 | 33.81 / 26.16 |
| minBy | 100 | 506.6 / 3412.7 | 4 / 14 | 301 / 430 | 139.93 / 84.78 |
| minBy | 1,000 | 930.9 / 13475.6 | 4 / 70 | 3001 / 4170 | 275.81 / 103.58 |
| maxBy | 10 | 237.6 / 325.0 | 4 / 8 | 31 / 54 | 24.11 / 31.81 |
| maxBy | 100 | 523.5 / 2601.6 | 4 / 14 | 301 / 430 | 179.82 / 176.46 |
| maxBy | 1,000 | 783.0 / 17756.9 | 4 / 70 | 3001 / 4170 | 194.19 / 57.08 |

## Interpretation and remaining boundaries

The maintained tree recomputes a block of at most 32 members and its ancestors.
The 1,000-row tests bound every update of each named operation below 250 proxy
accesses and 500 link resolutions, including winner changes. A separate sum
scaling test compares 10, 100, and 1,000 linked members against full reduction.

The measurements exposed two avoidable coordinator reruns: the map scope check
read every scalar callback output, and aggregate publication followed the
selected output link. Topology-only first-hop probing and direct root-link
publication removed those dependencies. A session-selection regression guards
scope preservation through a space-to-session-to-space link chain.

Initialization and membership reconciliation still read O(N) identities and
sort them in O(N log N); membership edits can rebuild many blocks. Inline
primitive edits also use that reconciliation path. Captures or callback array
reads can invalidate all callbacks. These measurements establish the linked
single-row update benefit, not cheap appends or uniformly faster small arrays.
The public types require explicit Cell/Writable receivers; native-looking array
inputs and chained `map(...).sum()` remain outside this API surface.
