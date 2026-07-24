---
status: historical
created: 2026-07-13
archived: 2026-07-13
reason: "Accepted 500-event local browser CPU and authority-rollout measurement for Phase 2 server-primary execution."
---

# Server-primary execution: accepted 500-event rollout measurement

This is the accepted Phase 2 local integration measurement for
server-primary execution. It compares policy-disabled and policy-enabled runs
in one actor browser and one lazy observer browser while a third client keeps
the transformed `Writable<number>` pattern's result live. Each measured phase
drives 500 source invalidations after an excluded 25-event warmup per block
(50 warmup events per policy).

This is local staging-equivalent evidence, not a deployed staging-space
mutation. The separate executor fixtures cover product-shaped multi-client
authority, fencing, sponsor loss, crash recovery, and builtin brokering. A
deployed enable/disable drill remains a separate operator action.

## Command and environment

Measured at commit `7952595c3` on macOS 26.4.1 (Apple Silicon), Deno 2.8.1,
and V8 14.9.207.2:

```sh
EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=true \
EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true \
CF_SERVER_EXECUTION_CPU_BENCH=1 \
CF_SERVER_EXECUTION_CPU_EVENTS=500 \
CF_CPUPROFILE_DIR=/tmp/server-exec-profile-4692-final \
HEADLESS=1 \
deno task integration patterns server-primary-rollout-profile
```

The authoritative signal is the cumulative renderer-process CPU delta from
Chrome's `SystemInfo.getProcessInfo`, divided by source events. The test runs
an ABBA block followed by a BAAB block. Each block must independently keep the
enabled/disabled ratio at or below 1.10 and each same-policy pair's spread at
or below 0.15. This is a conservative worst-block cold/warm safety contract;
the combined ratio is reported as a summary, not used to hide a failing block.

## Results

| Phase | Policy | Renderer CPU/event | Lazy action runs | Derived writes suppressed | Derived writes sent |
| --- | --- | ---: | ---: | ---: | ---: |
| ABBA 1 | disabled | 4,186.532 us | 14 | 0 | 500 |
| ABBA 2 | enabled | 4,394.174 us | 243 | 500 | 0 |
| ABBA 3 | enabled | 4,150.930 us | 243 | 500 | 0 |
| ABBA 4 | disabled | 4,072.182 us | 38 | 0 | 500 |
| BAAB 1 | enabled | 3,949.682 us | 252 | 500 | 0 |
| BAAB 2 | disabled | 3,886.274 us | 119 | 0 | 500 |
| BAAB 3 | disabled | 3,848.938 us | 152 | 0 | 500 |
| BAAB 4 | enabled | 4,084.954 us | 372 | 500 | 0 |

| Analysis | Disabled mean | Enabled mean | Enabled/disabled | Disabled spread | Enabled spread |
| --- | ---: | ---: | ---: | ---: | ---: |
| ABBA | 4,129.357 us/event | 4,272.552 us/event | 1.0347 | 0.0281 | 0.0586 |
| BAAB | 3,867.606 us/event | 4,017.318 us/event | 1.0387 | 0.0097 | 0.0342 |
| Combined | 3,998.482 us/event | 4,144.935 us/event | 1.0366 | — | — |

Both blocks pass the 1.10 CPU ceiling and 0.15 spread ceiling. Across all
enabled phases, 2,000 claimed client transactions stayed local and zero
derived operations reached the host. Across all disabled phases, all 2,000
derived transactions followed the ordinary upstream route. Every phase also
passed exact authority preflight, routing, settlement, final render, and
synced-idle convergence assertions.

`lazyActionRuns` is retained as a mechanism diagnostic, not a denominator. A
source-event workload must account for policy-induced work amplification
rather than normalizing it away. The enabled path still performs bounded
local speculation, as Phase 2 requires; Phase 3 remains responsible for
complete-closure suppression of N-client computation.

## Changes that closed the earlier gate

- Host accepted-commit refreshes are coalesced without dropping per-notice
  causal callbacks, removing the cumulative graph-refresh backlog that could
  leave a claimed phase with no server attempt or settlement.
- Claimed-overlay cleanup visits only touched documents and safely compacts
  dominated physical replace patches while preserving logical generations and
  settlement accounting.
- A remote invalidation of an exactly claimed computation gets one non-sliding
  50 ms adoption grace. Local source/UI commits stay immediate, and an
  authority stall always falls open to the existing local speculative run.
- `idle()` waits for that bounded fallback, and a successful server settlement
  that arrives before a speculative overlay is retained and reconciled through
  the same input-basis and accepted-data barriers.

## Remaining rollout boundary

The measurement completes the local Phase 2 CPU acceptance gate. It does not
authorize or record a mutation of a deployed staging space. An operator must
still choose an authorized target, enable then disable its execution policy,
and capture the no-migration convergence evidence described in the runbook.
