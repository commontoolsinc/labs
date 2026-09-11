# Precise reference rollout

**Rollout decision: enable the intended precise deployment posture first, then
migrate existing Homes in a separate, controlled step.** The Home migration may
wait for that activation. Enabling a flag does not migrate stored references or
authorize replacing Home's published contract.

Hixie owns the activation decision. Coordinate the implementation and migration
work for [PR #7243](https://github.com/commontoolsinc/labs/pull/7243) with him
before activation changes ship. Record the deployed commit and all five CFC dials
from the [enforcement matrix](../specs/cfc-enforcement-matrix.md); “precise mode”
alone does not identify the deployed behavior.

## Activation boundary

The [independently labeled reference profile](../specs/cfc-references.md) uses
`cfcFlowLabels: "persist"`. PR #7243 changes the meaning and persisted format of
those references. Enabling persistence without this implementation is a different
milestone from activating its version-2 reference checks.

Two sequences are supported:

1. If Hixie's initial activation does **not** include this reference-profile
   implementation, it can precede this PR and the Home migration. Rehearse the
   migration afterward against the actual enabled posture. Keep this PR's Home
   contract transition gated until that rehearsal and compatibility gate pass.
2. If the initial activation **does** include this implementation, admit only
   fresh or verified-ready Homes and their participating writers/readers. Keep
   unresolved existing Homes on a compatible deployment until they migrate.
   Deployments are the isolation boundary unless explicit per-Home routing and
   writer admission have been implemented and tested. There is no automatic
   migration or per-Home readiness switch supplied by this plan.

An unrestricted flip of the new reference profile over unresolved legacy data is
not a supported transparent rollout: it can refuse reads, forwarding, and handler
sends. Lowering write-floor enforcement does not repair missing acquisition
history. If an excluded Home cannot be routed to a compatible deployment,
postpone that Home's activation; do not synthesize public references or disable
checks inside its handlers.

## Contracts and invariants

- Home's roster, default profile, and MRU entries use the reference and display
  contracts in `profile-create.tsx`. They authorize creating and selecting a
  profile relationship. The producing profile retains its owner/writer policies;
  consumers verify identity assertions at their point of use.
- Retain Home's root identity, named backing cells, profile target identities,
  roster membership, default selection, and MRU order. Preserve favorites, inbox,
  sites, and creation configuration. Do not recreate profiles or rewrite their
  verified identities.
- A source-type change does not erase stored declarations. Transition both Home's
  published contract and recognized receiving policies, preserving slot writer
  restrictions and confidentiality that has not been validly discharged.
- A relationship endorsement does not certify future mutable target contents.
  Mutable cross-space content assertions refuse when their evidence cannot be
  bound to the receiving commit. General cross-space atomicity is outside this
  rollout; use a supported verification boundary or an immutable, authenticated
  snapshot for a certified value.
- Verification runs in the trusted Runtime before storage submission. Memory
  validates required read dependencies and transports opaque event context; it
  does not evaluate CFC policy. A future server-hosted verifier must have the same
  authority and evidence as the client verifier.

## Phase 0: prepare the activation decision

Owner: Hixie, with the PR author supplying the evidence.

- [ ] Record whether the first activation includes PR #7243, its exact commit,
      deployment/cohort, and resolved five-dial posture for each host. Include
      enforcement mode, flow labels, write floor, trigger gating, and policy
      evaluation; record server execution separately.
- [ ] Inventory the shell worker, RuntimeProcessor, deployed CLI, embedding
      controllers (including Loom), serving/background Runtimes, event producers,
      and reconnecting clients participating in that cohort.
- [ ] Require version-2 envelope readers, complete per-slot reference writers,
      worker acquisition-token support, and generic required-read validation
      before the new reference profile writes to shared data.
- [ ] Require event dispatch-context version 2 in participating Runtime readers
      and writers. It binds the payload to the selected stream and carries the
      sending flow even for primitive events. Older Runtime context readers
      reject it. Memory's opaque string transport needs no CFC policy change.
- [ ] Define an enforceable stale-writer barrier: minimum supported host build at
      admission, or an isolated deployment with controlled writers. Reconnecting
      old clients must not author unproven slots into a precise cohort. Reader
      compatibility alone is insufficient.
- [ ] Test the compatible route for excluded Homes before broad default changes.
      Pin the supported Home implementation as well as its Runtime; automatic
      `ensureDefaultPattern` reconciliation must not install an incompatible
      contract ahead of migration.
- [ ] Clear correctness, performance, coverage, and compatibility checks on the
      exact reference-profile release commit. The required Home pattern cannot
      take an accepted-break exemption. If migration is deferred, keep its
      incompatible contract transition unlanded or split it into the migration
      release; do not waive the existing baseline gate.

Exit: a reviewed activation record with an explicit included/excluded population,
compatible host versions, admission barrier, and rollback build. Hixie's initial
activation can happen according to the boundary above. Migration starts
afterward; activation implies no background live-data rewrite.

## Phase 1: inventory and rehearse after activation

Owner: migration implementer; the Home owner authorizes the resulting transition.

- [ ] Follow the [space clone procedure](../development/space-clone-rehearsal.md)
      to copy representative real Homes and participating profile/consumer spaces.
      Record source revisions; keep inventory read-only until the clone exists.
- [ ] Inventory slots in Home, its named cells, active piece arguments/results,
      incoming participating consumer cells, pending durable events, and aggregate
      winner state. Record source document/path, full target binding, contract,
      metadata version, confidentiality, completeness, and responsible writer.
- [ ] Classify each slot as complete, derived and recomputable, authored and
      eligible for trusted re-acquisition, or unresolved and requiring explicit
      owner re-selection. Version 2 alone does not certify every slot.
- [ ] Exercise the supported Home contracts with legacy and complete reference
      fixtures: name/identity-value reads, forwarding, old-contract republication,
      direct protected writes, and optional edit handlers. Distinguish reading an
      identity value from verifying its integrity claim.

This is **not a global search for everything pointing to Home**. Keeping Home's
identity preserves ordinary incoming addresses. Each incoming consumer's stored
slot nevertheless needs its own provenance when that consumer joins precise
operation; migrating the target cannot repair the consumer's slot. An old
embedded content contract needs separate compatibility treatment when the
consumer republishes it as a new assertion. Expand the participating graph until
every acceptance flow is covered; unknown external consumers remain outside the
readiness claim.

## Phase 2: implement the owner-authorized migration

Run in the trusted owner Runtime on the owner's open path. A server cannot
assume credentials for every private Home. Automatic source reconciliation is
not a substitute for this migration protocol.

Implementation entry points:

| Surface | Required integration |
|---|---|
| `RuntimeProcessor.handleEnsureHomePatternRunning` in `packages/runtime-client/src/backends/runtime-processor.ts` | Establish the owner session and run migration preflight before starting the candidate Home. |
| `PiecesController.#startEnsuredDefaultPattern` in `packages/piece/src/ops/pieces-controller.ts` | Coordinate source reconciliation with migration completion; automatic source replacement must not bypass the contract/state gate. |
| `ensureSpaceRootPattern` in `packages/runner/src/ensure-space-root.ts` | Keep serving activation consistent with the persisted migration state. Resolving an existing root is not proof that its owner migration ran. |
| `packages/patterns/baselines/system/home.tsx` and the pattern compatibility gate | Retain the existing contracts and add executable migration/state replay before accepting the new contract. |

The regression fixture in
`packages/runner/test/profile-home-published-reference.test.ts` exercises both
stored Home schemas with complete and incomplete incoming slots against a real
profile. It supplies a starting case for migration tests, not an implementation
of migration or evidence about every live Home.

1. **Preflight.** Verify owner identity, recognized prior contract, and migration
   version. Snapshot Home's root, named cells, declarations, slots, and revisions.
   Refuse unknown contracts and missing evidence without changing data. Produce
   a reviewable dry-run report of planned edits and unresolved slots.
2. **Recover history.** Recompute derived outputs and legacy aggregate winner
   addresses with the precise Runtime. For authored slots, use narrowly
   authorized re-acquisition preserving known restrictions and observations that
   select the binding. An address, schema assertion, or `cfc.version` change
   cannot establish omitted history. Where history or authority is unavailable,
   require deliberate authorized re-selection and leave the Home outside the
   ready cohort.
3. **Transition Home.** Stage the published contract, recognized obsolete
   receiving declarations, and matching per-slot metadata under the same Home
   identity. Preserve profile documents and policies. Keep Home-space changes in
   a revision-checked transaction where supported. A protocol spanning several
   transactions must prevent the new Home from starting or other writers from
   observing a mixed contract/state transition.
4. **Verify and complete.** Cold-read with the precise Runtime. Verify required
   slots, preserved state/identities, source identity, and the new contract.
   Record a versioned completion marker only after they agree. The owner open
   path starts the new Home only when that marker and checked revisions are valid.
5. **Resume safely.** Make migration idempotent. On conflict, preserve the
   competing edit and build a new snapshot. On interruption, resume or roll back
   recognized partial state under the same authority; never mark it ready.
   Profile spaces have separate revisions and authorization; no Home transaction
   pretends to lock them.

The completion record names the migration version, prior/new contract hashes,
affected documents/revisions, preserved identities, and per-slot readiness.
Protect confidential inventory details with equivalent access restrictions;
keep them out of public logs and never retain owner credentials in the record.

## Phase 3: prove compatibility and admit migrated Homes

- [ ] Feed both existing `system/home.tsx` baselines and populated stored-state
      fixtures through migration and then the candidate Home. Extend the gate
      to exercise that authorized transition. Keep the old fixtures; recording a
      new schema baseline alone proves no migration.
- [ ] Verify profile create, select, reorder, rename/avatar edit, verified
      identity verification, cold resume, owner reconnect, and served events.
      Include old optional handlers and events queued before upgrade.
- [ ] Verify interrupted/resumed migration, concurrent roster/default changes,
      and rejection of stale clients and unauthorized direct profile edits.
- [ ] Verify private selection of public targets, public references to secret
      targets, target-label changes, scope restrictions, and stale verification
      evidence. Incomplete links must refuse reads, forwarding, and handler
      dispatch before queuing or durable append.
- [ ] Verify local dispatch, served replay, same-space cascades, and cross-space
      outbox propagation of stream-selection confidentiality, including events
      with no references in their payload.
- [ ] Run the large lunch-poll fixture with the intended posture and normal CI
      budget; measure a controlled main/candidate comparison if it regresses.
      Increasing the timeout does not prove readiness. Obtain authoritative
      coverage results after dependent tests pass.
- [ ] Admit one prepared owner/Home graph. Confirm completion and host/admission
      barriers before starting its new Home. Expand after the acceptance flows
      pass and observed refusals are classified.

Exit: an exact-commit acceptance record, successful baseline migration replay,
preserved state/identities, and no unclassified failure in supported flows.
Repeat these gates for each additional cohort; a synthetic fixture cannot
certify a live space inventory.

## Monitoring, stop conditions, and rollback

Track migration failures by version/cohort, incomplete-reference refusals, missing
linked-content evidence, invalid event context, failed event consequences, owner
edit failures, and profile-flow latency. Treat refused legacy slots as readiness
failures needing migration/re-selection, not a reason to synthesize public labels.
Alert on unexpected refusals in admitted Homes, contract/state disagreement, lost
identities, or unrecognized writers; stop expansion and retain diagnostic
revisions.

Rollback uses a Runtime that reads version-2 envelopes and dispatch contexts and
preserves recorded restrictions. Do not downgrade to a pre-profile writer over
precise data or replay events after stripping context. Before a Home transition,
keep its compatible contract. After transition, retain the migrated contract
unless a separately tested reverse migration exists. Restore a snapshot only
with an explicit plan for later writes; overwriting concurrent user changes is
not an automatic rollback.

Live migration, deployment, and merge are distinct authorized operations. This
plan makes their prerequisites concrete; it does not execute them.
