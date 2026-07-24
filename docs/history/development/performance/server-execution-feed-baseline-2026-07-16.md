---
status: historical
created: 2026-07-16
archived: 2026-07-16
reason: "FA12 archived baseline pair: fresh flag-off/flag-on note-create series with per-source traverse attribution from the F1 counters. The reference the F5 parity gate compares against."
---

# Feed baseline pair (FA12): note-create parity and traverse attribution

Fresh flag-off/flag-on default-app pair at branch head `d04a6bd22`
(C1.1–C1.5a + F1 + the amended F-table), `CF_NOTE_CREATE_TIMING_SERIES=10`,
attribution from the F1 `serverExecutionFeed` counters. This document is
the baseline the F5 gate is judged against (never unarchived plan-text
numbers, per FA12).

## Note-create series (n=20 measurements per leg)

| Leg | avg | p50 | p95 | min | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| flag-off | 691 ms | 678 ms | 1085 ms | 477 | 1085 |
| flag-on | 764 ms | 704 ms | 1420 ms | 407 | 1420 |

Gap: **+10.6% avg, +3.8% p50** (was ~+34% at the W2.10 re-probe; the
Phase 2.5/2.6 hardening — shadow-read rebase, claim coverage, materializer
serving — closed most of it). p95 tail (+31%) is where the remaining
traversal cost shows. The W2.9 bar remains parity-within-noise; the tail
is the feed's remaining work.

## Traverse attribution per source (whole run)

| Operation | flag-off calls/reads/DAG | flag-on calls/reads/DAG |
| --- | --- | --- |
| `graph.query` (executor Worker) | 8 / 8 / 0 | **1,420 / 94,717 / 171,482** |
| `session.watch.refresh` (per-session) | 138 / 14,334 / 10,086 | 147 / 16,684 / **94,098** |
| `session.watch.add` (registration) | 366 / 463 / 4,439 | 324 / 720 / 4,445 |

FA12(b) satisfied: the two named sources fully dominate the flag-on delta
— `graph.query` is essentially absent flag-off and explodes flag-on (the
F2 target), and `session.watch.refresh` deepens ~9× in DAG traversals at
flat call count (the F5 target). Registration cost is flat. No re-scope
of the F-table is needed.

## Reading

C1.5b → F2 removes the dominant source (171k DAG traversals/run); F5
retires the per-session residual against this document's numbers. The
per-space keying and wall-clock attribution remain FA12(c) residuals for
F1, to be added before the F5 gate is attempted.
