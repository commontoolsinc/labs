---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Investigation findings behind splitting `cfcheck` into one test-selection unit per pattern."
---

# Where the pattern type check spends its time

Measured on 2026-09-15 against labs `f0d0608e9e`, on one workstation
(Apple silicon, Deno 2.9.4), over the 414 authored pattern entry files
`tasks/pattern-files.ts` collected that day. Every figure below is wall
clock from that machine. A continuous-integration runner is slower: the
test-selection cost model fitted `cfcheck` an overhead of about 167
seconds against lane measurements, where the same whole run took about
63 seconds here, so CI figures are roughly 2.6 times these.

The question this was run to answer: `cfcheck` was one unit of the
test-selection topology, so a lane either paid for the whole pattern
corpus or skipped all of it. Splitting it into one unit per pattern is
worth doing only if the cost actually divides — if the run were dominated
by a fixed startup that every split would pay again, a finer grain would
make things worse rather than better.

## The cost divides

Whole-process runs of `deno task cfcheck`, warm:

| Patterns | Wall clock |
| --- | --- |
| 2 | 1.6 s |
| 52 (`CFCHECK_SHARD=1/8`) | 11.3 s |
| 414 | 62.4 s, 63.7 s |

A straight line through the 52-pattern and 414-pattern points puts the
fixed cost at about 3.9 seconds and the marginal cost at about 0.14
seconds a pattern; the 2-pattern point puts the fixed cost nearer 1.2
seconds. So the fixed part is somewhere between one and four seconds, and
the run is 94% or more variable.

Four disjoint slices of 100 patterns each, checked in isolation, cost 8.9
s, 10.4 s, 32.0 s and 11.8 s — 63.2 seconds between them, against 65 to
71 seconds for one run over all of them. Splitting the corpus into four
invocations therefore costs about what one invocation costs.

The third slice is three times the cost of its neighbors. The
per-pattern figures below say why: 46 of its 100 patterns are the
`packages/patterns/google/` tree, which at 452 ms a pattern is the most
expensive tree in the corpus and holds 20.8 of the run's 57.2 attributed
seconds.

## What the time is

Inside one batched TypeScript program over all 414 patterns (1,729
authored files):

| Phase | Time | Share |
| --- | --- | --- |
| `ts.createProgram` — parse and bind | 0.4 s | 0.5% |
| Per-file semantic and syntactic diagnostics | 14.8 s | 22% |
| Transform and emit | 51.3 s | 77% |

The type check is not the expensive part. The Common Fabric transformer
pipeline, which runs during emit, is.

Both of the expensive phases are already per-file work.
`getSemanticDiagnostics()` takes a source file, and `emit()` takes an
optional target source file. Emitting a file at a time rather than the
whole program at once was measured as output-identical — 542 writes and
8,559,880 bytes either way on a 52-pattern shard — and no slower, 41.9 s
against 51.3 s over the whole corpus and 6.9 s against 6.6 s on the
shard.

## Every file belongs to exactly one pattern

The batch prefixes each program's files with that program's own
content-derived identity, so two patterns that both import one helper
carry two prefixed copies of it and the union holds both. Over the 414
patterns, 422 distinct source files become 1,730 entries in the batch.
Attribution therefore needs no convention for shared files: a file's
prefix names the one program it came from.

## What a pattern costs

With each file's diagnostics and emit timed and charged to the program
that resolved it, a whole run attributes 57.2 seconds of a 67.0-second
process. The remaining 10 seconds is process startup, module loading,
runtime construction, resolution, and the program-wide parse and bind.

Per-pattern figures across the corpus: minimum 1 ms, tenth percentile 5
ms, median 29 ms, ninetieth percentile 401 ms, maximum 2,400 ms. The
spread is a factor of 2,400, which is why dividing the run's total evenly
would have been a poor substitute for measuring it.

By tree, over the attributed 57.2 seconds:

| Tree | Patterns | Total | Each |
| --- | --- | --- | --- |
| `packages/patterns/google` | 46 | 20.8 s | 452 ms |
| `packages/patterns/catalog` | 70 | 6.5 s | 93 ms |
| `packages/patterns/system` | 22 | 4.4 s | 201 ms |
| `packages/connectors` | 5 | 2.9 s | 578 ms |
| `packages/patterns/factory-outputs` | 3 | 2.9 s | 959 ms |

The two most expensive single patterns are
`packages/patterns/google/extractors/email-pattern-launcher.tsx` at 2,400
ms and `email-pattern-dreamer.tsx` beside it at 2,328 ms.

## What a filtered run costs

`deno task cfcheck --only <path>` repeated over a sample spread evenly
through the corpus:

| Patterns | Wall clock |
| --- | --- |
| 1 | 1.2 s |
| 5 | 2.1 s |
| 10 | 3.4 s |
| 25 | 6.9 s |
| 50 | 13.1 s |
| 100 | 22.2 s |
| 414 | 62–67 s |

A change touching ten patterns costs 3.4 seconds here against 63 seconds
for the whole gate.

## The records migration

There was none to make. `tasks/cfcheck.ts` already wrote one record per
pattern, named `cfcheck <path>`, and the topology already recognized
those names — it mapped all of them to the single unit. Splitting the
suite changed which unit each record locates to, and renamed nothing, so
`tasks/test-identity-aliases.jsonl` took no line. What did change is the
durations those records carry, which were zero and are now measured.
