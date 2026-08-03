---
status: historical
created: 2026-07-12
archived: 2026-07-12
reason: "Local browser CPU and authority-rollout measurement snapshot for Phase 2 server-primary execution."
---

# Server-primary execution: browser rollout measurement

This is the Phase 2 local integration measurement for server-primary
execution. It compares one actor browser and one lazy observer browser while a
third client keeps the same piece result live. The workload is a transformed
`Writable<number>` pattern with one derived `computed()` output. Each phase
performs 20 sequential invalidations after an excluded authority warm-up.

This is local staging-equivalent evidence, not a deployed staging-space
mutation. The separate executor fixtures cover product-shaped lunch-poll and
group-chat transactions, enable/disable convergence, and failure drills.

## Reproduction

Measured at commit `9f04bb59e` on macOS 26.4.1 (Apple Silicon), Deno 2.8.1,
V8 14.9.207.2, and the Astral-provided HeadlessChrome 125 runtime:

```sh
EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=true \
EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true \
CF_SERVER_EXECUTION_CPU_BENCH=1 \
CF_SERVER_EXECUTION_CPU_EVENTS=20 \
CF_CPUPROFILE_DIR=/tmp/server-exec-profile-4692 \
HEADLESS=1 \
deno task integration patterns server-primary-rollout-profile
```

The test runs an A/B/B/A sequence to reduce order bias: policy disabled,
enabled, enabled again, then disabled again. It writes a raw `.cpuprofile` for
each phase and `server-primary-rollout-summary.json` to the requested profile
directory.

## Results

| Phase | Lazy-worker sampled busy time/event | Actor action-run p95 | Client derived writes suppressed | Client derived writes sent | Server accepted attempts observed after the phase |
| --- | ---: | ---: | ---: | ---: | ---: |
| Disabled A | 45,654 us | 1 | 0 | 20 | 0 |
| Enabled A | 41,408 us | 1 | 20 | 0 | 1 |
| Enabled B | 39,325 us | 1 | 20 | 0 | 3 |
| Disabled B | 41,560 us | 1 | 0 | 20 | 0 |

Across both repetitions, disabled sampled busy time was 43,607 us/event and
enabled sampled busy time was 40,367 us/event, a 7.4% decrease. The Phase 2
gate permits at most a 10% regression, so this run passes the "no worse"
criterion. Phase 2 intentionally keeps client speculative action runs for UI
latency; reducing those runs is tracked for Phase 3.

The enabled phases retained all 40 actor-derived transactions as local
overlays and sent zero derived operations to the host. The disabled phases sent
all 40. Browser action-run p95 stayed exactly one in every phase.

At the final barrier the pool had one live lane, one Worker, and three demand
references. Host control totals recorded four accepted attempts and four
committed settlements, with zero failed/no-op/unserved settlements and zero
lease-fence or action-firewall rejections. The full run also recorded one lease
replacement and one abrupt stop, but no Worker crash; the final lane was live.

## Interpretation limits

Chrome emitted no explicit `(idle)` samples for this dedicated worker, so the
profiler's conservative `busyUs` includes `(program)` samples and closely
tracks the bracketed sampling interval. It is therefore a matched worker
occupancy proxy, not calibrated host CPU utilization. Server-acceptance polling
is deliberately outside the profile bracket so only the same browser
click/render/settle workload is compared. Exact server action attempts per
invalidation are asserted by the deterministic executor product fixtures rather
than inferred from these aggregate health counters.
