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

**Last reviewed:** 2026-07-23. Each flag's section carries the date its status
was last checked against the code.

## Summary table

| Flag | Toggle via | Default today | Originally added by | Planned end state | Status |
|------|-----------|---------------|---------------------|-------------------|---------------------|
| [`modernCellRep`](#moderncellrep) | `EXPERIMENTAL_MODERN_CELL_REP` env, or `RuntimeOptions.experimental` | off | Dan Bornstein (#3818) | graduate to always-on, then delete flag | implemented, off by default |
| [`persistentSchedulerState`](#persistentschedulerstate) | `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` env, or `RuntimeOptions.experimental` | off | Bernhard Seefeld (#3646) | SUPERSEDED — no longer graduating to always-on: the persisted form is replaced by the v2 basis index and the flag deletes with it ([`serving-loop.md`](../specs/server-side-execution/serving-loop.md) §3b; plan Phase 1 stage C) | implemented, off by default; graduation stopped pending that replacement |
| [`commitPreconditions`](#commitpreconditions) | `RuntimeOptions.experimental` only (mapped `null` — programmatic rollback override — in the canonical env registry) | on | Bernhard Seefeld (#4090) | fold into base scheduler semantics, then delete flag | implemented, on by default |
| [`plainResultReceipts`](#plainresultreceipts) | `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS` env, or `RuntimeOptions.experimental` | on | Mike Salisbury (verb contract WS-C) | fold into receipt semantics and delete flag after a bake period | implemented, on by default |
| [`eagerSourceAnnotation`](#eagersourceannotation) | `EXPERIMENTAL_EAGER_SOURCE_ANNOTATION` env, or `RuntimeOptions.experimental` | off in production, on in shell dev builds | gideon (#4458) | permanent debug toggle, not slated for removal | implemented |
| [`systemPatternAutoUpdate`](#systempatternautoupdate) | `EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE` env / shell build define, or `RuntimeOptions.experimental` | on in the shell (same-toolshed system sources, including all roots); off server-side | Bernhard Seefeld (#4611; shell default-on #4619) | graduate to always-on, then delete flag | implemented, on in the shell |
| [`computedCellIds`](#computedcellids) | `EXPERIMENTAL_COMPUTED_CELL_IDS` env, or `RuntimeOptions.experimental` | on | Robin McCollum (#4659) | graduate to unconditional behavior, then delete flag | implemented, on by default |
| [`serverExecution`](#serverexecution) | `EXPERIMENTAL_SERVER_EXECUTION` env, or `RuntimeOptions.experimental` | off | Bernhard Seefeld (#5339, server-execution v2 plan Phase 1 stage A) | default ON at the plan's Phase 7 flip, then delete the flag and the OFF path | Phase 1 in progress: stages A (flag, commit `class` metadata, CI arms, `stream-data` disable) and B (`execution_lease` + derived-class admission check) landed, off by default |
| [`cfcEnforcementMode`](#cfcenforcementmode) | `RuntimeOptions.cfcEnforcementMode` (`CF_CFC_MODE` in the cf-harness / fuse) | `enforce-explicit` | Bernhard Seefeld (#3263) | tighten default toward `enforce-strict` | active; ladder is permanent |
| [`cfcFlowLabels`](#cfcflowlabels) | `RuntimeOptions.cfcFlowLabels` | `off` | Bernhard Seefeld (#4011) | move toward `persist` | implemented, staged rollout |
| [`cfcWriteFloor`](#cfcwritefloor) | `RuntimeOptions.cfcWriteFloor` | `off` | Bernhard Seefeld (#4479) | move toward `enforce` | implemented, staged rollout |
| [`cfcTriggerReadGating`](#cfctriggerreadgating) | `RuntimeOptions.cfcTriggerReadGating` | `false` | Bernhard Seefeld (#4488) | move toward `true` | implemented, staged rollout |
| [`cfcPolicyEvaluation`](#cfcpolicyevaluation) | `RuntimeOptions.cfcPolicyEvaluation` | `off` | Bernhard Seefeld (#4566) | move toward `enforce` | implemented, staged rollout |
| [`cfcDeclaredMonotonicity`](#cfcdeclaredmonotonicity) | `RuntimeOptions.cfcDeclaredMonotonicity` | `off` | Bernhard Seefeld (#4647) | `observe` first, then `enforce` (must soak before the §8.12.7 route 2b event ships) | implemented, off by default |
| [`cfcPrefixProvenanceStats`](#cfcprefixprovenancestats) | `RuntimeOptions.cfcPrefixProvenanceStats` (per-deployment; not env-wired) | `false` | Bernhard Seefeld (#4623) | stays a measurement opt-in; fold in or remove after Stage 0 | implemented, off by default, measurement only |
| [`cfcLabelMetadataProtection`](#cfclabelmetadataprotection) | `RuntimeOptions.cfcLabelMetadataProtection` | `off` | Bernhard Seefeld (#4638) | `observe` (divergence counting) first, then `enforce` | implemented, staged rollout |
| [`conflictAdmissionMode`](#conflictadmissionmode) | `CF_CONFLICT_ADMISSION` env, or `setConflictAdmissionMode()` | `off` | William Kelly (#4237); `hold` removed CT-1925 (#5110) | keep `preempt` as a tuning dial or remove after re-measurement | implemented, off by default, measured net-negative |
| [`syncSchemaTableV2`](#syncschematablev2) | `setSyncSchemaTableConfig()` (negotiated per connection) | on | Ben Follington (#4292) | retire the negotiation once every peer speaks v2 | implemented, on by default |
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
`undefined`, which means "take the built-in default". `commitPreconditions`,
`plainResultReceipts`, and `computedCellIds` default on; the other flags in
this category default off unless their section says otherwise.

The mapping from environment variable to flag is defined once, canonically, as
`EXPERIMENTAL_ENV_VARS` in
[`packages/runner/src/runtime-presets.ts`](../../packages/runner/src/runtime-presets.ts),
and read by `experimentalOptionsFromEnv(envReader)`. The toolshed, the CLI, and
the background piece service all go through that one mapping, so their wirings
cannot drift; the shell reads the same variables from its build-time defines.
Seven flags are env-reachable (`modernCellRep`, `persistentSchedulerState`,
`eagerSourceAnnotation`, `plainResultReceipts`, `systemPatternAutoUpdate`,
`computedCellIds`, `serverExecution`);
`commitPreconditions` is deliberately mapped to `null` there, which records
"not env-reachable" as a decision rather than an omission.
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
- **Current default and planned end state.** Off by default. The scheduler-v2
  design is persistence-first, so the intended end state is to graduate this to
  always-on. The scheduler-observation protocol is an optional capability rather
  than a data-model contract, so peers with different settings can still share
  memory data; the server's setting controls whether scheduler rows are accepted
  on a connection.
- **Status on 2026-07-08.** Implemented; the durable tables, the rehydration
  primitives, and the memory-protocol capability are wired. Off by default,
  rollout in progress. See
  [`docs/specs/persistent-scheduler-state.md`](../specs/persistent-scheduler-state.md)
  and [`docs/specs/scheduler-v2/`](../specs/scheduler-v2/) for the tracked
  status.
- **Path to removal.** Confirm rehydration falls back cleanly when observations
  are absent or stale; graduate the default to on across the fleet; then fold
  the behavior into the base scheduler and delete the flag.

### `plainResultReceipts`

- **Toggle via.** `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS` env var, or
  `RuntimeOptions.experimental.plainResultReceipts`. The env mapping accepts
  exactly `"true"` and `"false"` (the category's canonical parsing: any other
  value — `1`, `yes`, `TRUE` — is ignored with a warning, leaving the built-in
  default in place), so the opt-out while the flag exists is an explicit
  `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false`.
- **Added by.** Mike Salisbury, verb-contract WS-C
  (`docs/plans/pattern-verb-contract-implementation.md`).
- **Purpose.** A handler's return value containing reactives/cells projects
  into its per-event receipt cell via the result-pattern path, but a **plain
  JSON return is discarded** — the receipt-only branch writes `{}`. Under this
  flag the receipt carries the (already-normalized) return instead, so a
  caller — or a same-id retry that collides on the create-only receipt — can
  read the verb's result back by receipt address. `{}` remains the shape for
  value-less handlers. The value goes through the receipt cell's standard
  write flow (`set` → `diffAndUpdate`), the same conversion any cell write
  gets: plain JSON persists as-is and a live `Cell` handle converts to a
  link — so a one-line setter verb (`action(() => cell.set(...))`, whose
  expression body implicitly returns the cell `set()` hands back for
  chaining) records a link to the mutated cell in its receipt. Receipts
  reflect what was returned. Requires `commitPreconditions` (the receipt
  write itself) to be active, which it is by default.
- **Current default and planned end state.** On by default. The gate the plan's
  governing decision 2 set — the integration suite proving readback end to
  end — was satisfied by the three-topic fixture (#5244): caller-supplied
  event id, a dropped-response retry and a same-id replay with a different
  payload, both reading the ORIGINAL declared result back off the receipt,
  cross-process against an isolated toolshed. An explicit `false` (env or
  programmatic) remains a rollback override while the flag exists. After a
  bake period the behavior folds into base receipt semantics and the flag is
  deleted.
- **Status on 2026-08-03.** Implemented, on by default (default flipped after
  #5244's proof; the receipt write's standard-flow conversion landed
  separately in #5262). Both flag states are pinned in
  `packages/runner/test/scheduler-event-receipts.test.ts` and
  `packages/runner/test/declared-result-e2e.test.ts`; the flag-off cases pass
  `plainResultReceipts: false` explicitly.
- **Path to removal.** Let the default-on behavior soak; then delete the flag
  and make the projection unconditional in `handleJavaScriptHandlerResult`'s
  receipt-only branch, remove the env mapping and the explicit-off tests, and
  update the receipt content note in `docs/specs/scheduler-v2/README.md` §7.6.

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
  (toolshed, CLI, background piece service) leave it off unless the env var is
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

### `serverExecution`

- **Toggle via.** `EXPERIMENTAL_SERVER_EXECUTION` environment variable (through
  the canonical mapping described in the category note above), or
  `RuntimeOptions.experimental.serverExecution`; browser-side via the shell
  build define of the same name
  ([`packages/shell/felt.config.ts`](../../packages/shell/felt.config.ts) /
  [`packages/shell/src/lib/env.ts`](../../packages/shell/src/lib/env.ts)). The
  ambient control point is `setServerExecutionConfig` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts): the runner owns the
  feature, but the per-class commit admission rows are enforced by the memory
  server under the flag, so the value lives beside the memory protocol flags.
  It is not a handshake capability — admission enforcement is server-local and
  nothing about it is negotiated per connection.
- **Added by.** Bernhard Seefeld, in server-execution v2 Phase 1 stage A
  (#5339;
  [`docs/plans/server-execution-v2.md`](../plans/server-execution-v2.md);
  spec:
  [`docs/specs/server-side-execution/`](../specs/server-side-execution/README.md)).
- **Purpose.** The single flag of server-execution v2 — servers do all the
  compute that is stored; clients commit nothing but intent. Exactly two
  states, no shippable intermediates (spec README §3.4); deliberately named
  unlike v1's `SERVER_PRIMARY_EXECUTION` so the archived v1 documents never
  alias it. Both states, defined:
  - **OFF (the default): today's behavior, byte-for-byte.** Every client
    runtime runs and commits derivations exactly as it does today, and every
    client commit is `authored`-class — `derived` is never claimed off the
    flag. The commit `class` metadata is still *written* in this arm (it is
    written in every arm from stage A onward — protocol.md §1), but nothing
    is enforced from it, and `stream-data` behaves as today. Any OFF-arm
    behavioral diff from a v2 stage is a phase-gate failure by itself
    (testing.md §2).
  - **ON: the v2 posture, growing stage by stage.** With stages A and B
    landed this means: the per-class admission rows of protocol.md §2 are
    enforced — the `derived` row is the stage-B lease equality check
    (producer holds the space's live `execution_lease`, liveness judged by
    the memory server's own clock; still no `derived` producer exists until
    the serving loop lands, and the `authored`/`system` rows equal today's
    checks) — and the deferred `stream-data` built-in is disabled with a
    runtime error naming builtins.md §5. Later stages add their surfaces
    under this same flag (serving loop, speculation, events); both halves of
    any coupled behavior move together on it.
- **Current default and planned end state.** Off by default in every process.
  The integration suites run an ON arm in CI from stage A on, with explicit
  per-phase skip lists (testing.md §2). End state: the plan's Phase 7 flips
  the default ON after Phases 1–6 gate green and a soak period, then the flag
  retires and the OFF code path is removed.
- **Status on 2026-08-04.** Phase 1 stages A and B landed: flag plumbing end
  to end, commit `class` metadata written in every arm, the OFF+ON CI arms,
  the `stream-data` disable, and the `execution_lease` table with the
  acquire/renew/expire cycle and the derived-class admission equality check
  (enforced under the flag; the lease sits dark until the serving loop
  consumes it). Off by default; the ON arm changes no observable behavior
  beyond the `stream-data` error yet.
- **Path to removal.** Execute the plan through its phase gates; at the
  Phase 7 flip, retire the flag, remove the OFF path, and close out this
  entry.

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
  `off` and `preempt`. `preempt` assumes the commit will conflict and reverts and
  re-runs it locally without sending.
- **Removed value: `hold`.** A precise mode also existed: wait for the catch-up,
  re-run the server's precondition check locally against the now-current
  confirmed sequence numbers, revert only the genuinely stale commits, and send
  the rest. It was removed CT-1925 (PR #5110 review): `hold` let an
  earlier read-bearing commit sit at the admission gate while a later,
  independent blind commit proceeded straight to `session.transact`, violating
  the increasing-`localSeq` send order `docs/specs/memory-v2/04-protocol.md`
  §3.9 requires per session (reproduced same-session admission order
  `[1, 3, 2]` against the real engine). It was also the reachability story for
  a real soundness hole in CT-1910's own-session exclusion before that landed
  as predecessor-only (soundness-neutral regardless of send order) — so by the
  time of removal `hold` was soundness-neutral but still protocol-violating,
  and every future §3.9-reliant design (e.g. CT-1910 phase-2 inference, which
  leans on FIFO arrival) would otherwise have had to re-discover the hazard. It
  had also never shown a measured win: neutral on lunch-poll (safe but no win,
  because the staleness is only knowable on the server, not locally).
- **Current default and planned end state.** `off` by default. `preempt` was
  measured net-negative on the lunch-poll workload (it pre-empted commits that
  would have succeeded). The code comment warns not to enable it without
  re-measuring on the target workload.
- **Status on 2026-07-31.** Implemented, off by default. It is a tuning dial that
  has not shown a win on the workloads measured so far.
- **Path to removal.** Either it finds a workload where `preempt` pays off and
  graduates into a documented tuning knob, or it is removed once the underlying
  conflict-retry behavior is settled and the experiment is closed.

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

> Two neighbours in the same handshake are related but are not runtime-toggleable
> experimental flags:
>
> - **`sqliteCommitRowLabelEval`** is a build-inherent capability, hardwired to
>   `true`, advertising that this build's engine evaluates row-label rules at
>   commit time. It is not configuration: an older server that lacks the
>   capability advertises it absent (parsed as `false`), and a newer runner then
>   keeps its write gate failing closed. It was added by Bernhard Seefeld in
>   "server-side commit-time row-label re-derivation (Epic E4, Phase 3.c)"
>   (#4552). It is permanent.
> - **`verdictCatchUpMarkers`** is a build-inherent capability, hardwired to
>   `true`, advertising that the server stages a `caughtUpLocalSeq` catch-up
>   obligation for every accept and conflict rejection, delivered on the
>   batched fan-out (CT-1927; `04-protocol.md` §4.11.2). It is not
>   configuration: the CLIENT keys verdict parking on it — an accepted
>   commit's promotion waits for the marker only when the server advertises
>   the capability AND a sync consumer is live; against an older server (or
>   with no watch view) verdicts apply immediately, the historical behavior.
>   Added by Robin McCollum (CT-1927). It is permanent.
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

## Flag-gated tripwires

Some code paths refuse a value they cannot yet handle, by throwing and naming
what is missing, rather than accepting it and doing something plausible but
wrong. The `FabricInstance` checks in the runner's binding walks are the
recurring example: such a value is a container reached by its codec contents
rather than by property name, and a walk that cannot yet descend one would
otherwise hand it back whole, leaving a binding nested inside it silently
unresolved.

These throws are **discovery instruments**. Each one that fires names a site
that owes work before the relevant flag can graduate, which is more useful than
a quiet wrong answer that surfaces later as corrupted data.

**The invariant that makes this safe rather than merely lucky:** anything
introduced that would reach one of these throws is itself gated on an experiment
flag. A default configuration therefore never arrives at one, and any arrival is
something a flag was deliberately turned on to reach.

Two obligations follow, and they are the reason this is recorded here rather
than at any one of the sites:

- **Adding a feature.** If your change would let a value reach one of these
  throws in a default configuration, gate the change on an experiment flag. That
  is what keeps the default path clear and the tripwire honest.
- **Meeting one.** A throw firing under a flag is the instrument working, not a
  defect in it. The answer is to implement the missing handling at the site it
  names — that work *is* the flag's graduation work — rather than to exempt the
  value so the walk stays quiet.

Worked example: with [`modernCellRep`](#moderncellrep) on, a link is a
`FabricLink` and therefore a `FabricInstance`, so ordinary links reach these
checks and throw. That is expected, and the set of sites it lights up is a
useful part of the remaining work for that flag.

---

## How flags propagate

The environment-backed flags (`EXPERIMENTAL_MODERN_CELL_REP`,
`EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE`,
`EXPERIMENTAL_EAGER_SOURCE_ANNOTATION`,
`EXPERIMENTAL_PLAIN_RESULT_RECEIPTS`,
`EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE`,
`EXPERIMENTAL_COMPUTED_CELL_IDS`,
`EXPERIMENTAL_SERVER_EXECUTION`) reach the runtime through the
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

The background piece service and the CLI use the same mapping and the same
presets, so the three server-side wirings agree on how a value parses.

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

### Background piece service

The background piece service reads the same environment variables and builds its
runtimes (the main process and each worker) through the `productionServer`
preset, so set the same `EXPERIMENTAL_*` variables when starting it.

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
sets and resets the ambient flag state correctly:

```bash
cd packages/runner
deno test --allow-ffi --allow-env --allow-read test/experimental-options.test.ts
```

A second test, `packages/runner/test/runtime-presets.test.ts`, is a conformance
golden: it pins the full `RuntimeOptions` each preset produces, including the
`coreOptions` CFC pins, and the exact value each environment variable parses to
through `experimentalOptionsFromEnv`. Any change to the fleet-wide posture or the
env mapping shows up as a diff in that one file.

Both tests pass as of 2026-07-08. They exercise the flag plumbing and the
per-preset posture, not the full behavior of every feature under every flag
combination; the per-feature test matrices live with each feature's specs (for
example under [`docs/specs/scheduler-v2/`](../specs/scheduler-v2/) and the CFC
design docs).

## Implementation details

The Category 1 flags are declared as the `ExperimentalOptions` interface in
[`packages/runner/src/runtime.ts`](../../packages/runner/src/runtime.ts). The
`Runtime` constructor merges the provided flags with the built-in defaults
(`commitPreconditions`, `plainResultReceipts`, and `computedCellIds` true, the
other Category 1 flags false),
propagates each one to its ambient control point, and then reads the effective
state back so that `runtime.experimental.*` reflects what is actually in effect.

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
  `CF_TRAVERSE_CAPTURE_MAX`, `CF_TRAVERSE_DIAGNOSTICS`. What each one does is in
  [the configuration reference](./CONFIGURATION.md#runner-diagnostics).
- **CLI controls** (environment): `CF_EXEC_SHEBANG`, `CF_CLI_TRACE_TIMINGS`,
  `CF_PROFILE_DONE_MARKER`.
- **Operational and build toggles**: `MEMORY_ACL_MODE` (`off` / `observe` /
  `enforce` space-access policy), `MEMORY_DUMP_ENABLED` (state-inspector dump
  endpoint), `OTEL_ENABLED`, `PRODUCTION` (shell build mode). ACL mode is a
  permanent deployment policy ladder, not an experimental runtime feature.
- **Test controls**: `TEST_LLM`, `TEST_HTTP`, and the integration-test
  environment variables (`HEADLESS`, `PIPE_CONSOLE`, `CFC_BROWSER_PROFILE_COUNT`,
  `CF_WAITFOR_DELAY_MS`).
