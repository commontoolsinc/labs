# Server-Primary Execution Rollout

Server-primary execution is implemented through the trusted-client authority
split and is on by default. It moves claimed derived writes and supported
fetch/generate effects to one user-sponsored server Worker while clients keep
speculatively computing for UI latency. It does not yet reduce browser action
runs. There is one rollout switch: when it is off, clients remain primary and
no server-execution pool runs; when it is on, every compatible eligible piece
automatically participates. Client-compute suppression is a later optimization
within that final server-primary posture, not another authority mode.

## Prerequisites

- Deploy toolshed and shell/client builds from the same revision.
- Leave persistent scheduler state and server-primary execution at their
  current defaults, or explicitly set both true on the toolshed and clients.
- Restart/redeploy both sides so the memory handshake advertises
  `serverPrimaryExecutionV1`, claim routing, and builtin passivity together.
- Verify first with staging pieces whose active computations are same-space and
  space-scoped. Spaces owned by the legacy background service remain excluded.
- Deploy the memory host and legacy background service together. Exclusion
  acquire/renew responses carry the server clock used to derive a local
  monotonic deadline; an older host that omits it makes the background worker
  fail closed instead of risking overlap with the client-demand pool. A
  host-local handoff fences claims and broker egress immediately and withholds
  background readiness until the shared Worker has stopped and released its
  lease. A conflicting lease owned by another host is not shortened behind that
  holder's back; background remains blocked through its advertised expiry.
- The server rejects incompatible clients while the flag is on instead of
  silently mixing authority rules. There is no per-space opt-in document or
  execution-control CLI.

## Enable server-primary execution

Leave `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION` unset, or set it to `true`, in
both the toolshed and client build, then restart/redeploy both sides. Compatible
clients publish demand and the shared pool starts one Worker per active eligible
branch/space. The Worker discovers the graph and claims each servable action
automatically. Actions that are not yet servable remain client-primary; their
server discovery attempts may be reported as shadow or unserved diagnostics.

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
`serverExecutionPool` and `serverExecutionControl`. A null pool value means no
pool is available or started in that process (including when the runtime flag
is off); a null control value means its provider is not installed. Neither
means the counters are zero.

Keep space, branch, action, and DID values in structured logs/traces rather than
metric labels. The current bounded-cardinality sources are:

| Source | Signals |
| --- | --- |
| `/api/health/stats.serverExecutionPool` | active lanes/workers/demands and state counts; demand snapshots; completed server scheduler runs; shadow/authoritative server action transactions; server async requests; Worker start attempts/live/aborted/failed outcomes and stops; abrupt stops; lease losses/replacements; sponsor rotations; crashes; accepted-commit/index decisions; unrelated suppression; parked-wake attempts/starts; demand-empty hibernations |
| `/api/health/stats.serverExecutionControl` | claims issued/reissued/revoked; accepted action attempts and exact claimed-action conflicts; accepted-commit index lookups plus pre-dedup target-candidate, demanded-piece, and match counts; committed/no-op/failed/unserved settlements; lease-fence and action-firewall rejects |
| `/api/health/stats.timingStats["execution.pool"]` | aggregate Worker start plus live/aborted/failed start outcomes, demand update, parked wake, hibernate, and settle latency |
| `/api/health/stats.timingStats["execution.control"]` | `stale-reader-lookup`: synchronous host writer-index lookup during accepted-commit handling; `invalidation-settlement`: one host-local sample per published settlement, measured from the oldest exact durable source cause coalesced into that attempt |
| Memory host APIs | `listExecutionDemands`, `currentExecutionLease`, and `listExecutionClaims` for point-in-time lane authority |
| `execution.demand` logger | client active- and empty-demand publication-attempt round-trip time, including rejected responses and transport failures |
| `execution.executor` logger | `execution-server-shadow-action-run`, `execution-server-authoritative-action-run` |
| `storage.v2` logger | client-derived suppressed/upstream commits; overlay created/retained/dropped/divergence; `execution-overlay-held` timing |
| `runtime.execution` logger | client/server async builtin starts by role |
| Toolshed executor callbacks | claim candidates, unserved diagnostics, and writer discovery |

Under Deno native OTel (`OTEL_DENO=true|1` with `--unstable-otel`), every
executor Worker bridges its isolated Runtime telemetry stream to that Worker's
OTel providers and enables scheduler preflight markers. `OTEL_ENABLED` alone
registers the toolshed SDK provider only in the main isolate and does not
activate executor-Worker telemetry. Worker spans carry
`ct.runtime=server-executor`, `space.did`, and the sponsoring `user.did`;
metrics keep DIDs out and carry only the runtime plus configured service and
deployment environment. Bridge loading, attachment, and teardown fail open,
and the bridge is detached after the Worker Runtime stops.

Each normal replica commit transaction on the executor path has a distinct
`storage.push` span joined by space and local sequence. An action-firewall
rejection followed by a canonical unserved settlement therefore produces one
rejected push span and one separate settlement push span; do not merge them
when analyzing traces.

The browser rollout fixture additionally consumes a bounded, piece-scoped
routing snapshot from the runtime client. It rejects feed gaps, truncation,
multiple action records, pending overlays/settlements, claim-incarnation
mismatches, and any enabled phase whose exact action lacks a successful current-
incarnation settlement covering every claimed overlay route. Several rapid
source commits may correctly coalesce into one settlement at their latest
basis; the fixture therefore requires exact route/drop counts and between one
and N successful settlements for N events.

Performance comparisons use two fresh deployments, not authority changes
within one process: one with the flag explicitly false and one with it true.
The flag-off run must report no server pool and client derived transactions
sent upstream. The flag-on run must report authoritative server transactions,
claims, successful settlements, and corresponding client suppression for the
exact action under test. Shadow transactions alone do not prove that the
server-primary scenario was measured. If test flags enable parallel files,
use an isolated Toolshed and run the fixture alone:

