# Runbook: "pattern X is slow"

A symptom-driven flow for diagnosing pattern performance. It uses only
existing seams: the `RuntimeTelemetry` marker bus and its consumers (the shell
debugger, the OTel bridge in `packages/runner/src/telemetry-otel-bridge.ts`),
the scheduler's pull diagnostics, the memory server's spans and slow-query
ring, and `cf inspect`. Everything here works offline (JSON-only tier); an
OTLP backend adds retention and cross-run trending but is never required for
a diagnosis.

## Mental model

- **One bus.** Every `Runtime` has a `RuntimeTelemetry` EventTarget. The
  debugger UI and the OTel bridge are parallel consumers of the same marker
  stream — whatever you see in one is derivable from the other.
- **Correlation is by attributes, not trace-following.** Browser→server HTTP,
  the memory WebSocket, and runner→LLM calls all break W3C trace context, so
  every process's traces are disjoint. Join on identifiers instead:
  `space.did`, `user.did`, `commit.seq` (on `memory.transact` spans ↔
  `cf inspect commits/history/diff`), `actionId` (spans/metrics ↔ scheduler
  diagnostics), and the `x-cf-llm-trace-id` response header for LLM calls.
- **Pull diagnostics are the deep end.** `getActionStats`, `getSettleStats`,
  `getActionRunTrace`, `getTriggerTrace`, `runDiagnosis`, `getGraphSnapshot`
  are ring buffers on the Scheduler, mirrored over runtime-client IPC and
  exposed in the browser as `commonfabric.rt.*`
  (see `docs/development/debugging/console-commands.md`).

## Step 1 — Reproduce with the right harness

| Question | Harness | Telemetry |
|---|---|---|
| Scaling/contention ("slow with N users / M options") | `deno run -A packages/patterns/tools/lunch-poll-diagnose.ts --options=10 --users=5 --rounds=3` (or `--cases=1x2,3x5,10x5`, `--quick`) | JSON output alone is a complete artifact. To also export spans: `OTEL_DENO=true OTEL_SERVICE_NAME=perf-<pattern>-<harness>-<yyyymmdd> OTEL_EXPORTER_OTLP_ENDPOINT=<collector> deno run --unstable-otel -A …` — the harness has no OTel init of its own, so export rides **Deno's native OTel** (`OTEL_ENABLED` does nothing here) |
| Cross-runtime regression | `packages/patterns/lunch-poll/multi-user.test.tsx` | same `OTEL_DENO`/`--unstable-otel` mechanism |
| Real-browser latency | `packages/patterns/integration/lunch-poll-vote.test.ts` (two browsers) | server: `OTEL_ENABLED=true` (toolshed inits its own SDK — a *different* mechanism from the headless rows); browser: `localStorage["telemetryEnabled"]="true"` per profile, then reload |
| Manual multi-user poke | N browser profiles | same localStorage flag; drive headlessly with `agent-browser eval` |

Headless-run caveats (verified 2026-07-09): exports carry `memory.*` spans
only — `ct.*` metrics and scheduler spans need the OTel bridge, which
currently attaches only in the browser shell and bg-piece workers, so
scheduler numbers come from the harness JSON / pull diagnostics. The
`space.did` span attribute is an opaque DID and the harness JSON does not
record it — find your run's spaces by grouping the run's `memory.transact`
spans by `space.did`, scoped to your `OTEL_SERVICE_NAME`.

The single `telemetryEnabled` localStorage flag gates the debugger, marker
forwarding over IPC, preflight markers, **and** browser OTel export (via the
toolshed same-origin relay `/api/telemetry/v1/traces`) — one switch.

**Traps that masquerade as regressions:**

- Cold start has a known ~3.3s floor (~0.8s TS compile + ~2.5s serialized
  server round-trips) — see `two-browsers-cold-start.md`. Measure warm.
- Server store growth inflates timings — wipe the store before measuring.
- A persistent local dev stack may hold the default ports — use a non-default
  `--port-offset`.
- `cf piece set`/`call` do not recompute — run `cf piece step` before reading
  computed values.

Always use a distinctive `perf-*` `OTEL_SERVICE_NAME` per run — the service
name is what makes a run findable in the backend (space DIDs are opaque).

## Step 2 — Compute four numbers

They route the whole investigation:

