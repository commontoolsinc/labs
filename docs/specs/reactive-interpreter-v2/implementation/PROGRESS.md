# Reactive Interpreter v2 — Progress

One row per work order; log entries newest-last. Every landed row carries
measured numbers (OFF vs ON, same commit) once W3 exists.

## Status

| WO | Status | Measured outcome |
| --- | --- | --- |
| W0 — plan + decisions | 🟡 in progress | — |
| W1 — IR v2 core | ⬜ | — |
| W2 — builder-born ROG | ⬜ | — |
| W3 — flag-on dispatch + measurement harness | ⬜ | — |
| W4 — collections Option A | ⬜ | — |
| W5 — transformer native ops | ⬜ | — |
| W6 — function lowering | ⬜ | — |
| W7 — suites + chat sim + measurements (continuous) | ⬜ | — |

Legend: ⬜ not started · 🟡 in progress · ✅ done · ⛔ blocked.

## Baselines to beat (v1-measured, from #4298)

- Legacy law: docs ≈ 5 + 3N, nodes ≈ 8 + 4N per collection pattern.
- v1 flag-on results (the bar): interpretable-op engagement 88.4%
  (integration corpus), nodes −26→−33%, docs −34%, rendered lists −60%
  docs / −40% nodes per element, lunch-poll wall −7–14%.
- v1 pathologies (must NOT reproduce): cfc-group-chat multi-user flag-on
  ~226× timeout; F4 I/O-coalesce conflict ratchet.

## Log

- (2026-07-02) Campaign start. Branch = main(0cf48b278) + v2 spec
  (7c47ece87). Baseline root `deno task test` kicked off; builder recon in
  flight; W0 docs this entry.
