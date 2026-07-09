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

**Last reviewed:** 2026-07-08.

## Summary table

| Flag | Toggle via | Default today | Originally added by | Planned end state | Status (2026-07-08) |
|------|-----------|---------------|---------------------|-------------------|---------------------|
| [`modernCellRep`](#moderncellrep) | `EXPERIMENTAL_MODERN_CELL_REP` env, or `RuntimeOptions.experimental` | off | Dan Bornstein (#3818) | graduate to always-on, then delete flag | implemented, off by default |
| [`persistentSchedulerState`](#persistentschedulerstate) | `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` env, or `RuntimeOptions.experimental` | off | Bernhard Seefeld (#3646) | graduate to always-on | implemented, off by default, rollout in progress |
| [`commitPreconditions`](#commitpreconditions) | `RuntimeOptions.experimental` only (mapped `null` — programmatic-only — in the canonical env registry) | off | Bernhard Seefeld (#4090) | graduate with scheduler-v2 speculation lineage | implemented, off by default |
| [`eagerSourceAnnotation`](#eagersourceannotation) | `EXPERIMENTAL_EAGER_SOURCE_ANNOTATION` env, or `RuntimeOptions.experimental` | off in production, on in shell dev builds | gideon (#4458) | permanent debug toggle, not slated for removal | implemented |
| [`computedCellIds`](#computedcellids) | `EXPERIMENTAL_COMPUTED_CELL_IDS` env, or `RuntimeOptions.experimental` | off | Robin McCollum (in development) | graduate to always-on with the computed-cell write-conflict policy | in development on robin/feat-computed-cell-identity-p2 |
| [`cfcEnforcementMode`](#cfcenforcementmode) | `RuntimeOptions.cfcEnforcementMode` (`CF_CFC_MODE` in the cf-harness / fuse) | `enforce-explicit` | Bernhard Seefeld (#3263) | tighten default toward `enforce-strict` | active; ladder is permanent |
| [`cfcFlowLabels`](#cfcflowlabels) | `RuntimeOptions.cfcFlowLabels` | `off` | Bernhard Seefeld (#4011) | move toward `persist` | implemented, staged rollout |
| [`cfcWriteFloor`](#cfcwritefloor) | `RuntimeOptions.cfcWriteFloor` | `off` | Bernhard Seefeld (#4479) | move toward `enforce` | implemented, staged rollout |
| [`cfcTriggerReadGating`](#cfctriggerreadgating) | `RuntimeOptions.cfcTriggerReadGating` | `false` | Bernhard Seefeld (#4488) | move toward `true` | implemented, staged rollout |
| [`cfcPolicyEvaluation`](#cfcpolicyevaluation) | `RuntimeOptions.cfcPolicyEvaluation` | `off` | Bernhard Seefeld (#4566) | move toward `enforce` | implemented, staged rollout |
| [`conflictAdmissionMode`](#conflictadmissionmode) | `CF_CONFLICT_ADMISSION` env, or `setConflictAdmissionMode()` | `off` | William Kelly (#4237) | keep as a tuning dial or remove after re-measurement | implemented, off by default, measured net-negative or neutral |
| [`syncSchemaTableV2`](#syncschematablev2) | `setSyncSchemaTableConfig()` (negotiated per connection) | on | Ben Follington (#4292) | retire the negotiation once every peer speaks v2 | implemented, on by default |
| [`cfcRenderCeiling`](#cfcrenderceiling) | `commonfabric.cfcRenderCeiling()` in the browser (localStorage) | off | Bernhard Seefeld (#4550) | graduate once exchange resolution lands | implemented, off by default, dogfood only |

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
`undefined`, which means "take the built-in default"; the built-in default is
`false` for every one of them.

The mapping from environment variable to flag is defined once, canonically, as
`EXPERIMENTAL_ENV_VARS` in
[`packages/runner/src/runtime-presets.ts`](../../packages/runner/src/runtime-presets.ts),
and read by `experimentalOptionsFromEnv(envReader)`. The toolshed, the CLI, and
the background piece service all go through that one mapping, so their wirings
cannot drift; the shell reads the same variables from its build-time defines.
Three flags are env-reachable (`modernCellRep`, `persistentSchedulerState`,
`eagerSourceAnnotation`); `commitPreconditions` is deliberately mapped to `null`
there, which records "not env-reachable" as a decision rather than an omission.
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

### `commitPreconditions`

- **Toggle via.** `RuntimeOptions.experimental.commitPreconditions` only. It has
  no environment variable today: it is mapped to `null` in the canonical
  `EXPERIMENTAL_ENV_VARS` registry, which puts "not env-reachable" on the record
  as a deliberate choice rather than leaving it absent from one wiring. Wiring an
  environment variable is a one-line change there. Until then it can be enabled
  only by constructing a `Runtime` with the flag set, which is what its tests do.
  The ambient control point is `setCommitPreconditionsConfig` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts).
- **Added by.** Bernhard Seefeld, in "speculation lineage for event-launched
  work (scheduler-v2 E1)" (#4090, 2026-06-12).
- **Purpose.** Attaches origin-committed preconditions to scheduler-v2 lineage
  commits, so that event-launched follow-up work commits only against the state
  it was speculated from.
- **Current default and planned end state.** Off by default. It is meant to
  graduate together with the rest of scheduler-v2 speculation lineage.
- **Status on 2026-07-08.** Implemented and plumbed through the runner and the
  memory protocol, behind the flag. Off by default and reachable only
  programmatically.
- **Path to removal.** This exists to serve scheduler-v2 speculation lineage; it
  can be deleted only when lineage tracking becomes part of the base scheduler
  semantics. At that point remove the flag, the precondition attach and check in
  the storage transaction path, and the server-side precondition check in the
  memory engine.

### `eagerSourceAnnotation`

- **Toggle via.** `EXPERIMENTAL_EAGER_SOURCE_ANNOTATION` environment variable, or
  `RuntimeOptions.experimental.eagerSourceAnnotation`. The ambient control point
  is `setEagerSourceAnnotation` in
  [`packages/runner/src/builder/module.ts`](../../packages/runner/src/builder/module.ts).
  Unlike the other three, the runtime propagates this one only when it is set
  explicitly, because the ambient flag is also a test seam.
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

### `computedCellIds`

- **Toggle via.** `EXPERIMENTAL_COMPUTED_CELL_IDS` environment variable
  (through the canonical env registry) or `RuntimeOptions.experimental`.
- **Added by.** Robin McCollum, on the computed-cell-identity branch (spec:
  `docs/specs/computed-cell-identity.md`).
- **Purpose.** Mints kind-tagged entity ids (`fid2:computed:`) for internal
  cells the builder proves are written only by compute nodes. Gates minting
  only; readers accept both id forms unconditionally, so the flag can flip
  either way without a migration.
- **Current default and planned end state.** Off by default. Graduates to
  always-on together with the computed-cell write-conflict policy (ack-and-drop
  for stale all-computed commits), then the flag is deleted.
- **Status on 2026-07-09.** In development on
  `robin/feat-computed-cell-identity-p2`: phase 1 (kind-tagged minting) and
  phase 2 (ack-and-drop of stale all-computed commits) implemented behind the
  flag; classifier widening via capture-write verification in progress.

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

> Two neighbours in the same handshake are related but are not runtime-toggleable
> experimental flags:
>
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

---

## How flags propagate

The environment-backed flags (`EXPERIMENTAL_MODERN_CELL_REP`,
`EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE`, `EXPERIMENTAL_EAGER_SOURCE_ANNOTATION`)
reach the runtime through the deployed processes. The runtime-only flags
(`commitPreconditions`, the CFC dials) reach it only through the `RuntimeOptions`
passed to `new Runtime(...)`.

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
`Runtime` constructor merges the provided flags with the defaults (all `false`),
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

### `schedulerHistoricalMightWrite` (removed)

An `ExperimentalOptions` flag that preserved the scheduler's cumulative
"historical might-write" tracking for dependency scheduling, instead of the
current-known write set. It was confirmed deletable on 2026-06-11 and has been
removed from the code; under scheduler-v2's static write surface the writer map
is fixed at registration, so the discovered write history is obsolete. Several
scheduler-v2 spec documents still mention it as part of their migration history.

### `esmModuleLoader` / `CF_ESM_MODULE_LOADER` (removed)

The flag that selected the ESM module-record loader over the older AMD bundle
path during the content-addressed module-loading rollout. (An early draft of the
plan called it `EXPERIMENTAL_ESM_MODULE_LOADER`.) It was defaulted on, and then
the flag, the AMD bundle pipeline, and the AMD compilation cache were all
removed; the ESM loader is now the only loader. See
[`docs/specs/module-loading-implementation-plan.md`](../specs/module-loading-implementation-plan.md),
whose status header records the removal.

### `EXPERIMENTAL_MODERN_DATA_MODEL` (never implemented)

Mentioned only in
[`docs/specs/persistent-scheduler-state/implementation_notes.md`](../specs/persistent-scheduler-state/implementation_notes.md)
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
- **Operational and build toggles**: `MEMORY_DUMP_ENABLED` (state-inspector dump
  endpoint), `OTEL_ENABLED`, `PRODUCTION` (shell build mode).
- **Test controls**: `TEST_LLM`, `TEST_HTTP`, and the integration-test
  environment variables (`HEADLESS`, `PIPE_CONSOLE`, `CFC_BROWSER_PROFILE_COUNT`,
  `CF_WAITFOR_DELAY_MS`).
