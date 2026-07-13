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
- Use an OWNER identity for policy changes. Policy-enabled spaces reject stale
  clients instead of silently mixing authority rules.

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
- each claimed fetch/generate action produces one server broker request and no
  client request;
- settlements clear or retain overlays at the documented basis/data barrier;
- divergence and fenced/abrupt lifecycle counters do not grow continuously.

## Operational signals

Keep space, branch, action, and DID values in structured logs/traces rather than
metric labels. The current bounded-cardinality sources are:

| Source | Signals |
| --- | --- |
| `SharedExecutionPool.metrics()` | active lanes/workers/demands; demand snapshots; Worker starts/stops; abrupt stops; lease losses/replacements; sponsor rotations; crashes |
| Memory host APIs | `listExecutionDemands`, `currentExecutionLease`, and `listExecutionClaims` for point-in-time lane authority |
| `execution.executor` logger | `execution-server-shadow-action-run`, `execution-server-authoritative-action-run` |
| `storage.v2` logger | `execution-client-derived-suppressed`, overlay created/retained/dropped, and `execution-overlay-divergence` |
| `runtime.execution` logger | client/server async builtin starts by role |
| Toolshed executor callbacks | claim candidates, unserved diagnostics, and writer discovery |

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
builtins. Before broad rollout, still record the named lunch-poll/group-chat
measurements, browser/lazy-client CPU, a real staging enable/disable drill, and
an integrated kill/restart/sponsor-loss drill. Phase 2 is expected to remove
duplicate wire writes and external effects while leaving speculative browser
compute approximately unchanged.
