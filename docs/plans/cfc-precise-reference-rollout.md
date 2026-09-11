# Precise reference rollout

Enable the [precise reference profile](../specs/cfc-references.md) for a bounded
deployment cohort after a state-preserving Home migration. The rollout keeps
reference selection separate from assertions about mutable target contents.
Legacy mode is a temporary fallback, not Home's intended contract.

## Decisions

Home's roster, default profile, and MRU entries use the reference and display
contracts from `profile-create.tsx`. They authorize creating and selecting a
profile reference. The producing profile keeps its owner and writer policies;
consumers verify identity assertions when they consume those assertions.

Home requires an explicit migration of its published contract and stored
policies. Its automatic update cannot silently narrow an existing contract,
recreate the root, erase named state, or take an accepted-break exemption. The
migration runs in the trusted owner Runtime before the precise Home starts. It
must work on the owner client's open path: a server cannot assume access to
every private Home owner's credentials.

General atomic transactions across spaces are outside this rollout. A reference
selection does not need them. Mutable cross-space content assertions continue
to refuse when their evidence cannot be bound to the receiving commit. A
consumer needing an exact certified value must use a supported verification
boundary or an immutable, authenticated snapshot; it cannot treat a relationship
endorsement as that certification.

Precise references and the broader CFC enforcement ladder are separate choices.
This rollout does not claim that enabling reference persistence enables every
write-floor, trigger, policy-evaluation, or strict enforcement dial. Acceptance
tests name the complete posture they exercise.

## 1. Migrate Home without losing state

- [ ] Define a narrowly authorized migration for the recognized Home contract
      versions. It must check the prior revision and contract, retain the same
      root identity and profile target bindings, and publish the new contract
      together with its corresponding reference metadata.
- [ ] Cover the roster, default profile, MRU order, and their named backing
      cells. Preserve unrelated Home state, including favorites, inbox, sites,
      and creation configuration. Profile documents, verified identities, and
      their owner/write policies remain intact.
- [ ] Classify the stored declarations affected by the contract change. A
      source-type edit does not remove an existing declared store policy.
      Only the recognized migration may replace obsolete receiving content
      declarations; it must preserve reference-slot writer restrictions and
      all confidentiality that has not been validly discharged.
- [ ] Make interrupted migration resumable and revision-checked. Concurrent
      profile selection or roster changes must cause a fresh snapshot, not a
      lost edit. Mark completion only after all relevant records agree.
- [ ] Exercise the existing Home schema baselines and raw state fixtures through
      this migration. Update the gate to exercise the migration, not to exempt
      the incompatible contract or replace the old fixtures.

Acceptance includes populated profiles in separate spaces, verified identity
cells, nonempty MRU/default selection, old optional streams, cold restart,
interrupted migration, and concurrent edits. Both profile-link selection
authorization and the producing profile's edit authorization must still reject
unauthorized writes after migration.

## 2. Establish provenance for the cohort's stored references

- [ ] Inventory stored reference slots reachable from the cohort's Home and
      active pieces, including argument state, durable events, and aggregate
      winner state. Distinguish authored state from recomputable derived output.
- [ ] Recompute derived outputs, including legacy aggregate winner addresses,
      under the precise Runtime. Retain authored values and stable identities.
- [ ] Define the authority and confidentiality rules for trusted re-acquisition
      of authored legacy references. Preserve all known restrictions and every
      observation used to select each binding. A version change or an address
      string alone cannot establish missing historical provenance.
- [ ] Refuse entries whose required history cannot be established. Provide a
      deliberate authorized re-selection path where needed; do not invent a
      public acquisition to make an old slot pass.
- [ ] Verify every required slot after restart. A version-2 envelope does not
      establish completeness for untouched legacy slots.

## 3. Coordinate readers and writers

- [ ] Require compatible Runtime, worker, boundary readers, and Memory's generic
      required-read validation capability before precise writes begin.
- [ ] Include the shell, deployed CLI, serving and background Runtimes, embedding
      controllers, event dispatchers, and reconnecting clients in the writer
      inventory. They must persist and transfer complete reference history.
- [ ] Make the activation barrier effective for stale clients and concurrent
      writers. An active precise cohort cannot accept an older writer that
      silently emits references without the required history.
- [ ] Gate activation on migration completion. The migration and a configuration
      default must not race on Home's first open.

## 4. Prove and activate a bounded cohort

- [ ] Rehearse on writable clones using the
      [space clone procedure](../development/space-clone-rehearsal.md).
- [ ] Run end-to-end profile create, select, reorder, edit, verified-identity
      consumption, cold resume, client reconnect, and served-event flows in
      the intended enforcement posture.
- [ ] Verify private selection of public targets, public references to secret
      targets, target label changes, scope restrictions, and stale verification
      dependencies across these boundaries.
- [ ] Clear the PR's correctness, compatibility, performance, and coverage
      checks. A timeout increase or a discarded stored-state fixture does not
      establish readiness.
- [ ] Activate the prepared cohort and expand after its measured acceptance
      gates pass. Rollback requires a version-2-compatible runtime that preserves
      the recorded restrictions.

The first milestone is a migrated Home and its participating profile spaces with
all supported first-party writers. Fleet-wide activation follows completion of
the same gates for each additional cohort.
