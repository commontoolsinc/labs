---
status: historical
created: 2026-07-17
archived: 2026-07-17
reason: "F5 measurement attempt with the default integration harness; records that the true parity gate requires the retirement dial + doc-set-watch flag wired into the harness, which this run did not engage."
---

# F5 measurement attempt (default harness — retirement path NOT engaged)

Flag-off/flag-on default-app note-create pair at branch head `408d4e3a7`
(feed F1–F5 landed), `CF_NOTE_CREATE_TIMING_SERIES=10`, F1 traverse
attribution.

## What this run did and did not measure

**It did not engage the F3/F4/F5 retirement path.** The doc-set-watch
client flag (`EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH`) is
absent-false and the standard integration harness does not set it, and the
per-space graph-retirement dial is host-internal (not env-reachable) and
was not wired into the toolshed for this run. So the client kept its
schema-graph watches and none of F4b's demotion / F5's retirement fired.
This measures the **F1/F2-landed state only**, and it carries the large
run-to-run variance the earlier reports already noted.

## Numbers (n=20 per leg)

| Leg | avg | p50 | p95 |
| --- | ---: | ---: | ---: |
| flag-off | 685 ms | 704 ms | 896 ms |
| flag-on | 823 ms | 802 ms | 1162 ms |

Gap +20% avg — worse than the FA12 archived baseline's +10.6%, within the
run-to-run swing this workload shows (the FA12 pair and the post-F2
acceptance disagreed by ~100× on `graph.query` DAG count). Traverse
attribution this run: flag-on `graph.query` 58,206 DAG / `session.watch.refresh`
99,085 DAG — i.e. the graph path is fully live because the doc-set path
was not engaged; `docs.read` fired only 179 reads / 0 DAG (F2's executor
point reads, the one retirement path that is always-on).

## The real F5 gate is still owed

The parity gate is not passable from the default harness. To measure it,
the harness must (1) set the client doc-set-watch flag so F4b demotes the
space lane's graph watches, and (2) enable the per-space retirement dial
(`setServerPrimaryExecutionGraphRetirementConfig`) for the app space at
toolshed startup under a measurement env flag. With both on, `session.watch.refresh`
DAG traversals should collapse the way `graph.query` did under F2, and the
note-create series should be re-compared to the FA12 baseline. That
harness wiring is the immediate next F5 task; the mechanism itself is
pinned green by `v2-feed-retirement-test.ts`.

This report is a factual record of an inconclusive run, not a gate result.
