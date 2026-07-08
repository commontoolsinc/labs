# Browser Integration Test Diagnostics

The browser integration tests (`packages/patterns/integration/`) are
**self-diagnosing on failure**: a `Timed out filling cf input …` or
`waitForCondition` timeout prints a probe that names the stuck layer. Read that
output before adding any instrumentation of your own.

What the failure probe contains, and where each piece lives:

- **Fill phase ledger** (`__cfFillDiag`, in
  [`cfc-browser-helpers.ts`](../../../packages/patterns/integration/cfc-browser-helpers.ts))
  — per-selector progress through the fill (found → visible → filled →
  committed), naming the exact await that hung.
- **Host/bound-cell state** (`readCfInputProbe`, same file) — whether the
  `cf-input` host has a bound cell and a pending commit, alongside DOM
  value/visibility/disabled.
- **Main-thread pending IPC** (`RuntimeClient.getPendingRequests()`,
  [`runtime-client.ts`](../../../packages/runtime-client/runtime-client.ts))
  — the runtime-client requests still awaiting a worker response; works even
  while the worker is wedged.
- **Worker request ledger** (`runtime-worker.ipc` counts, wired through
  [`connection.ts`](../../../packages/runtime-client/client/connection.ts))
  — received/responded counts per request type. Because `postMessage` is
  FIFO, one failed run triangulates *never sent* vs *delivery starved* vs
  *response lost*.
- **Console tail + load summary** (`collectBrowserLoadSummary`) — bounded
  in-page console output, completed-IPC timing table, worker
  scheduler/runner/storage timings, and churn/conflict counters. Printed as
  post-test output on failures and by tests that opt in.

Local full-stack repro for CI-only integration failures (see
[LOCAL_DEV_SERVERS](../LOCAL_DEV_SERVERS.md) for the dev-server details):
run toolshed on an offset port, `SHELL_PORT=… TOOLSHED_PORT=… deno task
dev-local` in `packages/shell`, then point the test at both with
`API_URL=… FRONTEND_URL=… deno test -A integration/<file>`. Without
`FRONTEND_URL` the shell is missing and every tree fails identically at
`goto` — a misleading non-repro.

## When the probe is not enough

The probe names the stuck layer; these siblings go deeper:

- [Debugging Settle Waves](settle-wave-investigation.md) — scripted trace
  capture for the default-app integration flow (`CF_CAPTURE_TRIGGER_TRACE=1`),
  Chrome performance traces, and the `commonfabric.rt` console workflow for
  inspecting the browser worker live (baselines, settle stats, trigger /
  action-run / write traces).
- [Console Commands](console-commands.md) — reading logger counts, timing
  baselines, and worker IPC from the page console.
