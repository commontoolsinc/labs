# Server-Primary Execution Rollout

Server-primary execution is implemented through the trusted-client authority
split and remains off by default. It moves claimed derived writes and supported
fetch/generate effects to one user-sponsored server Worker while clients keep
speculatively computing for UI latency. It does not yet reduce browser action
runs; client-compute suppression is a later, separately gated phase.

## Prerequisites

- Deploy toolshed and shell/client builds from the same revision.
- Enable persistent scheduler state (the current default) and
  `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=true` on the toolshed and clients.
- Restart/redeploy both sides so the memory handshake advertises
  `serverPrimaryExecutionV1`, claim routing, and builtin passivity together.
- Start with one staging space whose active computations are same-space and
  space-scoped. Spaces owned by the legacy background service remain excluded.
- Deploy the memory host and legacy background service together. Exclusion
  acquire/renew responses carry the server clock used to derive a local
  monotonic deadline; an older host that omits it makes the background worker
  fail closed instead of risking overlap with the client-demand pool. A
  host-local handoff fences claims and broker egress immediately and withholds
  background readiness until the shared Worker has stopped and released its
  lease. A conflicting lease owned by another host is not shortened behind that
  holder's back; background remains blocked through its advertised expiry.
- For a named space, `cf execution enable|disable` automatically uses the
  derived space identity that created it. For a raw DID while ACL mode is
  `off` or `observe`, the supplied identity must be the space key or a
  configured service DID; an ACL-granted OWNER is sufficient in `enforce`
  mode. `status` only needs normal read access. Policy-enabled spaces reject
  stale clients instead of silently mixing authority rules.

## Shadow observation

Leave the space policy absent or disabled first. Compatible clients publish
demand, the shared pool runs one observe-only Worker per branch/space, and no
positive claim transfers authority. Inspect candidate and unserved diagnostics
before opting in.

```sh
EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=true \
  cf execution status --space <space> --identity <owner-key> --api-url <api-url>
```

Expected status is `absent` or `disabled`.

`cf execution status` reports only that policy value. Candidate-claim,
unserved, and writer-discovery diagnostics remain host-local structured
executor logs/callbacks; inspect those separately before opt-in.

## Enable one space

```sh
EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=true \
  cf execution enable --space <space> --identity <owner-key> --api-url <api-url>
```

The command writes the canonical owner-only, policy-only document
`of:${space}:execution-policy` with
`{version: 1, serverPrimaryExecution: true}`. No data migration is involved.

Verify:

- one live pool lane and Worker serves all client demand references;
- claims remain stable rather than repeatedly revoke/reclaim;
- claimed pure actions produce zero client derived wire operations;
- each claimed fetch/generate action whose causal origin matches the sponsor
  produces one server broker request and no client request; a mismatch produces
  zero broker requests and one exact unserved settlement/revoke;
- settlements clear or retain overlays at the documented basis/data barrier;
- divergence and fenced/abrupt lifecycle counters do not grow continuously.

## Operational signals

`GET /api/health/stats` exposes the bounded-cardinality host snapshots as
`serverExecutionPool` and `serverExecutionControl`. A null value means the
provider is not installed in that process, not that the counters are zero.

Keep space, branch, action, and DID values in structured logs/traces rather than
metric labels. The current bounded-cardinality sources are:

| Source | Signals |
| --- | --- |
| `/api/health/stats.serverExecutionPool` | active lanes/workers/demands and state counts; demand snapshots; Worker starts/stops; abrupt stops; lease losses/replacements; sponsor rotations; crashes; accepted-commit/index decisions; unrelated suppression; parked-wake attempts/starts; demand-empty hibernations |
| `/api/health/stats.serverExecutionControl` | inactive-policy attempts; claims issued/reissued/revoked; accepted action attempts and exact claimed-action conflicts; committed/no-op/failed/unserved settlements; lease-fence and action-firewall rejects |
| `/api/health/stats.timingStats["execution.pool"]` | Worker start, demand update, parked wake, hibernate, and settle latency |
| Memory host APIs | `listExecutionDemands`, `currentExecutionLease`, and `listExecutionClaims` for point-in-time lane authority |
| `execution.executor` logger | `execution-server-shadow-action-run`, `execution-server-authoritative-action-run` |
| `storage.v2` logger | client-derived suppressed/upstream commits; overlay created/retained/dropped/divergence; `execution-overlay-held` timing |
| `runtime.execution` logger | client/server async builtin starts by role |
| Toolshed executor callbacks | claim candidates, unserved diagnostics, and writer discovery |

The browser rollout fixture additionally consumes a bounded, piece-scoped
routing snapshot from the runtime client. It rejects feed gaps, truncation,
multiple action records, pending overlays/settlements, claim-incarnation
mismatches, and any enabled phase whose exact action lacks one settlement per
claimed overlay route. This is test diagnostics, not output from
`cf execution status`.

Feed latency has no server timestamp in v1. Measure invalidation-to-settlement
at the host and settlement-held duration/retention on the client; do not call it
wire latency without a shared trace or timestamp.

## Per-space rollback

```sh
EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=true \
  cf execution disable --space <space> --identity <owner-key> --api-url <api-url>
```

Disabling the policy revokes live claims, keeps shadow demand intact, and
returns subsequent derived work/effects to existing client behavior. Wait for
claims to drain and clients to converge; no data migration or overlay cleanup
command is required.

## Emergency deployment rollback

1. Disable `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION` on the server and restart it.
2. Rebuild/restart clients with the flag disabled.
3. Leave or disable each space policy as desired; the policy is inert while the
   deployment flag is off.

Do not disable only the clients while a space policy remains enabled. The
correct result is handshake rejection, because falling back silently would let
stale clients duplicate claimed writes/effects.

## Validation and rollout limits

Run the repository gates with both relevant flags:

```sh
EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=true \
EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true deno task test

EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=true \
EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true deno task integration
```

The three-client executor fixtures cover claimed pure actions and supported
builtins. The product, authority-transition, failure, and browser gates can be
run directly when diagnosing rollout behavior:

```sh
deno test -A packages/runner/test/server-execution-rollout-products.test.ts
deno test -A packages/runner/test/executor-claim-e2e.test.ts
deno test -A packages/runner/test/executor-drain-barrier.test.ts

EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=true \
EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true \
CF_SERVER_EXECUTION_CPU_BENCH=1 \
CF_SERVER_EXECUTION_CPU_EVENTS=500 \
CF_CPUPROFILE_DIR=/tmp/server-execution-profiles \
HEADLESS=1 \
deno task integration patterns server-primary-rollout-profile
```

The initial A/B/B/A sampling snapshot and its limitations are retained in the
[historical Phase 2 rollout report](../history/development/performance/server-primary-rollout-2026-07-12.md),
but it is not current CPU acceptance evidence. The parked-worker claim-
readiness failure it exposed is fixed and covered by exact cold-wake,
sponsor-preference, settle-watermark, and replacement tests. Fresh acceptance
still requires the counterbalanced eight-phase renderer-process gate above,
with exact per-action routing and settlement diagnostics; no newer historical
acceptance report is recorded yet. Phase 2 removes duplicate wire writes and
external effects while deliberately leaving speculative browser compute in
place. Complete-closure client-compute suppression remains the separately
gated Phase 3 optimization.
