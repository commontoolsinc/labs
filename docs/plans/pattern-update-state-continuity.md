# Pattern update state continuity (Tier 2)

Status: In progress. Stages 1–2 are complete: the capture/replay machinery is
built and the estuary brick is reproduced from a captured vintage through the
production repair call (`packages/piece/test/state-continuity-harness.ts` +
`state-continuity.test.ts`). Not yet wired to CI — stages 3–5 are what turn a
green test into a gate. Tier 1 — the schema gate — merged as [#5144] and runs
on every PR.

This plan takes the pattern-update regime from "the contract still type-checks"
to "the new pattern can still read what the old one wrote".

[#5144]: https://github.com/commontoolsinc/labs/pull/5144

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a parent complete only after its completion gate passes. When all stages
land or the plan is abandoned, archive this document under
`docs/history/plans/` as described in `docs/README.md`.

## Why

`home.tsx`, `default-app.tsx`, and the profile patterns auto-update: the runtime
resolves a source pointer to a current identity and swaps the pattern in place
onto the same result cell. The specification is
[`docs/specs/pattern-imports/pattern-updates.md`](../specs/pattern-imports/pattern-updates.md),
and it already names this tier as required work — "CI and golden replay tests
must exercise representative prior state and verify that the proposed source
still reads and preserves it".

Two facts make that non-optional:

- **The automatic updater performs no structural check at all.** `cf piece
  setsrc` refuses an incompatible replacement, but `PatternUpdater` compiles,
  verifies the entry identity, and applies. So CI is the only gate.
- **Tier 1 cannot see one whole class.** It proves argument/result contracts are
  backward compatible. A schema does not describe everything a pattern writes:
  move where a field is STORED — `.for('items')` becomes `.for('itemList')` —
  and the declared contract does not change by a single byte, while every
  document written under the old name becomes unreachable. Nothing throws; the
  data is simply gone. A document is precisely the thing a schema check does
  not have.

The motivating incident is the 2026-07-22 estuary brick: a home root doc
predating six separately-added required fields, where "first-absence-wins, so
each fixed field unmasks the next"
(`packages/patterns/system/home.vintage-defaults.test.ts`). That guard is
currently a hand-enumerated list of source-text assertions — it only covers
fields someone remembered to add after each incident.

**That particular class is caught by Tier 1 too**, and this plan originally
claimed otherwise. Measured: `assertPatternSchemasBackwardCompatible` rejects an
additive required result field with no default outright ("result.favorites:
newly required result field has no default"). It is covered a third time by
`packages/runner/test/cfc-additive-default-preserves-old-doc.test.ts`, which
drives the same runtime rejection over a legacy root. Tier 2 still replays it,
but for the *pipeline* rather than the guard: proving capture → snapshot →
reopen → materialize end to end needs one class whose correct outcome is
already known independently, or a green run is only evidence about itself. The
tier's unique coverage is the storage-move class above.

## What is verified

Measured on branch `tier2`, not assumed:

| Fact | Evidence |
| --- | --- |
| A file-backed store snapshots and reopens faithfully | `openFileBackedRuntime` + `snapshotSpaceStore`; state written by one runtime reads back in a fresh one |
| State written by an OLD pattern survives a NEW one adding a defaulted field | `state-continuity.test.ts`, green |
| A snapshot of a trivial one-pattern space is **~1.5 MB** | measured; it is the floor, since the store carries compiled artifacts |
| `StorageManager.emulate` runs its real memory server against `:memory:` | `engine.ts` `toDatabaseAddress`; there is no file to snapshot, hence file-backed capture |
| Entity ids are content-addressed from `{source, cause}` | `packages/runner/src/create-ref.ts` |
| `setupPersistent` mints `{ space, random: randomUUID }` when given no cause | `packages/piece/src/manager.ts` |
| Root creation bakes `Date.now()` into its cause | `packages/piece/src/ops/pieces-controller.ts` |
| The additive-required guard fires only on a **CFC-relevant** root — one with a stored CFC schema envelope | `prepare.ts` merges only when `storedMetadataFor` returns an envelope; a plain unlabelled root has nothing to merge against, so the guard never runs |
| Replayed through the production repair call, the guard produces the estuary rejection verbatim | measured: `CFC enforcement rejected commit: … cfc-schema-migration-incompatible: required field favorites needs a default to preserve old documents` |
| The same vintage + a candidate differing ONLY by `Default<[]>` commits cleanly, with prior state intact | measured: `{"items":["alpha","beta"],"favorites":[]}` |
| Tier 1 **does** catch the additive-required class | measured: `assertPatternSchemasBackwardCompatible` throws "result.favorites: newly required result field has no default" |
| Tier 1 is blind to a storage-key move | measured: result schemas byte-identical, no issue raised, replayed data empty |
| Every case discriminates — each goes red under a mutation of the thing it claims to test | measured by mutation: dropping `expectedPatternIdentity` reds the rejection case; no-oping the snapshot restore reds three of five; undoing `.for('itemList')` reds the storage-move case |
| A stranded-data assertion needs its control in the SAME case | measured: with the restore no-oped, the storage-move case alone stayed GREEN — `items === []` is also what an unrestored fixture reads. It now replays the vintage over the same snapshot first |

The CFC-relevance row corrects an assumption this work started with. An earlier
boundary test recorded that the guard "does not fire on a bare `runtime.setup`"
and inferred the missing ingredient was the repair path. The repair path was
necessary but not sufficient: the actual precondition is a **stored CFC
envelope** on the root. A pattern with no CFC-labelled field produces no
envelope, so the merge is skipped and no guard can run, whichever call drives
the setup. Real system roots (home, profile) are CFC-relevant, so the fixture
models them rather than working around them.

## Decisions

**Capture on identity change, not schema change.** The updater fires on identity
change, so the fixture set should mirror the set of versions that can actually
be a pinned predecessor. It is also a correctness point rather than a
future-proofing one: what a pattern *writes* is not determined by its schema.
Between two identities with identical schemas a pattern can change which derived
cells it creates or which keys a handler stores under, so capturing only at
schema changes under-covers. Retention bounds the cost, so capture frequency
does not.

**SQLite space stores, not a JSON dump.** A space is already one SQLite file,
`packages/memory/v2/dump.ts` already writes a crash-consistent copy, and
restoring is a file copy. A JSON dump would need a re-writer that reconstructs
docs, causes, and links — and getting causes wrong silently produces a fixture
that is not the state that was captured. Restore is same-DID; re-keying is an
unbounded migration that destroys the fidelity the fixture exists to buy (see
[`space-clone-rehearsal.md`](space-clone-rehearsal.md)).

**Auto captures live in CI artifacts; pinned vintages live in git.** At ~1.5 MB
a floor, committing every capture would grow the repo without bound, and git
history keeps deleted blobs forever, so pruning reclaims nothing. Auto captures
exist only to cover what staging is running, churn constantly, and are
regenerable from the build that produced them — artifact retention covers the
window. Pinned vintages are irreplaceable and few.

**The pruner must be structurally unable to reach a pinned vintage.** Not a
rule, a directory split. A deep vintage cannot be recaptured — the pattern that
wrote it no longer exists in runnable form — and the pruner is invoked by
people doing something else.

**Migrations add dumps, never regenerate them.** When a memory-engine migration
lands, a dump regenerated afterwards proves nothing; the pre-migration state is
the artifact. That is the moment auto captures need promoting to pinned. The
selection rule also differs from everything else here: the trigger is a
memory-engine schema change, not a pattern change, and it wants breadth across
*shapes* rather than depth per pattern. Shared storage, separate selection.

**Restore exercises the migration chain.** `snapshotSpaceStore` deliberately
runs no migrations, but reopening an old store does. That is a feature — proof
that memory migrations preserve old spaces — but it means a red fixture can be
a migration bug rather than a pattern bug. Worth knowing when triaging.

## Stages

### 1. Capture and replay machinery

- [x] File-backed runtime with a snapshot/restore pair
- [x] Deterministic root cause, so a fixture stays addressable across captures
- [x] Round-trip test: a snapshot is a faithful, reopenable space
- [x] Continuity test: old-written state survives a new defaulted field
- [x] Boundary test recording what this path does *not* catch

Gate: green on `tier2`. **Done.**

### 2. Drive the real update path

- [x] Replay through the production root-repair call rather than a bare
      `runtime.setup` — `runSynced(root.withTx(), pattern, undefined,
      { expectedPatternIdentity })`, preceded by the identity stamp, exactly as
      `pieces-controller.ts` spells it
- [x] Reproduce the estuary brick from a captured vintage: refused without
      `Default<>`, clean with it, asserting the specific CFC token
- [x] Prefer `PatternUpdater` semantics over `setsrc`, and pin where they differ
- [x] Cover the storage-move class — the one Tier 1 structurally cannot see

Gate: **met.** `packages/piece/test/state-continuity.test.ts`, 5 steps green,
whole package suite green.

Two things this stage settled that the plan had wrong or open:

- `expectedPatternIdentity` is not a formality. It is what makes `runSynced`
  THROW on a setup-commit rejection instead of logging and continuing. Without
  it a refused migration reads as a successful materialize over a dead root —
  the gate would be green on exactly the failure it exists to catch.
- Capture and replay must materialize through the SAME call. A pattern's owned
  cells are addressed off the pattern instance, so a capture that allocated
  them by another route hands the replay a root whose keys resolve to documents
  it never wrote — an empty-looking fixture and assertions that fail for a
  reason unrelated to the pattern under test.
- The vintage owns its memory *server*, not just its storage manager.
  `StorageManager.close()` tears down only the client side; the server holds a
  SQLite engine per space, a read pool, and a refresh timer, and the temp dir
  gets removed out from under them. Stages 3–4 open a vintage per fixture, so
  this compounds — `dispose()` closes the server too.

On `setPattern` versus `PatternUpdater`: the replay drives the updater's path,
because that is what the field actually runs. The difference is the whole
reason this regime is CI-only — `cf piece setsrc` calls
`assertPatternSchemasBackwardCompatible` and refuses on failure, while the
automatic updater performs no structural check at all.

### 3. Curated vintages in git

- [ ] `fixtures/<pattern key>/pinned/<iso>-<identity>.sqlite`, labelled by the
      pattern identity that wrote it (provenance, not an address — nothing looks
      a fixture up by it; the replay enumerates the directory)
- [ ] Seed with the vintages worth having: a pre-migration home doc, and any
      transition an incident makes worth pinning
- [ ] Assert every `packages/patterns/system/**` pattern has at least one
      vintage, so a system pattern cannot change without one

Gate: a system-pattern schema change with no vintage fails CI.

### 4. Auto captures and retention

- [ ] Post-merge job captures when the pattern identity changed, uploads as a CI
      artifact
- [ ] Replay job fetches the last few auto captures plus every pinned vintage
- [ ] Retention by count, not age — no clock in the check
- [ ] Pruner globs `auto/` only, and cannot address `pinned/`

Gate: a staging deploy always has a capture the replay can use.

### 5. Migration coverage

- [ ] Trigger on memory-engine schema change
- [ ] Promote the affected auto captures to pinned rather than recapturing
- [ ] Breadth across shapes rather than depth per pattern

Gate: a memory migration cannot land without replaying pre-migration stores.

## Open questions

- **How many vintages is enough?** Retention is a policy statement — "a piece
  that has not opened in N releases may not roll forward". It should be a
  reviewed constant, not an accident of when someone last pruned.
- **Does a fixture rot?** The by-identity load keys its compile cache on a
  runtime version and falls back to recompiling the stored source closure on a
  miss, which reintroduces "old source must still compile under today's API".
  Unresolved: whether a pinned vintage stays replayable across a runtime bump,
  or whether the fallback needs pinning too.
- **Where does the replay run?** It needs a real runtime and is heavier than
  Tier 1. Its own job, or folded into an existing one.

## References

- [`docs/specs/pattern-imports/pattern-updates.md`](../specs/pattern-imports/pattern-updates.md)
  — the updater this tier guards, and the § that requires this work
- [`space-clone-rehearsal.md`](space-clone-rehearsal.md) — same-DID reasoning
  and the rehearsal practice this shares mechanics with
- `packages/piece/test/check-update-default-pattern.test.ts` — the update path
  driven with inline sources; stage 2 drives it from a captured vintage instead
- `packages/patterns/system/home.vintage-defaults.test.ts` — the hand-enumerated
  source-text guard this tier is meant to replace