- **W** — wall clock of the slow phase (harness JSON phase duration,
  StepTimer, or the user's report).
- **A** — Σ action durations (diagnose JSON action-run traces `durationMs`,
  or `commonfabric.rt.getActionStats(...)` / settle-stats).
- **T** — `memory.transact` p95 and conflict share (`ct.conflict` attr on
  spans; diagnose churn counters `commit-conflict`, `commit-preempted`, …).
- **F** — `memory.fanout` average duration grouped by `subscriber.count`.

## Step 3 — Decision tree

1. **W large, little server activity in the window** → client side. Check
   cold start first, then render: `commonfabric.vdom.stats()`,
   `getTimingStatsBreakdown()`. → **CLIENT/COLD-START**
2. **Settle time ≫ A** → scheduler churn, not slow actions. Run
   `commonfabric.rt.detectNonIdempotent()` / `runDiagnosis(5000)` for
   non-idempotent actions and causal cycles; `getTriggerTrace` explains who
   re-woke whom. → **SCHEDULER-CHURN / NON-SETTLING**
3. **A dominated by one actionId** → hot action. If graph node/edge counts
   from `getGraphSnapshot` also grow with data volume → **GRAPH-GROWTH**;
   otherwise → **HOT-ACTION**
4. **T conflict share high** (>10% under modest load is suspect; ~28% was
   measured at 5-way concurrency) → **WRITE-CONTENTION**
5. **F superlinear in subscriber count** (measured curve: ~4ms at 2
   subscribers → ~57ms at 10) → **FANOUT-AMPLIFICATION**. If
   `memory.subscriber.sync` spans show a high `ct.touched=false` share →
   **WASTED-WAKEUPS**
6. **`memory.commit.persist` dominates its parent transact**, or the memory
   slow-query ring (>100ms ops, exposed on the server `/health` route) has
   entries → **PERSIST/QUERY-COST**
7. **Outbound LLM/client spans dominate** → **UPSTREAM-LLM**; pivot via the
   `x-cf-llm-trace-id` response header.

## Step 4 — Correlate across tools

- Slow or conflicted `memory.transact` → take its `commit.seq` + `space.did`
  → `cf inspect history/diff/value-at` shows *what* was written and by whom;
  `cf inspect hot`/`conflicts` show contention shape (healthy store = zero
  stale-reads). This join applies to **toolshed-backed** sessions (local dev
  stack, or staging via `--remote`) — the diagnose harness's
  `StandaloneMemoryServer` store is non-persistent, so for harness runs the
  "what was written" half comes from the harness JSON's action-run traces
  instead.
- Scheduler anomaly in exported metrics → the same session's pull
  diagnostics carry the detail (same markers, second consumer).
- Stored vs rendered mismatch → `cf inspect overlay` (ground truth) vs
  `commonfabric.readCell` (client view).

## Step 5 — Name the bottleneck class

Every investigation ends by naming one primary class; each maps to a fix
direction with prior art:

| Class | Signature | Fix direction / prior art |
|---|---|---|
| WRITE-CONTENTION | high conflict share, commit retries, churn counters | keyed mergeable writes (`docs/development/keyed-collection-writes.md`), row-local writes (#4346), `CF_CONFLICT_ADMISSION` |
| GRAPH-GROWTH | graph size scales with data volume | keyed collections (#4141: 254s→105s on 10×5 add-options) |
| HOT-ACTION | one actionId dominates A | localize/memoize/index the derive |
| FANOUT-AMPLIFICATION | fanout duration ∝ subscribers | fanout batching / audience work |
| WASTED-WAKEUPS | high `ct.touched=false` share | subscription granularity |
| SCHEDULER-CHURN | settle ≫ A, busy_ratio > 0.3, cycles | fix non-idempotent handlers (auto-debounce kicks in at avg >50ms) |
| PERSIST/QUERY-COST | commit.persist dominates, slow-query hits | store hygiene, SQLite-side work |
| CLIENT/COLD-START | W ≫ server activity | known 3.3s decomposition; measure warm |
| UPSTREAM-LLM | outbound client spans dominate | LLM-side; `x-cf-llm-trace-id` pivot |

## Known limits (don't chase these)

- No single end-to-end trace exists per user action; attribute joins are the
  model, not a workaround.
- Render-side cost has no OTel signal — browser console tools only.
- Scheduler-side OTel signals (`scheduler.preflight` spans, `ct.*` metrics)
  only flow where the bridge is attached *and* telemetry is enabled; the
  pull diagnostics work regardless.

Common Tools operators: backend-specific material (query endpoints, auth,
dashboards, retention) lives in the private infra repository's observability
runbook.
