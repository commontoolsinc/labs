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

Three facts make that non-optional:

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
- **Tier 1 hands one class back on purpose.** Over an OPEN argument object it
  lets a candidate name a new optional field of any type, on the stated ground
  that the runner validates merged durable arguments before committing such an
  update. Measured: on the production repair path it does not. A value the old
  version stored legally becomes unreadable, with nothing raised anywhere. Two
  tiers each assuming the other covers a class is how it stays uncovered.

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
| Every case discriminates — each goes red under a mutation of the thing it claims to test | measured by mutation: dropping `expectedPatternIdentity` reds the rejection case; no-oping the snapshot restore reds **five of six** (the sixth takes no snapshot); undoing `.for('itemList')` reds the storage-move case; giving the argument candidate a COMPATIBLE type reds the argument case |
| A stranded-data assertion needs its control in the SAME case | measured: with the restore no-oped, the storage-move case alone stayed GREEN — `items === []` is also what an unrestored fixture reads. It now replays the vintage over the same snapshot first, and the argument case carries the same control for the same reason |
| Tier 1 **defers** the open-argument evolution class to a runtime guard that the update path does not reach | measured: over an open argument object, a candidate naming a new optional field of any type is waved through (`schema-compatibility.ts`, "Open objects remain evolvable…"), on the doc comment's promise that "the runner validates the piece's merged durable arguments against the new schema". On the production repair call it does not — the update lands with no refusal and `{count:"seven"}` stops being readable through the new schema. `Runner.validateArgument` → `validateSchemaValue` DOES reject the pair in isolation |
| The miss takes TWO gates, not one | measured: `applySetupState` re-stages only when `!sameStoredSetup` (`runner.ts:1410`/`:1557`), which stamping `patternIdentity` first defeats — **but forcing that gate open with `reapplyStoredSetup: true` still yields no refusal**. A pattern swap supplies no argument, so the re-stage passes `{ unresolvedLinkRaw }` (`:1467`) and validates link-bearing slots as opaque. That leniency is deliberate (CT-1917) and swallows this too, which is why the auto-update hot-swap — `sameStoredSetup = false` hard-coded at `:1911`, but likewise no supplied argument — is not a way out either |
| Tier 1 also catches field REMOVAL, disjoint TYPE change, and a field moved between nesting levels | read off `schema-compatibility.ts` (messages, not line numbers, are the durable anchor): removal → "existing `<role>` field was removed" (rendered: `result.status: existing result field was removed`); disjoint type → "type … is not accepted by the candidate schema"; a nesting move is *seen* as a removal and reports as one. So none of those is a second Tier-2-only class — they are contract changes. The storage-move stays the only stranding class a contract check structurally cannot see |
| Two roots in ONE space store would collide on a single fixed cause | `getCell` derives the entity id as `createRef({}, cause)` (`runtime.ts`), and that derivation does not include the space. Fixed by keying the cause per pattern (`vintageRoot(…, key)`); see the stage-3 note below |

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
- [x] Cover the open-argument class — the one Tier 1 hands back on purpose,
      populating the root's durable ARGUMENT document rather than only its
      result cells

Gate: **met.** `packages/piece/test/state-continuity.test.ts`, 6 steps green,
whole package suite green.

Things this stage settled that the plan had wrong or open:

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
  this compounds — `dispose()` closes the server too, and the test's `afterEach`
  now RAISES a teardown failure instead of swallowing it, so the leak that fix
  closes cannot quietly reopen.
- The root cause is keyed per pattern, not one global constant. A fixed cause
  is what keeps a root addressable across captures, but `getCell` derives the
  entity id from the cause ALONE — the space is not an input — so a single
  constant would give every root in every fixture the same id. Two patterns
  captured into one space store would then silently alias: the second
  materialize stamps its identity over the first's root, nothing errors, and
  the fixture replays something nobody captured.
- The capture write is checked. It went in as a bare `edit()` whose
  `commit()` result was discarded — and `commit()` REPORTS a conflict in its
  result rather than throwing, so a capture racing the tail of its own
  materialize could snapshot a space missing the very state the tier replays.
  Downstream cases would go red, but several layers from the cause. It is now
  `editWithRetry` with the result asserted.

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

Two constraints the stage-2 harness imposes on this layout, both measured:

- **A fixture is bound to the DID it was captured under, and the file does not
  say which.** The space id lives in the on-disk FILENAME
  (`resolveSpaceStoreUrl`), which the fixture layout above replaces with
  `<iso>-<identity>`; inside the store it survives only embedded in link
  targets (measured: the DID appears in `commit.original` and `revision.data`).
  `openFileBackedRuntime` restores under `signer.did()` unconditionally, so a
  vintage captured by any other signer restores "successfully" and reads
  EMPTY — which is this tier's stranding signal. That is a false positive on
  the gate, not a red herring. Either every pinned vintage is captured by the
  fixture signer, or the layout must carry the space id and the harness must
  take it explicitly. Decide before seeding fixtures, not after.
- **One root key per pattern.** Roots are addressed by cause and the cause
  alone determines the entity id, so a fixture holding two patterns needs two
  keys (`vintageRoot(vintage, schema, key)`). One fixture per pattern, as the
  layout above has it, needs nothing further.

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
- **Should the open-argument class be FIXED rather than pinned?** Stage 2
  pins the current behaviour — the update lands and the stored value stops
  being readable. But Tier 1 waives that class specifically because the runner
  is supposed to validate merged durable arguments, so the honest resolutions
  are to make the validator reachable on this path or to stop waiving it in
  Tier 1. Pinning it is a description, not an endorsement.

  What makes this harder than "route the repair through the validator": the
  second gate is the `{ unresolvedLinkRaw }` leniency every no-supplied-argument
  swap takes, and that leniency exists for a real reason (CT-1917 — a nested
  piece whose argument lives in a host doc that has not synced must not fail
  the swap). So the fix has to separate "this slot is a link I cannot read yet"
  from "this slot is a plain value of the wrong type", rather than tighten the
  path wholesale. Whoever picks this up should start there, not at
  `sameStoredSetup`.

## References

- [`docs/specs/pattern-imports/pattern-updates.md`](../specs/pattern-imports/pattern-updates.md)
  — the updater this tier guards, and the § that requires this work
- [`space-clone-rehearsal.md`](space-clone-rehearsal.md) — same-DID reasoning
  and the rehearsal practice this shares mechanics with
- `packages/piece/test/check-update-default-pattern.test.ts` — the update path
  driven with inline sources; stage 2 drives it from a captured vintage instead
- `packages/patterns/system/home.vintage-defaults.test.ts` — the hand-enumerated
  source-text guard this tier is meant to replace