The ordinary parking, default-app, and lunch-poll browser scenarios expose the
same guard through `CF_VERIFY_SERVER_EXECUTION_PLACEMENT=1`. The guard samples
health counters outside the timed interaction, logs their delta, and rejects a
flag-on sample unless that workload produced authoritative server
transactions, accepted claimed attempts, and successful settlements. It also
rejects a flag-off sample if a server pool exists or execution-control counters
move. Start a fresh toolshed and shell for each command; for example:

For default-app, the guard also waits until the measured browser has consumed a
claim and every boot-era overlay/settlement has drained before it resets the
bounded space/branch routing counters. After the interaction it waits for all
measured routes to reach a terminal outcome and requires both claimed overlays
and successful basis-covered settlements. Its output reports upstream versus
claimed-overlay routes. Branch-wide counters remain exact when the bounded
per-action history evicts old records; a diagnostic histogram and bounded
`problemActions` sample retain fallback reasons and action/piece ids. Canonical
`unserved` fallback is reported rather than treated as a stuck measurement;
failed settlements,
fence/firewall rejects, worker failures, pending routes, or a workload with no
authoritative success still reject the sample. The dedicated exact-routing
fixture below remains the stricter proof that one selected action was served
entirely by the server.

```sh
CF_VERIFY_SERVER_EXECUTION_PLACEMENT=1 \
EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=false \
EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true \
HEADLESS=1 \
deno task integration patterns default-app

CF_VERIFY_SERVER_EXECUTION_PLACEMENT=1 \
CF_NOTE_CREATE_TIMING_SERIES=5 \
EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=true \
EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true \
HEADLESS=1 \
deno task integration patterns default-app
```

Repeat the fresh-process pair with
`parking-coordinator-admin-view` and `lunch-poll-vote`. Parking and lunch create
and retain a controller-side piece before browser timing, so their reported
browser interaction is a warm-demand measurement. Default-app navigation is
the closest existing cold browser-open path. Do not label parking or lunch as
cold-start data without first seeding the piece without live controller demand.

The dedicated exact-routing fixture remains the strongest authority proof:

```sh
EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true \
EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=true \
deno task integration patterns server-primary-rollout-profile
```

Treat the units independently:

- a client scheduler run is one exact piece/action run in that browser;
- a client derived transaction is either suppressed or sent upstream;
- a server scheduler run is one completed Worker action run;
- a counted server action transaction is a servable transaction classified as
  either shadow or authoritative; unserved/unclassified attempts are omitted;
- a server async request is one supported builtin broker invocation; and
- a settlement is one coalescible claimed attempt outcome.

Do not manufacture a single "percent of execution moved" by dividing unlike
units. Multiple clients may speculatively run the same action, unservable
attempts do not enter the classified route counters, and one settlement may
cover multiple source invalidations. Compare paired fresh-deployment
flag-off/flag-on deltas within a unit. The useful placement ratios are client
suppression among client derived transactions and server authoritative routing
among classified
servable server action transactions. The latter deliberately excludes unserved
attempts, whose outcomes remain in `serverExecutionControl`. Phase 2 moves
authoritative writes and effects; it deliberately leaves speculative browser
computation in place until the Phase 3 optimization is folded into the same
server-primary posture.

The `execution.demand` active sample measures only the client's attempted
control-plane publication round trip; it records successful, rejected, and
failed attempts. If the memory host accepts the snapshot, it reconciles demand
asynchronously and may start or update a Worker, so Worker startup is not
hidden inside that client wait. Use the `execution.pool` start outcome samples
and counters to distinguish live startup from cancellation or failure. The
empty-demand sample is the corresponding publication attempt when the last
root stops or the runtime is disposed. If accepted, Worker drain, settle, and
hibernation continue asynchronously and have their own pool timings.

Feed latency has no server timestamp in v1. The host's
`execution.control/invalidation-settlement` sample joins process-local start
times to durable `causedBy` sequences; a restart or bounded timing-state eviction
therefore omits the sample instead of fabricating one. Measure settlement-held
duration/retention on the client separately, and do not call either signal wire
latency without a shared trace or timestamp.

## Deployment rollback

1. Set `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=false` on the server and restart
   it.
2. Rebuild/restart clients with the same explicit-false override.

Do not disable only the clients. A server-primary host rejects an incompatible
client because falling back silently would let stale clients duplicate claimed
writes or effects. No data migration or overlay cleanup command is required.

## Validation and rollout limits

Run the repository gates in both supported postures: the explicit-false
rollback and the default-on server-primary mode. Persistent scheduler state is
on in both:

```sh
EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=false \
EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true deno task test

EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=false \
EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true deno task integration

deno task test

deno task integration
```

The focused flag tests also pin the explicit-false rollback:

```sh
deno test -A packages/memory/test/v2-server-primary-execution-flags-test.ts \
  packages/runner/test/experimental-options.test.ts
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
but it is superseded as CPU acceptance evidence. The parked-worker claim-
readiness failure it exposed is fixed and covered by exact cold-wake,
sponsor-preference, settle-watermark, and replacement tests. The previous
counterbalanced eight-phase renderer-process gate passed with exact per-action
routing and settlement diagnostics; see the
[accepted Phase 2 rollout report](../history/development/performance/server-primary-rollout-2026-07-13.md).
It remains historical evidence; the final comparison is the two fresh
flag-off/flag-on deployments described above.
Phase 2 removes duplicate wire writes and external effects while deliberately
leaving speculative browser compute in place. Complete-closure client-compute
suppression remains the Phase 3 optimization within the same server-primary
posture.
