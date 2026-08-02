# Experimental Flags Registry

This is the single central registry of experimental flags in the repository. An
experimental flag is a toggle that gates the incremental rollout of an
in-progress feature: it lets the new behavior ship in a dormant state, be
enabled deliberately for testing or dogfooding, and be graduated to always-on
(or removed) once the feature is finished.

There is no single place in the code that enumerates every flag, because flags
live in different layers (the runner, the memory protocol, the storage layer,
and the shell). This document is the human-maintained index that ties them
together. If you add, change, graduate, or remove a flag, update this document
in the same change.

> **Maintaining this document.** Each section records who added the flag, what
> it gates, its current default, its intended end state, and the concrete path
> to removing it. When you touch a flag, update its section and the summary
> table, and move the date and status line forward. When you delete a flag,
> move its section to [Appendix A: Removed and never-shipped
> flags](#appendix-a-removed-and-never-shipped-flags) rather than deleting the
> record, so the history stays discoverable.

**Last reviewed:** 2026-08-01. Each flag's section carries the date its status
was last checked against the code.

> ## The server-primary dial SET moves as one — owner ruling, 2026-08-01
>
> Eight flags in this registry, spread across Category 1 and Category 3, are
> not eight independent rollouts. They are one configuration:
>
> | dial | side | default |
> | --- | --- | --- |
> | [`serverPrimaryExecution`](#serverprimaryexecution) | both | **on** |
> | [`persistentSchedulerState`](#persistentschedulerstate) | both | **on** (already) |
> | [`serverPrimaryExecutionUserRankCandidates`](#serverprimaryexecutionuserrankcandidates) | runner | **on** |
> | [`serverPrimaryExecutionSessionRankCandidates`](#serverprimaryexecutionsessionrankcandidates) | runner | **on** |
> | [`serverPrimaryExecutionCrossSpaceReadCandidates`](#serverprimaryexecutioncrossspacereadcandidates) | runner | **on** |
> | [`serverPrimaryExecutionClaimRank`](#serverprimaryexecutionclaimrank) | memory | **`cross-space-read`** (top of the ladder) |
> | [`serverPrimaryExecutionContextLatticeClaimsV1`](#serverprimaryexecutioncontextlatticeclaimsv1) | memory | **on** |
> | [`serverPrimaryExecutionCrossSpaceClaimsV1`](#serverprimaryexecutioncrossspaceclaimsv1) | memory | **on** |
>
> The runner dials decide what a client PROPOSES; the memory dials decide what
> a host ISSUES. A set where only one side moved is a client proposing ranks
> the host refuses, which is why they default on together rather than
> separately.
>
> **THE INTERMEDIATE STATES ARE A TESTING-ONLY AFFORDANCE, AND NOTHING SHIPS
> IN ONE.** Every partial combination is still reachable programmatically, and
> the C1/C2/C3 gate fixtures use them to measure one rank's contribution at a
> time — that is what they are for. They are not rollout stages any more, they
> have no deployment lever (only `serverPrimaryExecution` is env-reachable, on
> purpose), and no measurement outside a fixture should be taken in one.
>
> **The rollback is the master dial, whole.** `serverPrimaryExecution` gates
> claim issuance at every rank (`#assertExecutionClaimCapabilityEnabled`),
> demand publication (`runner.ts`'s `addExecutionDemand`), and the
> client-passivity half (the `externalSinkDisposition` default). So
> `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=false` returns a deployment to the
> pre-arc configuration entire, and no dial beneath it needs a lever of its
> own. There are exactly two configurations and no hybrid.
>
> **Three related dials are deliberately NOT in the set**, each assessed
> 2026-08-01: [`serverPrimaryExecutionDocSetWatch`](#serverprimaryexecutiondocsetwatch)
> and [`serverPrimaryExecutionGraphRetirement`](#serverprimaryexecutiongraphretirement)
> are a WATCH-SURFACE rollout gated on the separate W2.9 wall-time
> measurement, not an execution-authority one; and
> [`serverPrimaryExecutionDemandGrace`](#serverprimaryexecutiondemandgrace) is
> a duration whose only production construction site (toolshed) already sets
> it. See each section for the reasoning.

## Summary table

| Flag | Toggle via | Default today | Originally added by | Planned end state | Status |
|------|-----------|---------------|---------------------|-------------------|---------------------|
| [`modernCellRep`](#moderncellrep) | `EXPERIMENTAL_MODERN_CELL_REP` env, or `RuntimeOptions.experimental` | off | Dan Bornstein (#3818) | graduate to always-on, then delete flag | implemented, off by default |
| [`persistentSchedulerState`](#persistentschedulerstate) | `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` env, or `RuntimeOptions.experimental` | on | Bernhard Seefeld (#3646) | graduate to always-on | implemented, on by default, rollback override retained |
| [`serverPrimaryExecution`](#serverprimaryexecution) | `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION` env (applied at memory-server construction AND bridged from `RuntimeOptions.experimental`) | **on** | Bernhard Seefeld (server-primary execution W0.6) | graduate after the phased authority rollout, then delete flag | implemented, on by default (2026-08-01), and the one rollback lever for the whole dial set |
| [`serverPrimaryExecutionUserRankCandidates`](#serverprimaryexecutionuserrankcandidates) | `RuntimeOptions.experimental` only (mapped `null` in the canonical env registry) | **on** | Bernhard Seefeld (server-side execution C1.5a) | fold into `serverPrimaryExecution` once user lanes graduate | implemented, on by default (2026-08-01) with the rest of the dial set |
| [`serverPrimaryExecutionSessionRankCandidates`](#serverprimaryexecutionsessionrankcandidates) | `RuntimeOptions.experimental` only (mapped `null` in the canonical env registry) | **on** | Bernhard Seefeld (server-side execution C2.5) | fold into `serverPrimaryExecution` once session lanes graduate | implemented and gate-bound (C2 complete 2026-07-18), on by default (2026-08-01) |
| [`serverPrimaryExecutionCrossSpaceReadCandidates`](#serverprimaryexecutioncrossspacereadcandidates) | `RuntimeOptions.experimental` only (mapped `null` in the canonical env registry) | **on** | Bernhard Seefeld (server-side execution C3.6) | fold into `serverPrimaryExecution` once cross-space reads graduate | implemented, on by default (2026-08-01); the CA4/C3A17 ordering invariant now holds by construction — the `cross-space-read` claim-rank stage and the `cross-space-claims-v1` cohort gate default on beside it |
| [`serverPrimaryExecutionDocSetWatch`](#serverprimaryexecutiondocsetwatch) | `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH` env (applied at memory-server construction, bridged from `RuntimeOptions.experimental`, and exposed to browser builds via the shell define) — the memory-side ambient is `setServerPrimaryExecutionDocSetWatchConfig()` (negotiated per connection, absent-false) | off | Bernhard Seefeld (server-side execution F3 server / F4 client) | fold into `serverPrimaryExecution` once the feed graduates, then retire the negotiation | implemented, off by default; deliberately NOT in the 2026-08-01 dial set (watch-surface rollout, gated on the W2.9 measurement) |
| [`serverPrimaryExecutionGraphRetirement`](#serverprimaryexecutiongraphretirement) | `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES` env (comma-separated space DIDs or `*`), applied at server construction; ambient `setServerPrimaryExecutionGraphRetirementConfig(spaces)` (host-internal, per-space, not negotiated) | empty set (absent-false: no space admitted to the doc-set surface) | Bernhard Seefeld (server-side execution F5; FW5 admission redesign) | fold into `serverPrimaryExecution` once the feed graduates | implemented, empty by default; deliberately NOT in the 2026-08-01 dial set (same rollout as the doc-set watch dial above) |
| [`serverPrimaryExecutionDemandGrace`](#serverprimaryexecutiondemandgrace) | `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DEMAND_GRACE_MS` env (non-negative integer ms), applied at pool construction in toolshed's storage route; a `SharedExecutionPool` option, host-internal, not negotiated | 10000 ms on toolshed (pool default is 0 = legacy immediate abort/drain) | Bernhard Seefeld (client-passivity P0, 2026-07-26) | fold into `serverPrimaryExecution` once P1 calibrates a fixed value | implemented; not in the 2026-08-01 dial set (a duration, already set at the only production construction site) |
| [`commitPreconditions`](#commitpreconditions) | `RuntimeOptions.experimental` only (mapped `null` — programmatic rollback override — in the canonical env registry) | on | Bernhard Seefeld (#4090) | fold into base scheduler semantics, then delete flag | implemented, on by default |
| [`plainResultReceipts`](#plainresultreceipts) | `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS` env, or `RuntimeOptions.experimental` | off | Mike Salisbury (verb contract WS-C) | flip default after the invocation-protocol integration proof, then fold into receipt semantics and delete flag | implemented, off by default |
| [`eagerSourceAnnotation`](#eagersourceannotation) | `EXPERIMENTAL_EAGER_SOURCE_ANNOTATION` env, or `RuntimeOptions.experimental` | off in production, on in shell dev builds | gideon (#4458) | permanent debug toggle, not slated for removal | implemented |
| [`systemPatternAutoUpdate`](#systempatternautoupdate) | `EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE` env / shell build define, or `RuntimeOptions.experimental` | on in the shell (same-toolshed system sources, including all roots); off server-side | Bernhard Seefeld (#4611; shell default-on #4619) | graduate to always-on, then delete flag | implemented, on in the shell |
| [`computedCellIds`](#computedcellids) | `EXPERIMENTAL_COMPUTED_CELL_IDS` env, or `RuntimeOptions.experimental` | on | Robin McCollum (#4659) | graduate to unconditional behavior, then delete flag | implemented, on by default |
| [`cfcEnforcementMode`](#cfcenforcementmode) | `RuntimeOptions.cfcEnforcementMode` (`CF_CFC_MODE` in the cf-harness / fuse) | `enforce-explicit` | Bernhard Seefeld (#3263) | tighten default toward `enforce-strict` | active; ladder is permanent |
| [`cfcFlowLabels`](#cfcflowlabels) | `RuntimeOptions.cfcFlowLabels` | `off` | Bernhard Seefeld (#4011) | move toward `persist` | implemented, staged rollout |
| [`cfcWriteFloor`](#cfcwritefloor) | `RuntimeOptions.cfcWriteFloor` | `off` | Bernhard Seefeld (#4479) | move toward `enforce` | implemented, staged rollout |
| [`cfcTriggerReadGating`](#cfctriggerreadgating) | `RuntimeOptions.cfcTriggerReadGating` | `false` | Bernhard Seefeld (#4488) | move toward `true` | implemented, staged rollout |
| [`cfcPolicyEvaluation`](#cfcpolicyevaluation) | `RuntimeOptions.cfcPolicyEvaluation` | `off` | Bernhard Seefeld (#4566) | move toward `enforce` | implemented, staged rollout |
| [`cfcDeclaredMonotonicity`](#cfcdeclaredmonotonicity) | `RuntimeOptions.cfcDeclaredMonotonicity` | `off` | Bernhard Seefeld (#4647) | `observe` first, then `enforce` (must soak before the §8.12.7 route 2b event ships) | implemented, off by default |
| [`cfcPrefixProvenanceStats`](#cfcprefixprovenancestats) | `RuntimeOptions.cfcPrefixProvenanceStats` (per-deployment; not env-wired) | `false` | Bernhard Seefeld (#4623) | stays a measurement opt-in; fold in or remove after Stage 0 | implemented, off by default, measurement only |
| [`cfcLabelMetadataProtection`](#cfclabelmetadataprotection) | `RuntimeOptions.cfcLabelMetadataProtection` | `off` | Bernhard Seefeld (#4638) | `observe` (divergence counting) first, then `enforce` | implemented, staged rollout |
| [`conflictAdmissionMode`](#conflictadmissionmode) | `CF_CONFLICT_ADMISSION` env, or `setConflictAdmissionMode()` | `off` | William Kelly (#4237) | keep as a tuning dial or remove after re-measurement | implemented, off by default, measured net-negative or neutral |
| [`syncSchemaTableV2`](#syncschematablev2) | `setSyncSchemaTableConfig()` (negotiated per connection) | on | Ben Follington (#4292) | retire the negotiation once every peer speaks v2 | implemented, on by default |
| [`serverPrimaryExecutionClaimRank`](#serverprimaryexecutionclaimrank) | `setServerPrimaryExecutionClaimRankConfig()` (host-internal, not negotiated) | **`cross-space-read`** (top of the ladder: every context rank, foreign reads admitted) | Bernhard Seefeld (server-side execution C1.1b; `session` stage C2.1; `cross-space-read` stage C3.6) | fold into `serverPrimaryExecution` once every context rank graduates | implemented through the `cross-space-read` stage (C3.6), at that stage by default (2026-08-01) |
| [`serverPrimaryExecutionContextLatticeClaimsV1`](#serverprimaryexecutioncontextlatticeclaimsv1) | `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS` env (both peers), or `setServerPrimaryExecutionContextLatticeClaimsConfig()`; then negotiated per connection, absent-false | **on** | Bernhard Seefeld (server-side execution C1.7) | fold into `serverPrimaryExecution` once the lattice ranks graduate, then retire the negotiation | implemented (user + session delivery), on by default (2026-08-01) |
| [`serverPrimaryExecutionCrossSpaceClaimsV1`](#serverprimaryexecutioncrossspaceclaimsv1) | `setServerPrimaryExecutionCrossSpaceClaimsConfig()` (then negotiated per connection, absent-false) | **on** | Bernhard Seefeld (server-side execution C3.6b) | fold into `serverPrimaryExecution` once cross-space reads graduate, then retire the negotiation | implemented (delivery gate + amendment-11 attach fence), on by default (2026-08-01) |
| [`experimentalConcurrentWatchRefresh`](#experimentalconcurrentwatchrefresh) | `IRemoteStorageProviderSettings`; in the shell, the `commonfabric.concurrentWatchRefresh()` console command (localStorage, per browser profile) | off | Ben Follington (#4937; shell toggle #4974) | graduate to always-on after live measurement, or remove if superseded | implemented behind the flag, off by default, not yet measured over real latency |
| [`cfcRenderCeiling`](#cfcrenderceiling) | `commonfabric.cfcRenderCeiling()` in the browser (localStorage) | off | Bernhard Seefeld (#4550) | graduate once exchange resolution lands | implemented, off by default, dogfood only |
| [`fuseNfsCacheTuning`](#fusenfscachetuning) | `cf fuse mount --attrcache-timeout <whole seconds; 0 = untuned>` or `--noattrcache` | cf adds `attrcache-timeout=1` (one second) to FUSE-T mounts | Ian Hickson | keep the default; shrink the exec.ts listing-recheck delay once the default has field-soaked | implemented, on by default for FUSE-T, soak-validated |

Removed or never-shipped flags that documentation elsewhere still references are
recorded in [Appendix A](#appendix-a-removed-and-never-shipped-flags). Toggles
that look like flags but are operational, debugging, or test controls rather
than experimental-feature gates are listed in [Appendix
B](#appendix-b-related-toggles-that-are-not-experimental-flags).

---

## Category 1: Runtime experimental options

These flags make up the `ExperimentalOptions` interface in
[`packages/runner/src/runtime.ts`](../../packages/runner/src/runtime.ts). They
are passed as `new Runtime({ experimental: { ... } })`. Each flag defaults to
`undefined`, which means "take the built-in default".
`persistentSchedulerState`, `commitPreconditions`, `computedCellIds`,
`serverPrimaryExecution`, `serverPrimaryExecutionContextLatticeClaims` and the
three server-primary rank/cross-space CANDIDATE dials default on; the other
flags in this category default off unless their section says otherwise.

Where a flag's default lives depends on how it is consumed. Most bridge to an
ambient control point, and the constructor round-trips through it so
`runtime.experimental.*` reports the effective value. `computedCellIds` and the
three candidate dials have no ambient control point — the host reads them
straight off `runtime.experimental` — so the constructor normalizes them
locally instead, after the override banner, which is why an omitted value never
shows up as an explicit override in the log.

**An omitted flag INHERITS; it does not reset (2026-08-01).** The ambient
control points take an optional value, and `undefined` means "no opinion —
leave whatever is installed alone", never "put the compiled default back".
`resetXConfig()` is how you ask for the default explicitly. This matters
because a Runtime is not the only writer: a memory server installs
`EXPERIMENTAL_SERVER_PRIMARY_EXECUTION` at its own construction
(`applyServerPrimaryExecutionEnvConfig`), and every realm-separated deployment
has a server with no Runtime beside it. Correspondingly, **a Runtime's writes
to these dials are scoped to its own lifetime**: it records the value each
NAMED flag displaced and restores exactly those on `dispose()` — not the
compiled default, which would be a third opinion nobody expressed. So an
env-set configuration survives any number of Runtime construct/dispose cycles.
Before this, constructing or disposing a Runtime that never mentioned a flag
silently reverted it to the compiled default — which for `serverPrimaryExecution`
is the whole deployment rollback lever. The table lives in
`AMBIENT_EXPERIMENTAL_DIALS`
([`packages/runner/src/runtime.ts`](../../packages/runner/src/runtime.ts)) and
the setter contract is stated once at the top of the flag section in
[`packages/memory/v2.ts`](../../packages/memory/v2.ts).

The mapping from environment variable to flag is defined once, canonically, as
`EXPERIMENTAL_ENV_VARS` in
[`packages/runner/src/runtime-presets.ts`](../../packages/runner/src/runtime-presets.ts),
and read by `experimentalOptionsFromEnv(envReader)`. The toolshed and the CLI
both go through that one mapping, so their wirings cannot drift; the shell
reads the same variables from its build-time defines.
Nine flags are env-reachable (`modernCellRep`, `persistentSchedulerState`,
`serverPrimaryExecution`, `serverPrimaryExecutionDocSetWatch`,
`serverPrimaryExecutionContextLatticeClaims`, `eagerSourceAnnotation`,
`systemPatternAutoUpdate`, `plainResultReceipts`, `computedCellIds`);
`commitPreconditions` and the three rank/
cross-space candidate dials are deliberately mapped to `null` there, which
records "not env-reachable" as a decision rather than an omission. Note the
distinction the two server-primary subcapability flags draw: a NEGOTIATION
dial (what this peer advertises in its `hello`) is env-reachable, because a
peer that cannot advertise makes the whole feature unreachable; a RANK dial
(which context ranks a host issues, which candidates an executor produces)
stays programmatic-only.

The three server-primary env NAMES are owned by
[`packages/memory/v2.ts`](../../packages/memory/v2.ts)
(`SERVER_PRIMARY_EXECUTION_ENV`,
`SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH_ENV`,
`SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS_ENV`) and imported into the
canonical
mapping, because memory servers apply the same variables THEMSELVES at
construction (`applyServerPrimaryExecutionEnvConfig`, called by toolshed's
storage route and the standalone server): a server's advertised capabilities
must derive from its environment directly, not from whether a runner Runtime
happens to be constructed — or disposed — in the server's realm. FW6 closed
exactly that gap (advertisement stuck all-false in every realm-separated
topology).
The mapping accepts exactly `"true"` and `"false"`; any other value is ignored
with a warning rather than coerced. See [How flags
propagate](#how-flags-propagate).

### `modernCellRep`

- **Toggle via.** `EXPERIMENTAL_MODERN_CELL_REP` environment variable (through
  the canonical mapping described in the category note above), or directly
  through `RuntimeOptions.experimental.modernCellRep`. The ambient control point
  is `setModernCellRepConfig` in
  [`packages/data-model/src/cell-rep.ts`](../../packages/data-model/src/cell-rep.ts).
- **Added by.** Dan Bornstein, in "Define a new 'modern cell representation'
  experiment flag" (#3818, 2026-06-02).
- **Purpose.** Switches the data model over to the new "cell representation"
  classes and their serialized form. In the modern form a link serializes as a
  `FabricHash`; in the legacy form it serializes as the older
  `{ "/": "<tag>:<hash>" }` object. The flag lets both encodings coexist while
  the format transition happens.
- **Current default and planned end state.** Off by default. The plan is to
  graduate it to always-on once every client and server produce and accept the
  modern encoding, and then delete the flag along with the legacy object-form
  code paths.
- **Status on 2026-07-08.** Implemented and gated on both sides: the data-model
  dispatch reads the ambient flag, and the memory wire protocol carries a
  `modernCellRep` capability that peers must agree on
  (`compatibleMemoryProtocolFlags` requires the two sides to match). Off by
  default. The dedicated plumbing test
  (`packages/runner/test/experimental-options.test.ts`) passes.
- **Path to removal.** Turn the default on and let it soak; confirm every peer
  in the fleet negotiates `modernCellRep` true; then delete the flag, the legacy
  `{ "/" }` serialization branches in `cell-rep.ts`, and the protocol-capability
  negotiation for it.

### `persistentSchedulerState`

- **Toggle via.** `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` environment variable
  (through the canonical mapping described in the category note above), or
  `RuntimeOptions.experimental.persistentSchedulerState`. The ambient control
  point is `setPersistentSchedulerStateConfig` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts) (the runner owns the
  feature, but the value has to be known at the memory client and server
  handshake, so it lives beside the memory protocol flags).
- **Added by.** Bernhard Seefeld, in "persist scheduler state for rehydration"
  (#3646, 2026-05-28).
- **Purpose.** Persists the scheduler's observations to durable storage through
  memory-v2 and uses them to rehydrate scheduler state after a restart, instead
  of rediscovering everything by re-running.
- **Current default and planned end state.** On by default, with an explicit
  `false` retained as a rollback override while the default-on posture soaks.
  The intended end state remains always-on. The scheduler-observation protocol
  is an optional capability rather than a data-model contract, so peers with
  different settings can still share memory data; the server's setting controls
  whether scheduler rows are accepted on a connection.
- **Status on 2026-07-11.** Implemented; the durable tables, the rehydration
  primitives, and the memory-protocol capability are wired. Default-on rollout
  in progress. The pattern-reload CI job exercises both the default-on posture
  and the explicit-false rollback path. See
  [`docs/specs/persistent-scheduler-state.md`](../specs/persistent-scheduler-state.md)
  and [`docs/specs/scheduler-v2/`](../specs/scheduler-v2/) for the tracked
  status.
- **Path to removal.** Let the default-on posture soak and confirm rehydration
  falls back cleanly when observations are absent or stale; then fold the
  behavior into the base scheduler and delete the rollback flag.

### `serverPrimaryExecution`

- **Toggle via.** `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION` environment variable
  (through the canonical mapping), or
  `RuntimeOptions.experimental.serverPrimaryExecution`. The ambient control
  point is `setServerPrimaryExecutionConfig` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts), because both sides of
  the memory handshake must advertise whether they participate. Since FW6 the
  env variable reaches that ambient on BOTH kinds of host: memory servers
  apply it at construction (`applyServerPrimaryExecutionEnvConfig` — toolshed
  storage route, standalone server), and runner Runtimes bridge
  `experimental.serverPrimaryExecution` at construction, so a server's
  advertisement no longer depends on a Runtime living in its realm. This is
  the one dial with two live writers today, so it is where the inherit rule in
  the category note above is load-bearing: a Runtime that does not name the
  flag leaves the server's env-set value alone, and one that does name it puts
  that value back on `dispose()`. Until 2026-08-01 either event reverted the
  dial to the compiled default, so `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=false`
  was silently undone by any Runtime lifecycle in the server's realm.
- **Added by.** Bernhard Seefeld, in server-primary execution W0.6
  (2026-07-12).
- **Purpose.** Gates the trusted-client server-primary execution protocol:
  capability negotiation, demand, claims, settlements, claim-aware client
  routing, and claimed-builtin passivity. A runtime with the flag off does not
  publish or honor the new control messages. The memory handshake advertises
  the optional `serverPrimaryExecutionV1` capability. When the flag is on, the
  server requires compatible clients and automatically claims every eligible
  action in every active compatible space; there is no per-space opt-in.
  Since the client-passivity arc it also selects the **default external-sink
  disposition** (`RuntimeOptions.externalSinkDisposition`, resolved in
  [`packages/runner/src/runtime.ts`](../../packages/runner/src/runtime.ts)),
  and toolshed's declared one
  ([`packages/toolshed/runtime-options.ts`](../../packages/toolshed/runtime-options.ts)):
  on gives `"suppress"` — a client never runs an egress effect, and `allow` is
  what a server-side executor earns by declaring `"server-executor"` — while
  off gives `"claim-conditional"`, the pre-arc posture in which the client
  performs the egress itself. The two halves are one switch on purpose: the
  flag also gates `addExecutionDemand`, so a passive client with the flag off
  would have no executor to relocate its effects to and the effects would
  simply not happen. An explicit `externalSinkDisposition` overrides both arms.
- **Current default and planned end state.** **On by default since
  2026-08-01** (`SERVER_PRIMARY_EXECUTION_DEFAULT` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts), which both halves of
  the handshake resolve against), together with the rest of the dial set — see
  the ruling box at the top of this document. It is the ONE lever over the
  whole configuration: `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=false` returns a
  deployment to the pre-arc client-primary posture entire, including the
  `externalSinkDisposition` half, because claim issuance at every rank and
  demand publication are both gated on it. Both the server process and the
  browser worker resolve the same default, so an unconfigured fleet negotiates
  the capability rather than silently declining it. The planned end state is
  unchanged: graduate the protocol, then remove the flag once every supported
  client obeys server-primary claims.

  One construction site must resolve the default WITHOUT a Runtime —
  toolshed picks `externalSinkDisposition` while assembling `RuntimeOptions`
  — and it goes through `resolveServerPrimaryExecution()`
  ([`packages/runner/src/runtime-presets.ts`](../../packages/runner/src/runtime-presets.ts))
  rather than reading the raw option. Reading the raw option there would see
  `undefined` for the default and pick the flag-OFF egress posture inside the
  flag-ON configuration: a double dispatch, and precisely the hybrid the arc
  forbids.
- **Status on 2026-07-14.** Runtime, environment, browser-worker, background-
  worker, memory handshake, connection-owned client root demand, one shared
  fenced Worker per active branch/space, durable legacy-background exclusion
  with a synchronously fenced host-local handoff, and the ordered reconnectable
  claim/settlement feed are implemented. Exact claim routing, causal client
  overlays, claimed-builtin passivity, causal-actor gating, canonical
  permanent-builtin failure, failure drills, bounded pool/control health
  signals, and the local Phase 2 product-derived/literal rollout gates are also
  implemented. Process-lifetime placement counters separate completed server
  action runs, classified shadow/authoritative action transactions, and server
  builtin broker requests; client demand publication, Worker start outcomes,
  and accepted-commit index lookup work have distinct wait-path telemetry. The
  parked-worker claim-readiness failure is fixed with
  deterministic cold-wake and replacement coverage. The 500-event
  counterbalanced browser/CPU acceptance gate passes; see the
  [accepted Phase 2 rollout report](../history/development/performance/server-primary-rollout-2026-07-13.md).
  The flag is the only authority rollout control: off remains client-primary
  behavior with no execution pool, while on is the final server-primary mode
  for all eligible compatible pieces. The narrower
  `serverPrimaryExecutionClaimRoutingV1` and
  `serverPrimaryExecutionBuiltinPassivityV1` capabilities now advertise with
  the main flag. A server with the flag on rejects peers missing either
  graduated promise. Use the
  [server-primary execution runbook](./server-primary-execution.md) for
  rollout, rollback, metrics, and reproducible measurement commands.
- **Path to removal.** Complete the shadow, positive-claim, reconciliation,
  and builtin-passivity rollout; confirm every supported deployment and client
  speaks the protocol; make it unconditional; then delete the runtime flag,
  environment/build wiring, and optional-capability negotiation.

### `serverPrimaryExecutionUserRankCandidates`

- **Toggle via.** `RuntimeOptions.experimental.serverPrimaryExecutionUserRankCandidates`
  only. It is mapped to `null` in the canonical `EXPERIMENTAL_ENV_VARS`
  registry — deliberately programmatic-only, like the memory-side
  `serverPrimaryExecutionClaimRank` dial it partners with; the C1.9
  measurement fixture flips both together. There is no ambient control point:
  the host passes the flag to the executor Worker at initialization and the
  Worker's action-transaction router reads it directly.
- **Added by.** Bernhard Seefeld, in server-side execution C1.5a (executor
  candidate context rank, 2026-07-16).
- **Purpose.** Gates USER-RANK candidate production in the executor Worker
  (context-lattice design §2/§6). When on, a computation — or, since C2.8
  (2026-07-18) lifted amendment 8's computation-only conjunct, a supported
  builtin EFFECT — whose observed surfaces include user-scoped addresses
  classifies at user rank: its
  CandidateClaim carries the canonical `user:<did>` context key of the
  Worker's acting principal, and the per-attempt transaction firewall admits
  that lane's user-scoped reads and writes. Session-scoped
  surfaces stay unservable under this flag alone (the session dial below
  owns that rank). Candidate PRODUCTION is what this flag gates; claim
  ISSUANCE is
  additionally gated by `serverPrimaryExecutionClaimRank` on the host, so
  either dial alone keeps user lanes fully inert. Since C1.8 the same flag
  is also the runner-side leg of the pool's user-lane LIFECYCLE
  (`SharedExecutionPoolOptions.userLaneCandidates`, wired from this option
  in toolshed): the shared execution pool opens/renews/closes C1.3 lane
  grants and sends lane-partitioned set-demand only when this flag, the
  host's claim-rank dial, AND the `context-lattice-claims-v1` subcapability
  align.
- **Current default and planned end state.** **On by default since
  2026-08-01**, with the rest of the dial set (see the ruling box at the top
  of this document): user-rank candidates are produced, and the memory-side
  `serverPrimaryExecutionClaimRank` defaults to a stage that issues them.
  Turned OFF, every observation classifies exactly as the space-only executor
  does (space or unservable), zero user-rank candidates are produced, and
  space-lane classification is byte-identical — which is what the C1.9
  two-principal measurement gate uses it for. That off state is a testing-only
  affordance; nothing ships in it.
- **Status on 2026-07-16.** Implemented (C1.5a); C1.5b landed the per-lane
  acting contexts and re-keyed Worker replica, and C1.8 wired the pool's
  user-lane demand aggregation and lifecycle behind the same flag.
- **Path to removal.** Graduate user-rank candidacy with the rest of the C1
  gates, fold it into `serverPrimaryExecution` alongside the claim-rank dial,
  then delete the option and its Worker plumbing.

### `serverPrimaryExecutionSessionRankCandidates`

- **Toggle via.**
  `RuntimeOptions.experimental.serverPrimaryExecutionSessionRankCandidates`
  only. Mapped to `null` in the canonical `EXPERIMENTAL_ENV_VARS` registry —
  deliberately programmatic-only, like the user-rank dial it layers on; C2
  gate fixtures flip it together with the memory-side
  `serverPrimaryExecutionClaimRank` dial's `session` stage.
- **Added by.** Bernhard Seefeld, in server-side execution C2.5 (session-rank
  executor candidate identity, 2026-07-17).
- **Purpose.** Gates SESSION-RANK candidate production in the executor Worker
  (context-lattice design §2/§6, C2). Layered on
  `serverPrimaryExecutionUserRankCandidates` — the rank ladder, mirroring the
  claim-rank dial — so enabling it alone changes nothing. When both are on, a
  computation — or, since C2.8 (2026-07-18), a supported builtin EFFECT
  (scoped-lane egress under the lane grant, context-lattice OQ6) —
  whose observed surfaces include session-scoped addresses
  classifies at session rank (the classification also admits the lane
  principal's user-scoped surfaces — the broader-in-chain chain rule, review
  CA3), and its CandidateClaims carry the canonical
  `session:<did>:<sessionId>` context keys of the OPEN session lanes whose
  demand covers the piece — one candidate per lane, session lanes only
  (review CA9's rank filter). There is deliberately NO pre-lane fallback: a
  bare DID cannot name a session, so with no open session lane a
  session-rank action stays a local shadow with zero candidates — the
  session identity source is the host's lane-grant machinery
  (`openSessionLaneGrant`, C2.3), threaded to the Worker through the claim's
  validated contextKey, never fabricated locally (CA9). Claim ISSUANCE is
  additionally gated by the host's claim-rank dial `session` stage, so
  either dial alone keeps session lanes fully inert. Since C2.7
  (2026-07-17) the same flag is also the runner-side leg of the pool's
  session-lane LIFECYCLE (`SharedExecutionPoolOptions.sessionLaneCandidates`,
  wired from this option in toolshed): the shared execution pool opens,
  reconciles, and drains per-session C2.3 lane grants — with session-lane
  demand derived host-side from the owning session's published demand
  only — and the pool leg is itself a ladder
  (`sessionLaneCandidates` engages only alongside `userLaneCandidates`,
  mirroring the dial layering), so lanes come up only when this flag, the
  user-rank flag, the host's claim-rank dial `session` stage, AND the
  per-session `context-lattice-claims-v1` negotiation align.
- **Current default and planned end state.** **On by default since
  2026-08-01**, with the rest of the dial set (see the ruling box at the top
  of this document). Turned OFF, session-scoped surfaces classify exactly as
  the pre-C2.5 executor does (unservable), and space/user classification is
  byte-identical — a testing-only affordance that nothing ships in. The CA4
  ordering invariant
  (fixture-only while C2.6's named-session delivery narrowing was unlanded —
  the pre-C2.6 principal-wide session-claim broadcast made sibling-session
  claim churn a quadratic spurious-rerun source) is **lifted: C2.6 landed
  2026-07-17** (`#sessionAcceptsClaim` routes session-context claims,
  revokes, and settlements only to the session their contextKey names), so
  the dial may now be enabled wherever the plan's rollout sequencing allows
  — for multi-session spaces that sequencing rides the context-lattice §6
  feed gate, whose structural half landed 2026-07-17 (F1–F6): the doc-set
  surface is staged per space by
  [`serverPrimaryExecutionDocSetWatch`](#serverprimaryexecutiondocsetwatch)
  plus
  [`serverPrimaryExecutionGraphRetirement`](#serverprimaryexecutiongraphretirement).
- **Status on 2026-07-18.** Implemented end-to-end and gate-bound (plan C2
  status, 2026-07-18: COMPLETE): C2.5 landed the router widening on both
  the executor and cooperative-client routers, the CA9 candidate-identity
  rank filter, and the CA3 replica laneScopeKey broader-in-chain collapse;
  C2.7 wired the pool's per-session lane lifecycle and host-derived
  session-lane demand behind the same flag; C2.8 lifted the
  computation-only conjunct (scoped-lane builtin egress under the lane
  grant, OQ6). The C2 acceptance gates that flip this dial run by default
  (`server-execution-session-lane-gate.test.ts`, the lunch-poll placement
  gate, and the CA11 latency gate — all 3/3 consecutive). Off in
  production: enabling session lanes is now a rollout-sequencing decision
  (context-lattice §6 staged enablement), not missing mechanism.
- **Path to removal.** The C2 gates are landed and default-run; graduation
  is now the §6 rollout decision — enable the session stage per the plan's
  sequencing (the live W2.9-style measurement plus ratification of the
  provisional latency budget), fold the dial into `serverPrimaryExecution`
  alongside the claim-rank dial once every rank graduates (the §6 removal
  path), then delete the option and its Worker/pool plumbing.

### `serverPrimaryExecutionCrossSpaceReadCandidates`

- **Toggle via.**
  `RuntimeOptions.experimental.serverPrimaryExecutionCrossSpaceReadCandidates`
  only. Mapped to `null` in the canonical `EXPERIMENTAL_ENV_VARS` registry —
  deliberately programmatic-only; C3 gate fixtures flip it together with the
  memory-side `serverPrimaryExecutionClaimRank` dial's `cross-space-read`
  stage and the host's `cross-space-claims-v1` advertisement.
- **Added by.** Bernhard Seefeld, in server-side execution C3.6 (cross-space
  read servability + issuance admission, 2026-07-18).
- **Purpose.** Admits FOREIGN-space, space-scoped READ surfaces in the
  executor Worker (context-lattice design §6, C3). When on, a computation —
  or supported builtin effect — whose read surface names a foreign space
  classifies `claim-ready` carrying a `crossSpaceReadSpaces` capability
  (rather than the pre-C3.6 `foreign-read-space` unservable verdict), the
  executor router threads those spaces onto the CandidateClaim, and the host
  issues a **cross-space-read claim** after its issuance preflight binds the
  ACTING principal's foreign READ per space (the same
  `#authorizeMessageWithEngine(READ)` resolution the C3.3b mirror gate and the
  C3.4 point read use, on the read space's host). Foreign-read admission is
  ORTHOGONAL to the rank dials — it is a capability, not a fifth lane — so a
  space/user/session-lane claim may all gain it, and it composes with any
  candidacy rank. Foreign WRITES (`foreign-write-space`) and scoped
  (user/session) foreign reads (`foreign-read-scope`) stay rejected at every
  stage (decision #3: v1 foreign reads are space-scoped, default-branch only).
- **Current default and planned end state.** **On by default since
  2026-08-01**, with the rest of the dial set (see the ruling box at the top
  of this document) — including the host's `cross-space-read` claim-rank stage
  and its `cross-space-claims-v1` advertisement, which is what makes foreign
  reads actually serve rather than soft-decline. Turned OFF, a foreign read
  surface classifies exactly as the pre-C3.6 executor does
  (`foreign-read-space`, unservable), and same-space classification is
  byte-identical — a testing-only affordance that nothing ships in.
- **CA4/C3A17 ordering invariant, and why moving the set together satisfies
  it.** The `cross-space-read` claim-rank stage must never be live without the
  `cross-space-claims-v1` delivery cohort gate (C3.6b): a dial-on host that
  never advertised the subcapability would issue claims a non-negotiating
  cohort member would run client-primary beside it (double execution). Until
  2026-08-01 the invariant was honoured by WITHHOLDING the stage outside gate
  fixtures; now it is honoured by construction, because the stage and the
  advertisement default on together. The issuance preflight still enforces it
  independently: it refuses (soft decline) unless BOTH the stage and the
  advertisement hold AND the delivery cohort uniformly negotiates the
  subcapability — so a mixed fleet degrades to a decline, never to double
  execution.
- **Status on 2026-07-23 (C3 complete).** Implemented end-to-end: the
  servability relax on both the static and dynamic classifiers, the
  `crossSpaceReadSpaces` capability threaded executor-router → CandidateClaim
  → issuance, the host issuance preflight (per-space acting-READ binding +
  cohort gate), the claim's recorded `crossSpaceReadSpaces`, the C3.7
  idle-revocation epoch binding, the C3.8 apply-time fence, and the C3.9
  client vector-overlay drop rule — over both the in-process and co-hosted
  transports (C3.10a/b). The composed wake→read→serve loop settles SERVED
  with the vector basis and the client drops the overlay exactly once — each
  step verified clause-by-clause at the memory + runner integration levels,
  over both transports. The composed default-run two-space patterns gate
  (`packages/patterns/integration/server-execution-cross-space-gate.test.ts`,
  C3.11) is the owed top-level acceptance that runs the whole loop through a
  real pool Worker and client Runtime. **Still off in production:** enabling
  the `cross-space-read` claim-rank stage in a deployment is a rollout
  decision, not part of C3 — the option changes nothing observable until
  that stage AND the `cross-space-claims-v1` advertisement go live in the
  deployment, so the flag remains programmatic-only, flipped only by the C3
  gate fixtures.
- **Path to removal.** The C3.7–C3.11 chain has landed; graduation is now a
  rollout decision. Enable the `cross-space-read` claim-rank stage per the
  plan's rollout sequencing, fold the dial into `serverPrimaryExecution`
  alongside the claim-rank dial when cross-space reads graduate, then delete
  the option and its Worker/router plumbing.

### `serverPrimaryExecutionDocSetWatch`

- **Toggle via.** `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH`
  environment variable (through the canonical mapping), or
  `RuntimeOptions.experimental.serverPrimaryExecutionDocSetWatch`. The ambient
  control point is `setServerPrimaryExecutionDocSetWatchConfig` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts); the runtime bridges
  the runner option into it exactly like `serverPrimaryExecution`, and memory
  servers apply the env variable directly at construction
  (`applyServerPrimaryExecutionEnvConfig`, FW6 — see the base flag's entry).
  On a server build the ambient decides whether `getMemoryProtocolFlags`
  advertises the `serverPrimaryExecutionDocSetWatchV1` subcapability (folded
  with the base `serverPrimaryExecutionV1` flag, absent-false); on a client
  build it is the own-side gate the replica ANDs with the negotiated peer
  flag before it exports doc-set membership. Browser builds get the own-side
  half through the shell define
  `$EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH`
  ([`packages/shell/felt.config.ts`](../../packages/shell/felt.config.ts) →
  `EXPERIMENTAL.serverPrimaryExecutionDocSetWatch` in
  [`packages/shell/src/lib/env.ts`](../../packages/shell/src/lib/env.ts) →
  the worker Runtime's `experimental`); before FW6 the define did not exist,
  so no browser build could negotiate the subcapability — the 2026-07-24
  F5-unreachable-from-browser finding.
- **Added by.** Bernhard Seefeld, in server-side execution F3 (server-side
  `docs` WatchSpec kind, 2026-07-17) and F4 (the client replica's closure
  export / boot-root demotion).
- **Purpose.** Gates the F3/F4 feed's steady-state watch surface. When both
  peers negotiate the subcapability and the client dial is on, the client
  replica registers an additive `docs` WatchSpec kind whose membership is its
  held-doc closure (every doc across the confirmed and pending/overlay layers,
  including speculative write targets and framework reads) and demotes the
  overlapping steady-state schema-graph watches make-before-break, so accepted-
  commit waves fan out as server-membership point reads instead of per-wave
  schema-graph re-traversal. Layered strictly above `serverPrimaryExecution`:
  enabling server-primary execution alone never turns it on.
- **Current default and planned end state.** Off by default in every runtime,
  and byte-identical to the flag-off world when off — the entire client export
  path, membership derivation, and graph-watch demotion are behind the dial,
  and a peer that never advertised the kind keeps its graph watches unchanged
  (a mixed fleet stays valid). Both the server process and the client worker
  must enable it for the doc-set surface to engage — and, since FW5, the
  space must also be admitted by the per-space
  [`serverPrimaryExecutionGraphRetirement`](#serverprimaryexecutiongraphretirement)
  dial (the server rejects `docs` watches for unadmitted spaces, and the
  client cleanly stays on graph watches). The planned end state is to
  graduate the feed after the phased rollout and fold this dial into
  `serverPrimaryExecution`, then retire the negotiation.
- **Assessed 2026-08-01 and deliberately LEFT OFF** when the rest of the
  server-primary dial set flipped on. Three reasons, in order of weight.
  (1) It is a different rollout: this dial gates a WATCH-SURFACE change
  (steady-state fan-out as point reads instead of graph re-traversal), whose
  graduation condition is the W2.9 wall-time gate — still a live measurement
  — not the execution-authority question the dial set answers. (2) Flipping
  the boolean alone would change nothing anyway: `docs` watches are admitted
  per space by
  [`serverPrimaryExecutionGraphRetirement`](#serverprimaryexecutiongraphretirement),
  which is the empty set, so every registration would still be rejected and
  every client would still keep its graph watches. A default change with no
  behavioral consequence is noise in this registry. (3) Flipping BOTH — the
  boolean and the retirement set to `*` — would engage an unmeasured
  performance rollout inside the same change as the execution-authority flip,
  making any suite or latency delta un-attributable between the two. Land it
  on its own W2.9 evidence.
- **Status on 2026-07-17.** F3 (server-side `docs` kind, resolved-scopeKey
  membership, per-wave fan-out folded into the refresh loop) and F4 (client
  closure export from the replica doc set, same-step eviction on retraction,
  reconnect re-registration, and space-lane boot-root demotion) are
  implemented. Cold-boot roots keep subscribing schema-graph watches until
  their closure is held; closure growth is covered by transient cold-discovery
  graph watches that demote to membership.
- **Path to removal.** Graduate the feed with the rest of the server-side
  execution rollout, make the doc-set surface unconditional for negotiated
  peers, fold the dial into `serverPrimaryExecution`, then delete the option,
  its env/build wiring, and the optional-capability negotiation.

### `serverPrimaryExecutionGraphRetirement`

- **Toggle via.** `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES`
  environment variable — comma-separated space DIDs, or `*` for every space —
  applied at memory-server construction (toolshed's
  `routes/storage/memory.ts` and the standalone server both call
  `applyServerPrimaryExecutionGraphRetirementEnvConfig`; the parser lives in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts) next to the dial so
  host wirings cannot drift). The ambient control point is
  `setServerPrimaryExecutionGraphRetirementConfig(spaces)`. It is a per-space
  string set, so it does not ride the boolean `EXPERIMENTAL_ENV_VARS`
  registry; it is host-internal and never negotiated on the wire. The
  original F5 design declared "no environment variable; the rollout flips it
  programmatically" — that design is **superseded** (FW5): no programmatic
  flipper ever existed, so the dial was unreachable in any deployment and the
  shipping-critical W2.9 gate could not be executed (Fable review FB10). A
  rollout lever must be reachable from deployment configuration.
- **Added by.** Bernhard Seefeld, in server-side execution F5 (2026-07-17);
  redesigned same day by the feed repair wave FW5 after Fable review FB9.
- **Purpose.** The per-space rollout dial for F5's graph-refresh retirement
  and the consumer of the OQ4 per-space coverage gate. Layered strictly above
  `serverPrimaryExecutionDocSetWatch`. Its behavioral authority is **doc-set
  admission**: the server accepts a `docs`-kind watch only for spaces the
  dial names, and rejects a withheld space's registration with the same clean
  `ProtocolError` shape a non-negotiating server gives — the runner client's
  reconcile catches the typed rejection, keeps its subscribing schema-graph
  watches, and retries on later membership changes, so a withheld space
  **genuinely stays on graph behavior** and withholding it is a real hold
  (the OQ4 property FB9 found missing: the pre-FW5 predicate only ever
  skipped a zero-iteration loop while demotion rode the global client env
  flag). The retirement itself stays a live per-surface, per-watch check in
  the refresh loop (FA3/FA13): the doc-set subcapability must be negotiated
  and admitted members present; a fully-doc-set surface (zero residual graph
  watches) then does zero `session.watch.refresh` traversal — a property
  that is *structural* (the docs kind never enters graph grouping, and the
  demoted client dropped its graph watches), which is why there is no
  server-side "skip" branch pretending otherwise. A surface still holding
  graph watches **fails open** to graph behavior (traversal runs — never a
  delivery gap) and is counted per watch: held surface composition under
  `serverExecutionFeed.refreshResidualGraphWatches`, actually-forced
  traversal under `refreshResidualGraphWatchesTraversed` (FB28), per-space
  DAG work under `refreshResidualDagTraversalsBySpace` (the FB11 mixed-mode
  budget input), and fully-doc-set sessions under
  `refreshFullyDocSetSessions`. The refresh loop deliberately does NOT
  re-consult the dial, so shrinking it never hides an already-admitted
  surface from the regression gauges; dial shrink takes effect for new
  registrations only (a live demoted session keeps its surface until it
  re-registers). The conflict catch-up emitter is untouched, so a conflicted
  commit still receives its `caughtUpLocalSeq` release across the retirement
  (FA7), and the surface still makes one watermark-advancing emission per
  wave (FA1).
- **Current default and planned end state.** The empty set by default: no
  space is admitted, `docs` watches are rejected everywhere, clients keep
  graph watches — byte-identical to the pre-F3/F4 steady state even when the
  boolean doc-set feature flags are on. Engaging the doc-set surface for a
  space therefore requires all three: the client-side and server-side
  `serverPrimaryExecutionDocSetWatch` negotiation AND this dial naming the
  space (or `*`). An operator adds a space only once F1's per-space coverage
  counters (`/api/health/stats`) clear the OQ4 gate for it; adding a space
  whose sessions are not yet fully doc-set is safe (residuals fail open and
  are counted, never a delivery gap). The end state is `*`.
- **Assessed 2026-08-01 and deliberately LEFT EMPTY** when the rest of the
  server-primary dial set flipped on, for the reasons in the doc-set watch
  dial's assessment above — it is the second half of the same watch-surface
  rollout. It also differs in kind from every other dial in the set: it is a
  PER-SPACE operator lever whose whole design (FW5) is that a space is added
  only once F1's coverage counters clear the OQ4 gate FOR THAT SPACE. A
  blanket `*` default would delete the per-space gate rather than graduate it.
- **Status on 2026-07-17 (FW5).** Implemented as described above: admission
  authority (dial-authority fixture in
  `packages/memory/test/v2-feed-retirement-test.ts` pins that a withheld
  space rejects demotion and keeps real graph traversal, and that flipping
  the dial on changes the very next wave to zero-traversal point reads), env
  wiring at both memory-server hosts, per-watch residual classification with
  the FB28 held/traversed split and FB11 per-space budget attribution, and
  the provably-dead `retired` skip branch deleted. FB9/FB10/FB11(gate
  math)/FB28 are closed; the W2.9 wall-time gate itself remains a live
  measurement (see the F5 measurement protocol in
  `docs/specs/server-side-execution/implementation-plan.md`).
- **Path to removal.** Once the W2.9 gate is green across the rollout, set the
  dial to `*`, make doc-set admission unconditional for negotiated peers,
  fold the dial into `serverPrimaryExecution`, and delete the config
  functions and the counters' eligibility gate.

### `serverPrimaryExecutionDemandGrace`

- **Where set.** `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DEMAND_GRACE_MS`
  env, read at pool construction in
  [`packages/toolshed/routes/storage/memory.ts`](../../packages/toolshed/routes/storage/memory.ts)
  (`demandGraceMsFromEnv`) and passed as the `SharedExecutionPool`
  `demandGraceMs` option. Host-internal tuning — never negotiated, no
  ambient global, no client half. Accepts a non-negative integer
  millisecond count; anything else is ignored with a warning. The pool's
  own default is `0` (byte-identical legacy behavior); toolshed's
  construction-site default is `10000`.
- **Added by.** Bernhard Seefeld, client-passivity plan P0 (2026-07-26).
- **Purpose.** How long an execution lane tolerates EMPTY demand before
  aborting an in-flight Worker start or draining a live Worker. The
  browser client publishes execution demand from its piece start/stop
  path, so every navigation transition blips demand empty; without grace
  those blips abort Worker cold-starts faster than they can complete and
  the pool converges to never-live under real navigation cadence (the
  2026-07-26 dead-executor finding: 15 demand snapshots, 2 start
  attempts, both aborted). The window is pool-side start/stop damping
  only: host-side authority (lease sponsorship, lane grants) keeps its
  session-anchored lifecycle, so a departed session's claims fence
  host-side regardless; the grace bounds how long a Worker outlives
  demand (departure parity: stop ≤ grace + settle). Counters:
  `demandGraceBlipsAbsorbed`, `demandGraceExpiries`, and the P0b
  keep-warm cost `demandGraceIdleWorkerMs` under
  `/api/health/stats` → `serverExecutionPool`.
- **Companion knob.** `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_WORKER_STARTUP_TIMEOUT_MS`
  (same strict integer parse, toolshed default `120000`, library default
  `30000`): the executor Worker's init deadline, passed as the
  `DenoSpaceExecutorFactory` `startupTimeoutMs` option. The 30s library
  default loses to real cold-start on a loaded dev machine (the
  2026-07-26 acceptance run failed both starts at exactly 30s with boot
  completing moments later). Also bounds claimed-action activation.
- **Companion knob (P0-R3c).**
  `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_COLD_REFRESH_COOLDOWN_MAX_MS`
  (same strict integer parse; `0`/unset = legacy refresh-every-wave):
  the executor replica's adaptive cold-refresh debounce ceiling, read
  LAZILY in the Worker realm by
  [`packages/runner/src/storage/v2-host-provider.ts`](../../packages/runner/src/storage/v2-host-provider.ts)
  (Workers inherit the toolshed process env — the CF_LOG_TIMING
  channel). `startServerExecutionPool` defaults it to `2000` before any
  Worker spawns, so server-primary implies the debounce. A
  demand-triggered (closure-growth) cold refresh cannot re-run for a
  watch within `4 × its own last refresh cost` (clamped to [250ms,
  this dial]); growth waves inside the window defer through the FB13
  deferred-notice carrier and a tail timer flushes them. Measured
  motivation: 99.6% of one n=20 run's 562 executor cold traversals
  were closure-growth (one watch 147×), and their aggregate engine
  time pushed cold start-to-claim-ready past the demanding page's
  lifetime.
- **Companion knob (P0-R3e).**
  `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_PIECE_LINGER_MS` (same strict
  integer parse; `0`/unset = legacy immediate stop): the executor
  Worker's piece linger, read lazily in the Worker realm by
  [`packages/runner/src/executor/executor-worker.ts`](../../packages/runner/src/executor/executor-worker.ts).
  A structurally removed piece keeps its live graph for the window
  while its AUTHORITY fences immediately (claims release host-visibly
  at removal, the action-unregistered shape); a re-demand inside the
  window reactivates for free instead of re-paying the measured 7-33s
  `runtime.start` instantiation; expiry performs the ordinary stop, and
  reset/worker-stop flush lingers immediately.
  `startServerExecutionPool` defaults it to `30000`.
- **Companion knob (P0 shrink gate, producer side).**
  `RuntimeOptions.experimental.serverPrimaryExecutionDemandShrinkHoldMs`
  (programmatic-only, mapped `null` in the canonical env registry): the
  client runner's demand-shrink gate hold
  ([`packages/runner/src/executor/demand-shrink-gate.ts`](../../packages/runner/src/executor/demand-shrink-gate.ts)).
  Demand GROWTH publishes immediately; SHRINK is held this long and
  folded away when growth follows inside the window, so a same-space
  navigation never publishes the transient empty demand set
  ("sponsor-demand-gone" — 53/53 claim refusals on the real workload).
  Default 10s (the gate's own default, matching the pool grace);
  `0` is byte-identical immediate passthrough; teardown flushes
  immediately regardless. Tests shorten it to assert the held-shrink
  contract without the production window.
- **Companion knob (P1 step 1, frontier growth pulls).**
  `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_COVERED_GROWTH_PULL` (`"1"` on,
  `"0"`/unset legacy; worker-realm lazy read in
  [`packages/runner/src/storage/v2-host-provider.ts`](../../packages/runner/src/storage/v2-host-provider.ts),
  `startServerExecutionPool` defaults `"1"`): a closure-growth cold
  refresh integrates the GROWN FRONTIER the growth detector enumerated
  via exact `docs.read` POINT READS and walks the new subgraph
  client-side — the held set is the boundary, so backlinks into
  already-held docs terminate immediately — merging the snapshots into
  the held set, with the revised held doc itself applied as an F2
  point update (never-held retries and wave-triggered re-colds keep
  the legacy full-closure graph pull). ZERO graph queries on the
  growth path. (A first cut rooted a schema-true `graph.query` at the
  frontier; the gate pair measured it WORSE than the full pull — the
  frontier's backlinks re-entered the whole held closure — which is
  why the walk is client-bounded point reads.) The 2026-07-28
  instrumented confirm run motivated the change: the whole-closure
  demand pull was the dominant serving cost (`graph.query.demand`
  20.6s/run, ZERO coveredSelectorSkips vs ~6k on the watch paths,
  single pulls stalling the serving loop 1.2s), and the engaged tail
  carried +28 ms/note excess slope over flag-off. The separate
  `omitWatchCovered` graph.query opt-in (server-side coverage seeding
  for sessions that DO track watches) landed with the same change and
  stays available to watch-tracked callers.
- **Assessed 2026-08-01 and deliberately LEFT UNCHANGED** when the rest of the
  server-primary dial set flipped on. It is not a boolean and has no "on"
  state to flip to: the question is whether the LIBRARY default (the
  `SharedExecutionPool` option's own `0`) should move to toolshed's `10000`
  now that server-primary is the default posture. It should not, on the
  evidence: `new SharedExecutionPool` has exactly one production construction
  site — `startServerExecutionPool` in toolshed's storage route — and it
  already passes `demandGraceMsFromEnv()`, i.e. `10000` unless an operator
  overrides it. Every other constructor in the repository is a test or gate
  fixture that picks its own window deliberately. Moving the library default
  would therefore change no deployment and would silently re-tune fixtures
  that chose `0` on purpose. The calibrated value still folds in when P1
  measures the cold-start and navigation-blip distributions, per the removal
  note below.
- **Removal.** Fold calibrated fixed values into `serverPrimaryExecution`
  once P1 measures Worker cold-start and navigation-blip distributions.

### `plainResultReceipts`

- **Toggle via.** `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS` env var, or
  `RuntimeOptions.experimental.plainResultReceipts`. Env-reachable so the CLI
  invocation-protocol work can enable it per process during integration.
- **Added by.** Mike Salisbury, verb-contract WS-C
  (`docs/plans/pattern-verb-contract-implementation.md`).
- **Purpose.** A handler's return value containing reactives/cells projects
  into its per-event receipt cell via the result-pattern path, but a **plain
  JSON return is discarded** — the receipt-only branch writes `{}`. Under this
  flag the receipt carries the (already-normalized) plain return instead, so a
  caller — or a same-id retry that collides on the create-only receipt — can
  read the verb's result back by receipt address. `{}` remains the shape for
  value-less handlers. Requires `commitPreconditions` (the receipt write
  itself) to be active, which it is by default.
- **Current default and planned end state.** Off by default. Flips on once the
  verb-contract WS-D integration proof (caller-supplied event id → collide →
  read back the original result, cross-process) is green; after a bake period
  the behavior folds into base receipt semantics and the flag is deleted.
- **Path to removal.** Delete the flag and make the projection unconditional in
  `handleJavaScriptHandlerResult`'s receipt-only branch; update the receipt
  content note in `docs/specs/scheduler-v2/README.md` §7.6.

### `commitPreconditions`

- **Toggle via.** `RuntimeOptions.experimental.commitPreconditions` only. It has
  no environment variable today: it is mapped to `null` in the canonical
  `EXPERIMENTAL_ENV_VARS` registry, which puts "not env-reachable" on the record
  as a deliberate choice rather than leaving it absent from one wiring. The
  built-in behavior is enabled; an explicit `false` is a programmatic rollback
  override while the flag remains.
  The ambient control point is `setCommitPreconditionsConfig` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts).
- **Added by.** Bernhard Seefeld, in "speculation lineage for event-launched
  work (scheduler-v2 E1)" (#4090, 2026-06-12).
- **Purpose.** Attaches origin-committed preconditions to scheduler-v2 lineage
  commits, so that event-launched follow-up work commits only against the state
  it was speculated from; create-only preconditions to durable event result
  receipts so competing runners cannot overwrite an existing terminal receipt;
  and, since #4649, create-only consumption receipts for **single-use CFC
  grants** (`docs/specs/cfc-persisted-declassification.md` §2.2).
- **Current default and planned end state.** On by default as part of
  scheduler-v2 speculation lineage and receipt enforcement. An explicit
  programmatic `false` remains a rollback override; under that override,
  single-use grants fail closed rather than silently becoming multi-use, and
  no handling publishes a receipt address on its transaction
  (`tx.handlingReceiptLink` stays absent) — nothing creates or create-only
  marks that cell while the flag is off, so an address would name a witness
  that does not exist. The planned end state is to remove the rollback flag
  and make the behavior unconditional.
- **Status on 2026-07-10.** Implemented for lineage commits and event-result
  receipts, single-use grant consumption, and the memory protocol; on by
  default, with explicit programmatic opt-out retained temporarily.
- **Path to removal.** This exists to serve scheduler-v2 speculation lineage,
  durable event receipts, and single-use CFC grant consumption. It can be
  deleted only when lineage and create-only receipt enforcement are
  unconditional base semantics. At that point remove the flag, the lineage and
  receipt precondition attachment, the storage transaction wiring, and the
  server-side precondition check in the memory engine. The single-use grant path
  then drops its availability check (`cfcGrantReceiptsAvailable` in
  `packages/runner/src/cfc/grants.ts`), not the receipts themselves.

### `eagerSourceAnnotation`

- **Toggle via.** `EXPERIMENTAL_EAGER_SOURCE_ANNOTATION` environment variable, or
  `RuntimeOptions.experimental.eagerSourceAnnotation`. The ambient control point
  is `setEagerSourceAnnotation` in
  [`packages/runner/src/builder/module.ts`](../../packages/runner/src/builder/module.ts).
  Unlike the other env-backed flags, the runtime propagates this one only when
  it is set explicitly, because the ambient flag is also a test seam.
- **Added by.** gideon, in "make fn.src lazy/debug-only — re-root identity off
  .src" (#4458, 2026-07-06).
- **Purpose.** Resolves the per-primitive debug source annotation (`fn.src`)
  eagerly at module evaluation instead of lazily. Resolving it is a stack
  capture plus a source-map walk for every primitive, which is the single
  largest cost in the cold boot floor (on the order of eighty milliseconds or
  more per cold piece boot). Identity never reads `.src`, so this is purely a
  debugging convenience.
- **Current default and planned end state.** Off in production. Shell
  development builds turn it on so that per-primitive source locations keep
  working while debugging; the build define in
  [`packages/shell/felt.config.ts`](../../packages/shell/felt.config.ts)
  supplies the value, and
  [`packages/shell/src/lib/env.ts`](../../packages/shell/src/lib/env.ts)
  defaults it to on when the environment is `development`. Unlike the flags
  above, this one is not expected to graduate: it trades boot time for debug
  fidelity and stays off in production by design.
- **Status on 2026-07-08.** Implemented: reachable on the server through the
  canonical environment mapping (like every env-backed flag), defaulted on in
  shell development builds, and honored by the runtime.
- **Path to removal.** There is no planned removal. It would only be deleted if
  the debug source-annotation mechanism itself were removed, which is unlikely
  because `.src` is a public debugging surface.

### `systemPatternAutoUpdate`

- **Toggle via.** `EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE` environment variable
  (through the canonical mapping) server-side, the shell build define of the
  same name (injected by
  [`packages/shell/felt.config.ts`](../../packages/shell/felt.config.ts) via
  [`packages/shell/src/lib/env.ts`](../../packages/shell/src/lib/env.ts))
  browser-side, or `RuntimeOptions.experimental.systemPatternAutoUpdate`.
- **Added by.** Bernhard Seefeld, in "system-pattern auto-update (in-place
  rollforward, flag-gated)" (#4611, 2026-07-08); defaulted on for the shell in
  #4619 (2026-07-09).
- **Purpose.** Rolls same-toolshed system-source patterns forward in place when
  their source serves a newer content identity. Persisted default-app and home
  roots reconcile before bootstrap. Every other watched pattern starts first;
  its successful instantiation commit launches a background check, so network
  and compilation never delay its current graph. An unstamped non-root recovers
  its verified authored entry filename and becomes tracked only when that
  same-origin route implements `?identity`. Missing/failing identity routes are
  ordinary non-system sources and remain untouched.
  Every accepted move downloads and compiles the complete authored closure and
  permits an in-place `patternIdentity` swap only when the compiler-produced
  entry has exactly the advertised identity and selected export symbol.
  Ordinary patterns preserve their selected export; default-pattern routes
  select the official source's `default` export. Fetch, compile, evaluation,
  identity-mismatch, and commit failures leave the original pointer and running
  graph untouched. Equal identities let ordinary patterns stop immediately
  (and persist newly proven source provenance); roots take the fast path only
  after the persisted artifact loads, so an unloadable root can rebuild through
  the same identity-authorized source path before bootstrap.
  Persisted roots are resolved without starting. A pre-provenance root may be
  back-filled only when its stored `{ identity, symbol }` exactly equals the
  current official entry's advertised content identity; stale, custom, and
  repository-pinned sourceless roots remain pinned —
  except a stale sourceless root whose stored pattern the current runtime
  explicitly cannot load (probe resolves `undefined`; a probe error stays
  pinned, and `cfcEnforcementMode: "disabled"` — where the probe is
  unsupported — stays pinned too): that root is replaced with the official
  system root for the space kind (home.tsx / default-app.tsx), recording the
  displaced ref under `displacedPattern` meta (see pattern-updates.md for the
  full exception semantics).
  URL-based root creation and recreation stamp provenance; custom
  `RuntimeProgram` recreation does not. Repository-pinned sourceless patterns,
  cross-origin sources, default roots reached by the generic post-start hook,
  and starts that intentionally install no pattern watcher remain excluded. The
  check remains best-effort; if identity lookup or replacement compilation is
  unavailable, an ordinary pattern keeps running and the subsequent root start
  retains its normal loud failure behavior. The update path does not consult
  build SHA metadata; a rolling deployment that mixes
  identity/source/import revisions fails closed at the compiled-identity
  comparison. See
  [`docs/specs/pattern-imports/pattern-updates.md`](../specs/pattern-imports/pattern-updates.md).

  **Current behavior.** Before a release, the existing golden replay tests load
  representative state written by the previous pattern version. They verify
  that the new version preserves the state's intended meaning and behavior. The
  updater itself does not infer stable-key, stable-cause, migration, or
  behavioral compatibility during deployment.

  **Planned behavior.** The general piece-source lifecycle will reject known
  structural schema incompatibilities before applying an unattended source
  transition. Semantic compatibility will continue to be checked before release
  rather than inferred by the runtime.
- **Current default and planned end state.** The runner built-in default is off
  like every flag in this category; the shell build injects `true` unless the
  define is set to `"false"`, so the deployed product (and local shell dev
  builds) run it on for roots and other same-toolshed system-source patterns.
  Server-side processes
  (toolshed, CLI) leave it off unless the env var is
  set. End state:
  graduate to always-on for system sources once golden-replay coverage has
  soaked, then delete the flag.
- **Status on 2026-07-22.** Implemented; on in the shell for all tracked system
  roots, home included ([`systemPatternAutoUpdateHome`](#appendix-a-removed-and-never-shipped-flags)
  removed), and for other patterns whose verified source path exposes
  `?identity`; off elsewhere. Root reconciliation and broken-root repair run
  before bootstrap, while ordinary-pattern checks run after instantiation.
- **Path to removal.** Make the check unconditional and remove the flag.

### `computedCellIds`

- **Toggle via.** `EXPERIMENTAL_COMPUTED_CELL_IDS` environment variable
  (through the canonical env registry) or
  `RuntimeOptions.experimental.computedCellIds`.
- **Added by.** Robin McCollum, in #4659 (spec:
  [`docs/specs/computed-cell-identity.md`](../specs/computed-cell-identity.md)).
- **Purpose.** Mints kind-schemed entity ids (`computed:fid1:<hash>`, the
  `computed:` URI scheme replacing `of:`) for derived internal cells. The
  builder classifies written internals as computed by default, then applies
  conservative writer- and input-side disqualifiers. These include streams;
  handler, writable-proxy, effect, opaque, and non-replayable writers; and
  roots handed writable to handlers, sub-patterns, sub-pattern operations, or
  non-replayable builtins. The linked spec is the exhaustive classifier
  reference. The flag gates minting only; readers accept both id forms
  unconditionally, so it can flip either way without a migration — but see the
  version-skew note below.
- **Current default and planned end state.** On by default. An explicit
  `false` remains a rollback override for version skew while the flag soaks;
  clients predating the `computed:` scheme throw on such ids arriving via sync
  (old servers are safe — an unknown scheme parses as no kind and stays
  strict). Once the rollout is stable, make minting unconditional and delete
  the flag. The computed-cell write-conflict policy (ack-and-drop for stale
  all-computed commits) remains a separately gated follow-up.
- **Status on 2026-07-23.** Kind-schemed minting landed in #4659 and is on by
  default. Readers accept both schemes unconditionally, and explicit `false`
  retains the legacy `of:` minting behavior as a temporary rollback path.
- **Path to removal.** Confirm all syncing clients carry `computed:`-aware
  readers and the default-on rollout has soaked; then remove the environment
  mapping, runtime option, builder guard, and legacy rollback tests.

---

## Category 2: Contextual Flow Control enforcement rollout dials

Contextual Flow Control (CFC) is the label-propagation and egress-gating layer
that decides which writes and outbound requests are allowed based on the
confidentiality and integrity labels the values carry. It is being rolled out in
stages, and each stage has its own dial on `RuntimeOptions` in
[`packages/runner/src/runtime.ts`](../../packages/runner/src/runtime.ts). The
dial types live in
[`packages/runner/src/cfc/types.ts`](../../packages/runner/src/cfc/types.ts).

Unlike the Category 1 flags, most of these are not simple on/off booleans; they
are staged dials, usually `off` then `observe` (evaluate and emit diagnostics
but do not reject) then `enforce` (reject on a violation).

They are not wired to environment variables. Instead, the first-party posture is
set once in `coreOptions`, the shared core that every construction preset
composes, in
[`packages/runner/src/runtime-presets.ts`](../../packages/runner/src/runtime-presets.ts).
`coreOptions` pins `cfcEnforcementMode` to `enforce-explicit`; the other CFC
dials are deliberately left on their constructor defaults (`off` or none) there,
with a comment marking `coreOptions` as the one place to flip a dial when a
first-party rollout begins. So the place to advance a CFC rollout across the
whole fleet is that one function, not each call site. A few presets accept
per-environment overrides: `patternTest` and `unitTest` take a laxer
`cfcEnforcementMode`, and `browserWorker` takes host-controlled
`cfcEnforcementMode` and `cfcFlowLabels` from the shell's initialization data.
The interactive `cf-harness` and the `fuse` mount expose the enforcement mode
through `CF_CFC_MODE` for testing. Because these dials are keys of
`RuntimeOptions`, the exhaustive `RUNTIME_OPTION_KEYS` registry in the same file
makes adding a new one a compile error until it is classified across every
preset. The staging plan is tracked in the CFC design docs under
[`docs/specs/`](../specs/) (for example the S16 default-transition design and
the per-epic implementation notes).

### `cfcEnforcementMode`

- **Toggle via.** `RuntimeOptions.cfcEnforcementMode`, pinned for first-party
  processes in `coreOptions` (see the category note). The cf-harness and fuse
  read `CF_CFC_MODE` as an override.
- **Added by.** Bernhard Seefeld, in "Implement runner commit-boundary" (#3263,
  2026-04-14).
- **Purpose.** The master strictness ladder for commit-boundary CFC enforcement.
  Values are `disabled`, `observe`, `enforce-explicit`, and `enforce-strict`,
  in increasing strictness. `disabled` runs no gates; `observe` emits audit
  diagnostics without rejecting; `enforce-explicit` rejects writes that violate
  explicit labels; `enforce-strict` also rejects violations that come from
  inferred taint.
- **Current default and planned end state.** The type-level default constant
  (`DEFAULT_CFC_ENFORCEMENT_MODE`) is `disabled`, but both the `Runtime`
  constructor and the shared `coreOptions` preset set `enforce-explicit`, so
  boundary enforcement is on by default in the product. (The preset pins the same
  value the constructor would default to, so that a future change to the
  constructor default cannot silently relax first-party processes.) The
  content-addressed compilation cache is also gated on this being anything other
  than `disabled`. Over time the default is expected to tighten toward
  `enforce-strict`.
- **Status on 2026-07-08.** Active. All four rungs of the ladder are
  implemented; the ladder itself is a permanent part of the system rather than a
  temporary flag.
- **Path to removal.** The dial is not planned for removal. What changes over
  time is the default rung; the `disabled` and `observe` rungs stay available
  for local development and diagnostics.

### `cfcFlowLabels`

- **Toggle via.** `RuntimeOptions.cfcFlowLabels`.
- **Added by.** Bernhard Seefeld, in "S16 default transition — flow-label
  propagation" (#4011, 2026-06-10).
- **Purpose.** Controls flow-label propagation at the commit boundary. Values are
  `off`, `observe`, and `persist`. `observe` computes the conservative label
  join and emits diagnostics but writes nothing; `persist` writes the derived
  label components onto every value write target. Propagation runs only when the
  enforcement mode is at least `observe`; it derives and stores labels but never
  rejects on its own.
- **Current default and planned end state.** `off` by default. The target is to
  move toward `persist` as the downstream egress gates (render ceiling, sink
  ceilings, and the LLM path) come online.
- **Status on 2026-07-08.** Implemented and in staged rollout; the core
  propagation work is done and further stages are tracked in the S16 design doc.
- **Path to removal.** Flow-label propagation is load-bearing for the S16 audit
  transition, so the dial is not expected to be removed; it will settle on
  `persist` as its steady state.

### `cfcWriteFloor`

- **Toggle via.** `RuntimeOptions.cfcWriteFloor`.
- **Added by.** Bernhard Seefeld, in "write-side requiredIntegrity floor (Epic
  D3, SC-18)" (#4479, 2026-07-02).
- **Purpose.** A write-side minimum-integrity check. Values are `off`,
  `observe`, and `enforce`. `observe` evaluates the floor and emits diagnostics;
  `enforce` records a rejection reason when a write's integrity falls below the
  floor. The floor tests the integrity of the written value, not of the reads
  that produced it.
- **Current default and planned end state.** `off` by default. The target is to
  move toward `enforce` once field testing confirms the floor does not
  over-reject legitimate writes.
- **Status on 2026-07-08.** Implemented and in staged rollout.
- **Path to removal.** Once integrity propagation is complete and the floor is
  proven safe, the check could fold into the base enforcement ladder and the
  separate dial could be retired.

### `cfcTriggerReadGating`

- **Toggle via.** `RuntimeOptions.cfcTriggerReadGating` (a plain boolean).
- **Added by.** Bernhard Seefeld, in "trigger-read gating on the enforcement
  side (Epic H5, SC-3)" (#4488, 2026-07-02).
- **Purpose.** Closes a residual side channel where a reactive rerun is triggered
  by an invalidating write. When on, the addresses whose invalidating writes
  scheduled the rerun join the consumed-read set that the egress ceiling and the
  input-requirement gates quantify over, so the rerun cannot leak information
  through the mere fact that it was triggered. It fails closed and costs extra
  metadata resolution per commit prepare.
- **Current default and planned end state.** `false` by default. The target is to
  move toward `true` once the per-commit metadata resolution cost is acceptable.
- **Status on 2026-07-08.** Implemented and in staged rollout.
- **Path to removal.** Once the cost is acceptable (or metadata caching removes
  it), the default could flip to `true` and the gating could become
  unconditional, retiring the dial.

### `cfcPolicyEvaluation`

- **Toggle via.** `RuntimeOptions.cfcPolicyEvaluation`.
- **Added by.** Bernhard Seefeld, in "boundary policy evaluation dial + coherent
  requiredIntegrity matcher (Epic B, stage B5)" (#4566, 2026-07-07).
- **Purpose.** Controls exchange-rule policy evaluation. Values are `off`,
  `observe`, and `enforce`. `off` decides gates on the raw labels, byte-identical
  to before the dial existed; `observe` evaluates the gated labels to a fixpoint
  and emits diagnostics while still deciding on the un-rewritten label; `enforce`
  decides on the rewritten label and fails closed when the evaluation runs out of
  fuel.
- **Current default and planned end state.** `off` by default. The target is to
  move toward `enforce` once the policy rule sets and deployment policies are
  stable.
- **Status on 2026-07-08.** Implemented and in staged rollout.
- **Path to removal.** Once policy evaluation is the norm, the dial could settle
  on `enforce` and be retired.

### `cfcDeclaredMonotonicity`

- **Toggle via.** `RuntimeOptions.cfcDeclaredMonotonicity`.
- **Added by.** Bernhard Seefeld, in "declared-component monotonicity gate
  (WP5, spec §8.12.1/§8.12.8)" (#4647, 2026-07-09).
- **Purpose.** Guards the one point where a persisted path's declared
  (store-policy) label component can change — the schema-walk re-mint at the
  commit boundary — with §8.12.1's `canUpdateStoreLabel` rule: confidentiality
  may only add clauses or remove alternatives, and the declared integrity
  claim may only remove atoms. Values are `off`, `observe`, and `enforce`.
  `observe` emits a structured diagnostic on a non-monotone re-mint while
  persisting today's bytes; `enforce` records a fail-closed prepare reason
  (rejecting the commit under the enforcing enforcement modes). The gate
  governs only the `declared` component; derived/link/structure components
  keep their §8.12.8 replace disciplines. The per-transaction privileged
  widening exemption (`setCfcDeclaredWideningExemption`, trusted-builtin
  only) is the seam for the future §8.12.7 route 2b declassification event.
- **Current default and planned end state.** `off` by default. The target is
  `observe`, then `enforce` after soak — the route 2b rewrite event must not
  ship before this gate is enforced
  (`docs/specs/cfc-persisted-declassification.md` §4–§5).
- **Status on 2026-07-09.** Implemented, off by default.
- **Path to removal.** Not planned for removal: monotonicity is a permanent
  store invariant. Once `enforce` has soaked, the dial could settle there and
  the `off`/`observe` rungs remain for diagnostics, mirroring the enforcement
  ladder.

### `cfcPrefixProvenanceStats`

- **Toggle via.** `RuntimeOptions.cfcPrefixProvenanceStats` (a plain boolean),
  not env-wired. The presets do not pin it: like every CFC dial except the
  enforcement mode, it is left out of the shared `coreOptions` and rides the
  `Runtime` constructor default of `false` until a deployment sets it. The
  preset classification table marks it `core-default (off)`.
- **Added by.** Bernhard Seefeld, in "D4 write-prefix precision counters
  (value-level provenance stage 0, SC-24)" (#4623, 2026-07-09).
- **Purpose.** Measurement only, and the one dial here that does not affect
  enforcement. When on, each prepared transaction that has at least one
  protected write records per-prepare precision counters into `getCfcStats()`:
  gated-read counts per protected write (prefix versus transaction-global),
  bound-source classifications, and S7-exemption fires. Enforcement decisions
  are byte-identical whether it is on or off. It exists to gather the "measure
  before building" data described in
  [`docs/specs/cfc-value-level-provenance.md`](../specs/cfc-value-level-provenance.md)
  §6, which the project needs before deciding whether to build the larger
  value-level provenance narrowing (its "T1").
- **Current default and planned end state.** `false` by default; off skips all
  measurement for a single presence check. There is no plan to graduate it to
  on across the fleet — it is a diagnostic that a deployment turns on to collect
  precision data.
- **Status on 2026-07-09.** Implemented, off by default. Covered by
  `packages/runner/test/cfc-prefix-provenance-stats.test.ts`.
- **Path to removal.** Once the Stage 0 measurement has informed the
  value-level-provenance decision (build the narrowing, or not — the entry
  criteria are deliberately unscheduled in the spec's §8), the counters either
  fold into that feature or are removed. Because enforcement is unaffected,
  retiring it is low-risk.

### `cfcLabelMetadataProtection`

- **Toggle via.** `RuntimeOptions.cfcLabelMetadataProtection`.
- **Added by.** Bernhard Seefeld, in "inv-12 stage 1 — cross-space
  label-metadata representation transform" (#4638, 2026-07-09).
- **Purpose.** Applies the invariant-12 representation classes at the
  cross-space persist seam: source-bearing atom fields of label entries whose
  observations originate outside the destination space are persisted as
  `{digestOf: …}` commitment forms (or verbatim where the classification
  table says `public`), identically at the `["cfc"]` envelope and the
  sigil-carried label views, so a destination space's replicas stop
  disclosing source-space principal identities (`Caveat.source`, clause
  DIDs, `LinkReference` addresses). Values are `off`, `observe`, and
  `enforce`: `observe` computes the transformed form and emits a structured
  divergence diagnostic while persisting today's bytes (the rollout
  metric); `enforce` persists the transformed form. Enforcement matching is
  commitment-aware in both directions (read gating digests the candidate;
  exchange patterns digest-match concrete values and refuse to bind
  variables over committed fields). Same-space-only labels always persist
  verbatim.
- **Current default and planned end state.** `off` by default. Target is
  `observe` to count divergences, then `enforce`
  (`docs/specs/cfc-label-metadata-confidentiality.md` §5, SC-25).
- **Status on 2026-07-09.** Implemented, staged rollout.
- **Path to removal.** Not planned for removal: the representation rule is a
  permanent inv-12 obligation; once `enforce` soaks the dial settles there
  with the lower rungs kept for diagnostics, like the other CFC ladders.

> The related `RuntimeOptions` fields `cfcSinkMaxConfidentiality`,
> `cfcPolicyRecords`, and `cfcTrustConfig` are CFC *configuration inputs* (the
> policy records, per-sink ceilings, and trust statements the dials evaluate
> against), not on/off rollout dials, so they are not tracked as flags here.
> They are validated and frozen at `Runtime` construction.

---

## Category 3: Storage and memory-protocol capability flags

### `conflictAdmissionMode`

- **Toggle via.** `CF_CONFLICT_ADMISSION` environment variable (read directly in
  the storage layer, not through the toolshed environment schema), or
  `setConflictAdmissionMode()` in
  [`packages/runner/src/storage/v2.ts`](../../packages/runner/src/storage/v2.ts).
  The legacy `setConflictAdmissionEnabled(true|false)` wrapper maps `true` to
  `preempt` and `false` to `off`.
- **Added by.** William Kelly, in "gate conflict retries on caught-up local seq"
  (#4237, 2026-06-22).
- **Purpose.** Chooses what the client does with a new commit whose reads land on
  an identifier that is still catching up after an earlier conflict. Values are
  `off`, `preempt`, and `hold`. `preempt` assumes the commit will conflict and
  reverts and re-runs it locally without sending. `hold` waits for the catch-up,
  re-runs the server's precondition check locally against the now-current
  confirmed sequence numbers, reverts only the genuinely stale commits, and
  sends the rest.
- **Current default and planned end state.** `off` by default. Both non-default
  modes were measured on the lunch-poll workload: `preempt` was net-negative
  (it pre-empted commits that would have succeeded), and `hold` was neutral
  (safe but no win, because the staleness there is only knowable on the server).
  The code comment warns not to enable either mode without re-measuring on the
  target workload.
- **Status on 2026-07-08.** Implemented, off by default. It is a tuning dial that
  has not shown a win on the workloads measured so far.
- **Path to removal.** Either it finds a workload where a non-default mode pays
  off and graduates into a documented tuning knob, or it is removed once the
  underlying conflict-retry behavior is settled and the experiment is closed.

### `syncSchemaTableV2`

- **Toggle via.** `setSyncSchemaTableConfig()` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts). It is advertised as a
  capability in the memory `hello` handshake and negotiated per connection, so a
  peer only receives the compact form if it advertises support.
- **Added by.** Ben Follington, in "intern schemas in sync frames" (#4292).
- **Purpose.** A wire-size optimization: it packs the schemas in a sync payload
  into a hash-keyed, frame-local schema table instead of repeating them inline.
  It changes only the size of the payload, not its meaning. Peers that do not
  advertise the capability keep receiving the historical fully-expanded
  `SessionSync` shape.
- **Current default and planned end state.** On by default. It is negotiated, so
  it degrades safely against older peers. The end state is to retire the
  negotiation and the expanded form once every peer in the fleet speaks the
  compact form.
- **Status on 2026-07-08.** Implemented and on by default.
- **Path to removal.** Confirm no peer still needs the expanded payload, then
  delete the negotiation and the expanded-form encoder and always send the
  compact form.

### `serverPrimaryExecutionClaimRank`

- **Toggle via.**
  `setServerPrimaryExecutionClaimRankConfig("space" | "user" | "session" | "cross-space-read")`
  in [`packages/memory/v2.ts`](../../packages/memory/v2.ts). Host-internal and
  owner-invisible: it is never negotiated on the wire and has no environment
  variable; C1/C2/C3 flip it programmatically inside their gate fixtures.
- **Added by.** Bernhard Seefeld, in server-side execution C1.1b (the
  context-lattice rank dial, 2026-07-16); the `session` stage landed with
  C2.1 (2026-07-17), the `cross-space-read` stage with C3.6 (2026-07-18).
- **Purpose.** The issuance-side rank dial from the
  [context-lattice design §6](../specs/server-side-execution/context-lattice-execution.md):
  the highest context rank the host ISSUES execution claims for, staged
  space → user → session → cross-space as each rank's lane machinery lands.
  The value is a ladder, not a set — the `session` stage admits user-rank
  claims too. Enforced at claim issuance
  (`#assertExecutionClaimCapabilityEnabled`) and at
  renewal — disabling a rank revokes its live claims at their next renewal,
  mirroring the `serverPrimaryExecution` flag-off revoke. The engine's
  commit-time claim guards are deliberately rank-independent: an un-enabled
  rank behaves exactly like Phase 2's unclaimed fallback, because fail-open
  clients never classify anything against a claim that was never issued.
  Scoped-rank claims (user and session alike) admit `computation` AND
  `effect` since C2.8 (2026-07-18) lifted amendment 8's computation-only
  conjunct for lane-grant builtin egress; effect claims additionally
  require `serverPrimaryExecutionBuiltinPassivityV1` at every rank, and a
  scoped effect claim still needs a live lane grant — with zero connected
  sessions no grant exists and no scoped claim issues (offline egress
  stays with the delegation design, context-lattice OQ1).
- **Current default and planned end state.** **`cross-space-read` by default
  since 2026-08-01** — the top of the ladder, so the host issues space, user
  and session claims and admits foreign space-scoped reads — with the rest of
  the dial set (see the ruling box at the top of this document). This is the
  memory-side half of the pairing: the runner's `*RankCandidates` dials decide
  what a client PROPOSES, this decides what the host will ISSUE, and a set
  where only one side moved is a client proposing ranks the host refuses. Note
  that it is host-internal with no environment variable, deliberately: the
  rollback for the whole configuration is `serverPrimaryExecution`, which
  gates issuance at every rank regardless of this stage. Lower stages remain
  reachable programmatically and the C1/C2/C3 gate fixtures use them; that is
  a testing-only affordance and nothing ships in one. `space` is
  byte-identical to pre-C1 space-only behavior. The CA4 ordering invariant — the session
  stage must never be enabled outside a fixture while C2.1 has landed but
  C2.6's named-session delivery narrowing has not, because the pre-C2.6
  principal-wide session-claim broadcast made sibling-session claim churn a
  quadratic spurious-rerun source — is **lifted: C2.6 landed 2026-07-17**
  (session-context control events route only to the named session), so the
  session stage may now be enabled wherever the plan's rollout sequencing
  allows. The `cross-space-read` stage is the FOURTH ladder entry (C3.6,
  2026-07-18) — NOT a fourth context rank (foreign-read admission is
  orthogonal to the space/user/session chain: a claim of any rank may read
  foreign spaces), but a ladder placement that IMPLIES session rank, so a
  host at `cross-space-read` also issues session/user/space claims. It gates
  the foreign-read CAPABILITY (`serverPrimaryExecutionCrossSpaceReadsEnabled`,
  consulted by the C3.6 issuance preflight). The CA4/C3A17 ordering invariant
  — never at this stage without the `cross-space-claims-v1` cohort gate
  (C3.6b) — used to be honoured by withholding the stage; since 2026-08-01 it
  is honoured by construction, because the cohort gate defaults on beside it.
  The end state, every rank enabled, is now the default.
- **Status on 2026-07-18.** Implemented through the session stage, which is
  complete end-to-end (plan C2 status, 2026-07-18): C2.1 landed the ladder
  + canonical `session:<did>:<sessionId>` wire validation per CA12; C2.3
  the session lane grants (session-anchored, session-end = lane-end, no
  re-anchor); C2.6 the named-session delivery narrowing at the single
  `#sessionAcceptsClaim` predicate; C2.7 the session-lane demand
  derivation and pool lifecycle that make session-stage issuance live;
  and C2.8 the scoped-rank effect admission noted above. The C2
  acceptance gates flip this dial's `session` stage and run by default
  (plan rows C2.9/C2.10).
- **Path to removal.** Graduate each rank behind the dial as its C-phase gate
  is accepted (C1.7 folded the user step behind the
  `context-lattice-claims-v1` subcapability), then fold the fully graduated
  dial into `serverPrimaryExecution` and delete the config functions.

### `serverPrimaryExecutionContextLatticeClaimsV1`

- **Toggle via.** `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS`
  (`"true"`/`"false"`; unset = default), or
  `setServerPrimaryExecutionContextLatticeClaimsConfig()` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts). The capability is
  negotiated per connection: both peers must advertise the absent-false wire
  flag, and the connection getter chain layers it above
  `serverPrimaryExecutionClaimRoutingV1` — so the env var is read on BOTH
  halves of the handshake, from the one canonical spelling
  (`SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS_ENV`):
  - **server:** `applyServerPrimaryExecutionEnvConfig` at construction
    (toolshed's storage route, the standalone server), which decides what
    `hello.ok` advertises;
  - **client:** the `serverPrimaryExecutionContextLatticeClaims`
    `ExperimentalOptions` flag → `experimentalOptionsFromEnv` (Deno hosts) or
    the shell's build-time define → the `Runtime` constructor, which installs
    the realm's ambient dial so this client's own `hello` offers it.

  Unlike the host-internal `serverPrimaryExecutionClaimRank` dial it partners
  with (still programmatic-only, as are the runner's rank CANDIDATE dials),
  this one is env-wired because the amendment-11 cohort gate below requires
  EVERY session of a principal to have negotiated: a browser client with no
  path to the dial makes user lanes structurally un-openable, and every
  server-side rank dial beneath them inert. That was the CA4 audit's binding
  blocker (client-passivity §5g item 5) and is gated end-to-end by
  `packages/patterns/integration/server-execution-context-lattice-env-bridge-gate.test.ts`,
  the C1.7 sibling of the F5 env-bridge gate.
- **Added by.** Bernhard Seefeld, in server-side execution C1.7
  (context-scoped delivery, 2026-07-16).
- **Purpose.** The context-lattice claim-delivery subcapability
  ([design §5](../specs/server-side-execution/context-lattice-execution.md),
  adversarial-review amendments 11/17/21): a session that negotiated it may
  receive context-scoped (`user:`/`session:`) execution claims, filtered by
  the single delivery predicate (`#sessionAcceptsClaim`) — user-context
  events to the claim principal's negotiating sessions and, since C2.6
  (2026-07-17), session-context events to the exact session their
  contextKey names — live publishes, reconnect snapshots, retained
  events, and settlement frontiers alike. Sessions without it receive space
  claims exactly as before. The subcapability also drives the amendment-11
  principal-wide cohort gate: a user lane may only open (and stay open) while
  EVERY session of the lane principal — TTL-detached ones included — has
  negotiated it, and any non-negotiating attach synchronously fences the
  principal's live user lanes before its open response is sent. Session
  lanes deliberately gate per-session instead (C2.3): a session claim only
  suppresses its named session under own-chain acceptance, and a
  non-negotiating attach of the same session id is fenced in openSession
  admission before its response releases. Deliberately
  NOT part of the required-capability check at session admission: a mixed
  fleet is valid, with the fence (not rejection) protecting lane integrity.
  User-rank claim ISSUANCE additionally requires the host's own advertisement
  (amendment 9's fold), so a host with this off issues space claims only,
  whatever the rank dial says.
- **Current default and planned end state.** **On by default since
  2026-08-01**, with the rest of the dial set (see the ruling box at the top
  of this document): advertised in every handshake, so context-scoped claim
  delivery is available and the amendment-11 cohort gate can admit user lanes
  — which is the point, since the rank dials beneath it are inert without it.
  Turned OFF it is absent from the handshake, with zero delivery-path change
  and no lane fencing; the C1/C2 gate fixtures pin it in both directions
  alongside the matching `serverPrimaryExecutionClaimRank` stage. The end
  state — every supported client negotiating it — is now the default; a mixed
  fleet remains valid, because the cohort gate fences non-negotiating sessions
  rather than rejecting them.
- **Status on 2026-07-18.** Implemented (C1.7): wire flag, connection getter
  chain, per-attach session capability, context-scoped
  `#sessionAcceptsClaim`, `sessionsForPrincipal` (the amendment-17
  connected-or-TTL-detached seam the F6 feed fan-out consumes, landed
  2026-07-17), the cohort gate at lane open/renew, and the admission
  fence. C2.3 added the per-session negotiation gate for session lanes
  and C2.6 the named-session branch of the delivery predicate.
- **Path to removal.** Graduate with the C1/C2 lane rollout: once every
  supported client negotiates it, require it whenever
  `serverPrimaryExecution` is on (fold into the required-capability set),
  delete the config function, and retire the per-connection negotiation with
  an R7-style retirement for stragglers.

### `serverPrimaryExecutionCrossSpaceClaimsV1`

- **Toggle via.** `setServerPrimaryExecutionCrossSpaceClaimsConfig()` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts) — programmatic-only,
  like the context-lattice subcapability it mirrors; no environment variable.
  The resulting capability IS negotiated per connection: both peers advertise
  the absent-false wire flag, and the connection getter chain layers it above
  `serverPrimaryExecutionClaimRoutingV1` (a connection that cannot route space
  claims can never route cross-space ones).
- **Added by.** Bernhard Seefeld, in server-side execution C3.6b
  (cross-space-read claim delivery cohort gate, 2026-07-18).
- **Purpose.** The cross-space-read claim-delivery subcapability
  ([design §6](../specs/server-side-execution/context-lattice-execution.md),
  adversarial-review amendment C3A18): a session that negotiated it may
  RECEIVE an execution claim whose action reads foreign spaces (a claim with a
  non-empty `crossSpaceReadSpaces`), narrowed by the same single delivery
  predicate (`#sessionAcceptsClaim`) as the context-lattice subcapability.
  Sessions without it never receive a cross-space-read claim — they would run
  the foreign-reading action client-primary, so delivering it would risk
  double execution. The subcapability drives an amendment-11 attach fence
  keyed by the claim's OWN contextKey rank (C3A18): a non-negotiating attach
  revokes the live cross-space-read claims of every cohort it joins — a
  session-lane claim of its session id, a user-lane claim of its principal, or
  (when it negotiates routing) any space-lane claim of the space — before its
  open response releases. The ISSUANCE preflight enforces the same cohort
  uniformly (the mixed-version race prevention): a cross-space-read claim is
  refused (soft decline) unless the whole delivery cohort negotiates it.
  Deliberately NOT part of the required-capability check: a mixed fleet is
  valid, with the fence + issuance gate (not rejection) protecting against
  double execution.
- **Current default and planned end state.** **On by default since
  2026-08-01**, with the rest of the dial set (see the ruling box at the top
  of this document) — necessarily so, because the claim-rank dial defaults to
  the `cross-space-read` stage and the issuance preflight refuses unless both
  hold. Turned OFF it is absent from the handshake, with zero delivery-path
  change and no cross-space-read claims to fence; the C3 gate fixtures pin it
  in both directions alongside the matching claim-rank stage. The end state —
  every supported client negotiating it — is now the default; a mixed fleet
  remains valid, protected by the attach fence and the issuance cohort gate
  rather than by rejection.
- **Status on 2026-07-18.** Implemented (C3.6b): wire flag, connection getter
  chain, per-attach session capability, the cross-space-read narrowing on
  `#sessionAcceptsClaim` (live publishes, revokes carrying the marker,
  reconnect snapshots, and settlement frontiers alike), the issuance cohort
  gate, and the amendment-11 attach fence.
- **Path to removal.** Graduate with the C3 cross-space rollout: once every
  supported client negotiates it, require it whenever `serverPrimaryExecution`
  is on, delete the config function, and retire the per-connection negotiation
  with an R7-style retirement for stragglers.

> Five neighbours in the same handshake are related but are not runtime-toggleable
> experimental flags:
>
> - **`serverPrimaryExecutionClaimRoutingV1`** is an absent-false client promise
>   that computation claim routing is implemented. It advertises with
>   `serverPrimaryExecution`; the server publishes computation claims only to
>   peers that advertise it.
> - **`serverPrimaryExecutionBuiltinPassivityV1`** is the corresponding
>   absent-false promise for claimed async builtins. It also advertises with
>   the main flag; effect claims are not published to peers that omit it.
> - **`syncSchemaTable`** is the older, index-keyed predecessor of
>   `syncSchemaTableV2`. It is hardwired to `false` in `getMemoryProtocolFlags`
>   and has no config function; it is effectively dead and can be deleted from
>   the protocol types once no peer negotiates it.
> - **`sqliteCommitRowLabelEval`** is a build-inherent capability, hardwired to
>   `true`, advertising that this build's engine evaluates row-label rules at
>   commit time. It is not configuration: an older server that lacks the
>   capability advertises it absent (parsed as `false`), and a newer runner then
>   keeps its write gate failing closed. It was added by Bernhard Seefeld in
>   "server-side commit-time row-label re-derivation (Epic E4, Phase 3.c)"
>   (#4552). It is permanent.
> - **`schedulerWriterLookup`** is a build-inherent capability, hardwired to
>   `true`, advertising authenticated target/path-overlap lookup over durable
>   scheduler write indexes. It is not configuration: an older server that
>   lacks the capability advertises it absent (parsed as `false`), and a newer
>   runner fails open to piece-root discovery without sending the unsupported
>   request. It was added by Bernhard Seefeld for server-side execution W0.3.
> - **`pendingReadStacks`** is a build-inherent capability, hardwired to `true`,
>   advertising that this build's engine resolves array-`localSeq` pending reads
>   (the full-stack dependency sets of CT-1872 1c; `resolvePendingReads` in
>   [`packages/memory/v2/engine.ts`](../../packages/memory/v2/engine.ts)). It is
>   not configuration: against a server that advertises it absent, the client
>   scalarizes each dependency array to its top-of-stack element before sending
>   (`scalarizePendingReadStacks` in
>   [`packages/runner/src/storage/v2.ts`](../../packages/runner/src/storage/v2.ts)),
>   and HOLDS the send until every omitted lower dependency has settled — a
>   dropped one dooms the commit locally before it reaches the wire; once all
>   are accepted the scalar shape is sound. (Sending while an omitted
>   dependency is unsettled would let the old server durably accept a commit
>   the client cascade-rejects — a split-brain where the caller sees a
>   conflict for a write that landed.) Scheduler observations degrade instead
>   of holding: a multi-layer observation is dropped client-side (flag-off
>   semantics), so the flush that semantic commits await never waits on
>   verdicts. Added on CT-1872 (PR #4606). Path to removal: retire
>   the scalarization fallback once every server in the fleet advertises the
>   capability; the flag itself then reads as permanent documentation of the
>   wire shape. (The CT-1910 basis repair — `basisSeq` on pending reads,
>   scanned with own-session exclusion — landed WITHOUT a capability of its
>   own: servers ignore unknown read fields, so clients attach it
>   unconditionally and older servers keep the legacy max-dependency basis.
>   CT-1910's remaining scope, server-inferred dependencies, stays a
>   follow-on protocol step.)
> - **`entityIdListing`** is a build-inherent capability, hardwired to `true`.
>   It advertises that the memory server can list live space-scoped entity
>   identifiers without returning stored values. Older servers omit it, which
>   parses as `false`. It is permanent.
> - **`entityIdPagination`** is a build-inherent capability, hardwired to
>   `true`. It advertises snapshot-checked, server-capped pages for
>   `entity-id.list`. Older servers return the historical complete response.
>   It is permanent.
> - **`entityIdLookup`** is a build-inherent capability, hardwired to `true`.
>   It advertises identifier-only `entity-id.exists` point lookup. Older
>   servers omit it, which parses as `false`. It is permanent.

### `experimentalConcurrentWatchRefresh`

- **Toggle via.** `experimentalConcurrentWatchRefresh` on
  `IRemoteStorageProviderSettings`
  ([`packages/runner/src/storage/interface.ts`](../../packages/runner/src/storage/interface.ts)),
  passed through `StorageManager` settings. The runner mirrors it onto each
  memory session via `SpaceSession.setConcurrentWatchRefresh()`
  ([`packages/memory/v2/client.ts`](../../packages/memory/v2/client.ts)) —
  per-session, not a process global. In the **shell** it is a per-browser-profile
  dogfood toggle: run `commonfabric.concurrentWatchRefresh(true)` in the console
  and reload. The flag crosses the worker IPC in `InitializationData` and is
  fixed at `StorageManager.open` time, so — like the render ceiling — it takes
  effect on the next runtime (reload), not live. Threaded shell → worker via
  `runtimeHostFlags()`
  ([`packages/shell/src/lib/host-toggles.ts`](../../packages/shell/src/lib/host-toggles.ts))
  → `RuntimeInternals.create` → `runtime-processor.ts`'s storage settings.
- **Added by.** Ben Follington (#4937; shell dogfood toggle #4974).
- **Purpose.** By default watch acquisition is strict single-flight per space: a
  guard holds every watch refresh after the first until the prior response
  lands, so traversal-driven pulls discovered a tick apart serialize into
  one-round-trip-each frames even when nothing depends on the prior response. On
  a high-RTT link this dominates cold-load wall-clock. With the flag on,
  refreshes overlap up to a bounded window (`CONCURRENT_WATCH_REFRESH_WINDOW`,
  currently 8) in `storage/v2.ts`, and the memory client issues the whole
  watch-mutation family (`watch.set` + `watch.add`) in an ordered issue phase so
  wire order is preserved and application stays ordered. Same-tick microtask
  coalescing is unchanged.
- **Current default and planned end state.** Off by default. It is a spike
  pending live measurement on a real (estuary-latency) load; the window size is
  a tuning value. End state is either graduation to always-on with a settled
  window, or removal if the render-side fix (initial-render descent) makes the
  waterfall shallow enough that concurrency no longer pays.
- **Status on 2026-07-24.** Implemented behind the flag, off by default; not yet
  measured end-to-end over real latency.
- **Path to removal.** Graduate to always-on once measured safe and beneficial,
  or remove if superseded by reducing the round-trip count at the source.

---

## Category 4: Shell dogfood toggles

### `cfcRenderCeiling`

- **Toggle via.** The browser console command
  `commonfabric.cfcRenderCeiling(enabled?)`, backed by the `cfcRenderCeiling`
  key in `localStorage`. It is per browser profile. See
  [`packages/shell/src/lib/render-ceiling.ts`](../../packages/shell/src/lib/render-ceiling.ts).
  Because the ceiling crosses the worker boundary in the fixed initialization
  data, flipping it takes effect on the next runtime (a reload or re-login),
  not live.
- **Added by.** Bernhard Seefeld, in "populate the render confidentiality ceiling
  behind a shell dogfood flag (Epic H3a)" (#4550, 2026-07-07).
- **Purpose.** Populates the CFC render confidentiality ceiling in the shell's
  runtime. When on, display sinks admit only the acting user's own identity atom
  plus allow-listed influence-class caveat kinds; everything else fails closed
  and renders as a blocked placeholder, and author-supplied render-boundary
  declassification is denied.
- **Current default and planned end state.** Off by default. It changes what the
  shell renders and is expected to over-block until exchange resolution (a later
  CFC stage, Epic H3b) lands, so it is enabled deliberately per browser profile
  for dogfooding. The end state is to graduate the ceiling on once exchange
  resolution makes the blocking precise.
- **Status on 2026-07-08.** Implemented, off by default, dogfood only.
- **Path to removal.** Land exchange resolution so the ceiling stops
  over-blocking, turn it on by default, and then remove the localStorage toggle
  and make the ceiling unconditional.

## Category 5: Fuse mount cache tuning

### `fuseNfsCacheTuning`

- **Toggle via.** `cf fuse mount --attrcache-timeout <seconds>` or
  `cf fuse mount --noattrcache` (mutually exclusive). Both plumb through the
  background supervisor and the compiled binary's hidden
  `fuse-daemon`/`fuse-supervisor` subcommands to `-o attrcache-timeout=<n>` /
  `-o noattrcache` in the args handed to FUSE-T's `fuse_mount`
  ([`packages/fuse/mount-options.ts`](../../packages/fuse/mount-options.ts),
  `buildMountFuseArgs`). The options are applied only when the loaded
  provider is FUSE-T; Linux and macFUSE mounts accept and ignore the flags,
  matching `--allow-other`'s Linux-only handling in reverse.
- **Added by.** Ian Hickson (noattrcache evaluation following #4642/#4654).
- **Purpose.** FUSE-T serves mounts through the macOS NFS client and ignores
  the entry/attribute timeouts the filesystem returns, so the client's
  age-based 5-60 second caching defaults apply: a daemon-side `ENOENT` seeds
  a negative name cache entry served without daemon round-trips, and cached
  directory listings are served stale. Measured against a live space on
  FUSE-T 1.2.7 / macOS 26 (2026-07-14, recorded in
  [the evaluation](../history/packages/fuse/noattrcache-mount-option-evaluation.md)):
  untuned mounts showed stale-`NotFound` windows of 3.2-56.3 s and listing
  staleness of 0.8-53.4 s, while `attrcache-timeout=1` bounded both below
  half a second at no measurable stat cost (about 2 microseconds per stat,
  cache-served) and with zero read errors through sustained rebuild storms.
  `noattrcache` on FUSE-T 1.2.x maps to the NFS `nonegnamecache` flag only;
  it left 7.5-29 s windows and is kept as a diagnostic dial.
- **Current default and planned end state.** The flag value is a whole
  number of seconds. When neither flag is given, cf itself adds
  `-o attrcache-timeout=1` (one second) to every FUSE-T mount — the default
  lives in cf's `buildMountFuseArgs`, not in FUSE-T, whose own default is
  the untuned NFS client caching. `--attrcache-timeout 0` turns cf's
  addition off and leaves that untuned caching in place. Separately, the
  `cf exec` listing-recheck delay in
  [`packages/cli/lib/exec.ts`](../../packages/cli/lib/exec.ts)
  (`DIR_LISTING_RECHECK_DELAY_MS`, 3.5 seconds) remains as the backstop for
  untuned, macFUSE, and pre-1.0.29 FUSE-T mounts. That delay is sized for
  the untuned client's multi-second listing staleness; once field use
  confirms most mounts run with the one-second cache bound, the delay can
  be reduced to just over one second to match.
- **Status on 2026-07-14.** Implemented, on by default for FUSE-T mounts.
  Validated by a 5-minute live-space soak (1296 daemon-side writes, ~2790
  reads per probe target, p99 read latency 4 ms, worst transient 110 ms,
  zero stale-negative false positives, daemon CPU ≤3%, no livelock).
- **Path to removal.** Fold the default into permanent documented behavior
  and shrink the exec.ts recheck delay, or retire the NFS dial entirely if
  FUSE-T's FSKit backend (macOS 26+) replaces the NFS backend.

---

## How flags propagate

The environment-backed flags (`EXPERIMENTAL_MODERN_CELL_REP`,
`EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE`,
`EXPERIMENTAL_SERVER_PRIMARY_EXECUTION`,
`EXPERIMENTAL_EAGER_SOURCE_ANNOTATION`,
`EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE`) reach the runtime through the
deployed processes. The runtime-only flags (`commitPreconditions`, the CFC
dials) reach it only through the `RuntimeOptions` passed to `new Runtime(...)`.

All first-party processes build their `RuntimeOptions` through a construction
preset in
[`packages/runner/src/runtime-presets.ts`](../../packages/runner/src/runtime-presets.ts),
and the environment-backed flags reach the runtime through the one canonical
mapping, `experimentalOptionsFromEnv`, in that same file. That mapping accepts
exactly `"true"` and `"false"`: an unset variable stays `undefined`, which the
runtime reads as "use the built-in default", and any other value is ignored with
a warning. (The distinction between unset and an explicit `false` matters,
because an explicit value overrides a built-in default that happens to be on.)

### Server-side (Deno processes)

```
Server Process (Deno)
  |
  +-- ENV: EXPERIMENTAL_* = "true" | "false"
  |
  +-- runner/runtime-presets.ts  --> experimentalOptionsFromEnv(Deno.env.get)
  +-- toolshed/runtime-options.ts --> runtimePresets.productionServer({ experimental, ... })
  +-- toolshed/index.ts           --> new Runtime(toolshedRuntimeOptions(...))
```

The CLI uses the same mapping and the same presets, so both server-side
wirings agree on how a value parses.

### Browser-side (build-time injection)

Browser-side flags are injected at build time and carried to the web worker that
hosts the runtime.

```
Build Time (shell)
  |
  +-- ENV: EXPERIMENTAL_* = <value>
  +-- felt.config.ts   --> esbuild define: $EXPERIMENTAL_*
  +-- src/lib/env.ts   --> EXPERIMENTAL.<flag> = <value>
  |
Browser (main thread)
  +-- shell/runtime.ts --> reads EXPERIMENTAL from env.ts
  +-- RuntimeClient.initialize(transport, { ..., experimental: EXPERIMENTAL })
        |  postMessage (IPC), InitializationData carries experimental + CFC dials
        v
Browser web worker
  +-- runtime-client/backends/runtime-processor.ts
        --> new Runtime(runtimePresets.browserWorker({ experimental, cfcEnforcementMode, cfcFlowLabels, ... }))
```

Because the shell bakes the flags into the bundle at build time, changing a
browser-side flag requires rebuilding the shell. Server-side flags take effect
on restart without a rebuild. The browser is also the one place a CFC dial is
host-controlled at construction: the `browserWorker` preset takes
`cfcEnforcementMode` and `cfcFlowLabels` from the shell's initialization data.

## Enabling flags locally

Set the environment variables before building the shell (for browser-side flags)
and before starting the server (for server-side flags):

```bash
# One flag, build and run.
EXPERIMENTAL_EXAMPLE_NAME=true deno task dev

# Several flags.
EXPERIMENTAL_EXAMPLE_NAME_1=true \
EXPERIMENTAL_EXAMPLE_NAME_2=true \
deno task dev
```

Use exactly `true` or `false`. Values like `1`, `yes`, or `TRUE` used to be
coerced (and, before the mapping was unified, in opposite directions in
different processes); they are now ignored with a warning, leaving the built-in
default in place.

For the runtime-only flags and the CFC dials there is no environment variable;
enable them by constructing the `Runtime` with the option set (which is how the
tests exercise them). To advance a CFC dial for every first-party process at
once, change its value in `coreOptions` in
[`packages/runner/src/runtime-presets.ts`](../../packages/runner/src/runtime-presets.ts).
For the enforcement mode in the interactive tools, use `CF_CFC_MODE`.

## Verifying flags are working

When any experimental flag is explicitly overridden, the `Runtime` constructor
logs it on startup, for example:

```
Experimental flag overrides: modernCellRep=true
```

- Server-side: look in the toolshed log.
- Browser-side: look in the browser developer console (the message comes from the
  web worker that hosts the runtime). You can also inspect the `EXPERIMENTAL`
  export from `packages/shell/src/lib/env.ts` in the console to see the baked-in
  values.

The dedicated plumbing test checks that constructing and disposing a `Runtime`
sets and unwinds the ambient flag state correctly — including the two cases the
inherit rule turns on: a flag the Runtime never names survives the whole
lifecycle untouched, and a flag it does name is restored to the value it
displaced rather than to the compiled default:

```bash
cd packages/runner
deno test --allow-ffi --allow-env --allow-read test/experimental-options.test.ts
```

A second test, `packages/runner/test/runtime-presets.test.ts`, is a conformance
golden: it pins the full `RuntimeOptions` each preset produces, including the
`coreOptions` CFC pins, and the exact value each environment variable parses to
through `experimentalOptionsFromEnv`. Any change to the fleet-wide posture or the
env mapping shows up as a diff in that one file.

Both tests pass as of 2026-07-11. They exercise the flag plumbing and the
per-preset posture, not the full behavior of every feature under every flag
combination; the per-feature test matrices live with each feature's specs (for
example under [`docs/specs/scheduler-v2/`](../specs/scheduler-v2/) and the CFC
design docs).

## Implementation details

The Category 1 flags are declared as the `ExperimentalOptions` interface in
[`packages/runner/src/runtime.ts`](../../packages/runner/src/runtime.ts). The
`Runtime` constructor merges the provided flags with the built-in defaults
(`persistentSchedulerState` and `commitPreconditions` true; the other Category
1 flags false),
propagates the ones the caller NAMED to their ambient control points, and then
reads the effective state back so that `runtime.experimental.*` reflects what is
actually in effect. An omitted flag is left alone, and every write is unwound to
the value it displaced on `dispose()` (`AMBIENT_EXPERIMENTAL_DIALS`).

First-party construction config is centralized in
[`packages/runner/src/runtime-presets.ts`](../../packages/runner/src/runtime-presets.ts),
which is the place to touch when adding or changing a flag that construction
config reaches:

- `EXPERIMENTAL_ENV_VARS` is the single environment-variable mapping for
  `ExperimentalOptions`, typed as `Record<keyof ExperimentalOptions, string |
  null>`, so every flag must be listed there (a real env var name, or `null` for
  "programmatic-only"). `experimentalOptionsFromEnv` reads it.
- `RUNTIME_OPTION_KEYS` is an exhaustive, compile-checked registry of every
  `RuntimeOptions` key (including the CFC dials). Adding a new option to
  `RuntimeOptions` without registering it there is a compile error, which forces
  a decision about how each preset treats it.
- `coreOptions` holds the shared first-party posture (today, the CFC pins) that
  every preset composes.

- Only one set of experimental flags is active per JavaScript context at a time.
- In the browser the web worker is a separate JavaScript context, so its flags
  are independent of the main thread.
- Creating a new `Runtime` overwrites the ambient config; disposing it resets to
  the defaults.

---

## Appendix A: Removed and never-shipped flags

These are recorded so that references to them elsewhere in the tree do not send a
future reader hunting for a flag that no longer exists.

### `systemPatternAutoUpdateHome` / `EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE_HOME` (removed)

The second gate that held the **home** root (home.tsx) out of
[`systemPatternAutoUpdate`](#systempatternautoupdate) while the
stable-addressing question was open: the home root carries real user data
(favorites, journal, the spaces list), and an in-place roll had to be proven
state-preserving first. `home-golden-replay.test.ts` pins exactly that (seed
representative home data, roll N→N+1 in place, prove every list survives), and
the 2026-07-21 estuary incident — a runtime migration bricking every
old-generation home root with no self-repair path because this flag was off —
made the cost of the extra gate concrete. Removed at the flag owner's direction;
home roots now ride `systemPatternAutoUpdate` like every other tracked system
root.

### `schedulerHistoricalMightWrite` (removed)

An `ExperimentalOptions` flag that preserved the scheduler's cumulative
"historical might-write" tracking for dependency scheduling, instead of the
current-known write set. It was confirmed deletable on 2026-06-11 and has been
removed from the code; under scheduler-v2's static write surface the writer map
is fixed at registration, so the discovered write history is obsolete. Several
scheduler-v2 spec documents still mention it as part of their migration history.

### `esmModuleLoader` / `CF_ESM_MODULE_LOADER` (removed)

The flag that selected the ESM module-record loader during the
content-addressed module-loading rollout. (An early draft of the plan called it
`EXPERIMENTAL_ESM_MODULE_LOADER`.) It was defaulted on, and then the flag and
the whole-bundle loader and cache it switched away from were all removed; the
ESM module-record loader is now the only loader. See
[`docs/history/specs/module-loading-implementation-plan.md`](../history/specs/module-loading-implementation-plan.md),
whose status header records the removal.

### `EXPERIMENTAL_MODERN_DATA_MODEL` (never implemented)

Mentioned only in
[`docs/history/specs/persistent-scheduler-state/implementation_notes.md`](../history/specs/persistent-scheduler-state/implementation_notes.md)
as an example of how to plumb a flag through the runtime, shell, toolshed, and
CLI. It was never built; the persistent-scheduler-state flag was built instead,
following the same plumbing pattern.

---

## Appendix B: Related toggles that are not experimental flags

The sweep that produced this registry also turned up toggles that look like flags
but gate operational, debugging, build, or test behavior rather than the rollout
of an in-progress feature. They are intentionally out of scope here; the general
configuration reference is
[`docs/development/CONFIGURATION.md`](./CONFIGURATION.md). Recorded so a future
sweep does not mistake them for missing experimental flags:

- **`CF_CFC_MODE`** — sets `cfcEnforcementMode` in the cf-harness and the fuse
  mount. It is the way to drive the enforcement dial in those tools, not a
  separate flag.
- **Shell debugging and preference toggles** (localStorage): `forwardWorkerConsole`
  (forward the web worker's console to the main thread), `telemetryEnabled`
  (browser OpenTelemetry), `showDebuggerView`, `themePreference`.
- **Runner diagnostics** (environment): `CF_TRAVERSE_CAPTURE`,
  `CF_TRAVERSE_CAPTURE_MAX`, `CF_TRAVERSE_DIAGNOSTICS`.
- **CLI controls** (environment): `CF_EXEC_SHEBANG`, `CF_CLI_TRACE_TIMINGS`,
  `CF_PROFILE_DONE_MARKER`.
- **Operational and build toggles**: `MEMORY_ACL_MODE` (`off` / `observe` /
  `enforce` space-access policy), `MEMORY_DUMP_ENABLED` (state-inspector dump
  endpoint), `OTEL_ENABLED`, `PRODUCTION` (shell build mode). ACL mode is a
  permanent deployment policy ladder, not an experimental runtime feature.
- **Test controls**: `TEST_LLM`, `TEST_HTTP`, and the integration-test
  environment variables (`HEADLESS`, `PIPE_CONSOLE`, `CFC_BROWSER_PROFILE_COUNT`,
  `CF_WAITFOR_DELAY_MS`).
