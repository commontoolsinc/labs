---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "CPU attribution and acceptance snapshot for document-indexed pending schema policies."
---

# Pending schema-policy lookup profile

The synthetic 1,184-vote lunch-poll fixture used the reactive-row candidate from
PR #7317 at `14ece16b0437c73dc5280c6ac9190007c098d57c`, with the serving-instance
coordinator repair copied from its checkout based on main
`c92e122bd7ecf39b95d09abaad83ef79dccec355`. The indexed candidate additionally
contained this change's transaction-local schema-policy index. No live poll
was accessed.

The initial worker CPU profile attributed 65,426 ms of sampled self time to
`hasPendingSchemaPolicyInput()`, 20,556 ms to the transaction read-only proxy's
getter, and 13,831 ms to `readOnlyCfcView()`. Link writes repeatedly scanned the
whole transaction's policy-input history to find schemas for one document.

The candidate indexed the same frozen schema records by exact space and document
ID. It retained cross-scope matching and the existing path/IFC relevance checks.
The complete policy-input array remained available to commit preparation.

| Sampled self time | Initial profile | Indexed profile |
| --- | ---: | ---: |
| Pending schema-policy predicate | 65,426 ms | 6 ms |
| Read-only transaction proxy getter | 20,556 ms | 33 ms |
| Read-only view helper | 13,831 ms | 160 ms |
| Indexed document query | Not present | 26 ms |

Both profiled runs used `profile-cf.ts test` with `--timeout 600000` and
`--no-idempotency-check` for attribution. Both fixture assertions passed. Reported
fixture totals were 199,870 ms and 127,230 ms respectively. Other local validation
ran concurrently, and this was not an alternating controlled timing experiment;
these totals establish completed workloads, not a general speedup guarantee.
The indexed profile's largest named costs were garbage collection and dependency
ordering.

A separate candidate run used the CI action limit and ordinary idempotency checks:

```sh
deno task cf test \
  packages/patterns/integration/fixtures/lunch-poll-read-scale/1184-votes.test.tsx \
  --timeout 180000
```

It passed both assertions and unchanged read budgets in 127,868 ms. The first
render budgets remained 236,000 total / 96,000 maximum per run, and the update
budgets remained 214,000 / 96,000. An earlier invocation omitted `--timeout`, used
the CLI's 5,000 ms default, and failed teardown; it is excluded from acceptance.

The index narrows lookup to one document's schema history. It does not bound
that history, path traversal, dependency topology, or all CFC preparation work.
Raw CPU profiles and logs were retained locally under
`/tmp/b13-lunch-1184-{cpu,indexed-cpu}.*` and
`/tmp/b13-lunch-1184-policy-index-ci.log`.
