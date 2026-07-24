---
status: historical
created: 2026-07-16
archived: 2026-07-16
reason: "First measured F1 coverage report: the OQ4 per-space rollout-gate input and the traverse attribution that orders the feed work (F2 before F5)."
---

# Feed coverage and traverse attribution (first F1-instrumented run)

One flag-on default-app run (placement guard green) at branch head
`c6893f0bd` (C1.1–C1.5a + F1), read from the new
`/api/health/stats` counters rather than log grep.

## Claim coverage (the OQ4 rollout-gate input)

- `claimsIssuedByContextKey`: `{space: 22}` — user-rank dial off, as
  designed pre-C1.9.
- `candidateClaimReadyBySpace`: 39 claim-ready candidates in the app
  space.
- `candidateUnservedByCode` (with distinct offenders): the known,
  fully-named composition — `incomplete-static-surface` ×4 (1 offender:
  the recorded `wish` deferral), `dynamic-write-outside-static-surface`
  ×5 (1 offender: materializer first-reconcile de-claims, by design),
  `commit-rejected:ExecutionLeaseFenceError` ×4 (the pre-C2
  `claim-context-mismatch` tolerance; per-cause detail in
  `leaseFenceRejectCauses`), `claim-authority-lost` ×17 (teardown
  revocations), `malformed-action-observation` ×2 (observation-less
  commit noise, known). No unnamed residue: the coverage bar for
  default-app is met.

## Traverse attribution (orders the feed work)

| Operation | Calls | Manager reads | DAG traversals |
| --- | ---: | ---: | ---: |
| `graph.query` (executor Worker refresh) | 731 | 26,341 | 1,951 |
| `session.watch.refresh` (per-session) | 66 | 6,200 | 7,629 |
| `session.watch.add` (registration, one-time) | 158 | 201 | 3,540 |

The executor-driven `graph.query` path dominates call count and manager
reads — hard confirmation of the feed decomposition's two-source claim
and of F2's priority ahead of F5. Feed wave counters for the run:
79 waves, 66 sessions touched, 66 graphs refreshed, 13 upserts pushed.

## Reading

F2 (executor point reads) attacks the largest measured source first and
needs no protocol change; F5's per-session retirement then closes the
remainder against the W2.9 parity gate. Lunch-poll coverage stays gated
on C2 (session-context rows), unchanged.
