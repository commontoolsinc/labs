---
status: historical
created: 2026-07-15
archived: 2026-07-15
reason: "Interactive-latency investigation of Phase 2 server-primary execution; motivates the Phase 2.5 hardening work orders."
---

# Server-primary execution: interactive latency investigation

Measured at the head of the Phase 0–2 implementation branch (stacked PRs
#4692/#4713) on macOS (Apple Silicon), Deno 2.8.x, headless Chrome via
Astral, using fresh flag-off/flag-on deployments per the runbook. The prior
500-event counterbalanced CPU gate passed (enabled/disabled renderer CPU
ratio 1.0366 ≤ 1.10), but interactive latency had never been gated.

## Headline measurements

| Workload | Flag off | Flag on | Delta |
| --- | ---: | ---: | ---: |
| default-app note-create ×10, avg total (pair 1) | 524 ms | 664 ms | +27% |
| default-app note-create ×10, p95 (pair 1) | 695 ms | 1255 ms | +81% |
| default-app note-create ×10, avg (pair 2) | 487 ms | 822 ms | +69% |
| lunch-poll two-browser flow, total | 3878 ms | 7033 ms | +81% |
| lunch-poll "vote lands on both" step | 424 ms | 1714 ms | +304% |
| lunch-poll boot IPC `page:getAll` p50 | 1019 ms | 1454 ms | +43% |
| shell integration suite wall time | 27 s | 30 s | +11% |

Flag-on note-create latency grows with note count (~340 ms for notes 1–2 up
to 1255–1347 ms for notes 8–10) while flag-off stays flat. Per-note client
scheduler busy time (settle durations) is nearly identical in both modes —
the regression is waiting, not compute. Setting
`CLAIMED_REMOTE_SPECULATION_GRACE_MS` to 0 did not change the result
(797 ms vs 822 ms avg), ruling out the adoption grace as the driver.

## Server-side evidence (one flag-on default-app run)

- `execution.control/invalidation-settlement`: 3 samples, avg 20.5 s,
  max 27.6 s — settlements lag the interaction by tens of seconds.
- `claimedActionConflicts: 124` against `acceptedActionAttempts: 34` — the
  executor's claimed commits repeatedly lose optimistic-concurrency races
  against the client's streaming source commits.
- 111 "Server execution candidate unserved" callbacks:
  44 `untrusted-implementation`, 33 `dynamic-read-outside-static-surface`,
  14 `incomplete-static-surface`, 11 `claim-authority-lost`,
  9 `malformed-action-observation` — the same permanently unservable
  candidates re-attempted every wave.
- `claimsIssued: 14`, `claimsRevoked: 14` — no claim survived the run.
- One executor Worker crash at teardown: "executor claim release does not
  match a live claim" (`deno-space-executor.ts` `#handleClaimRelease`) when
  demand removal raced a queued release.
- lunch-poll flag-on: `claimsIssued: 0` in the measured window, one unserved
  attempt, zero successful settlements — the placement guard
  (`CF_VERIFY_SERVER_EXECUTION_PLACEMENT=1`) correctly fails the run.

## Mechanism

`DenoSpaceExecutor.setDemand` treated any demand shrink as a full authority
reset: revoke every claim, bump the demand generation, and have the Worker
stop every demanded root, clear all candidate/claim state, and rebuild. Every
navigation away from a piece (note → home) therefore tore down and rebuilt
the server's whole graph while the client kept committing. The rebuild
re-ran every action (shadow), re-emitted every unservable diagnostic,
re-claimed every eligible action, and raced the client's commits — losing
repeatedly (124 conflicts) — so settlements landed tens of seconds late.
Those late echo commits then re-dirtied claimed client actions wave after
wave, extending `idle()` (which the view-settled path waits on) further as
the graph grew.

## Outcome

Motivated the Phase 2.5 work orders in the implementation plan: tolerant
claim release, demand-shrink scoping, unservable-diagnostic dedup,
accepted-commit wake coalescing, and interactive-latency gates.
