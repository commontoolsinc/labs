# Pattern update state continuity (Tier 2)

Status: In progress. The capture/replay machinery is built and green on branch
`tier2` (`packages/piece/test/state-continuity-harness.ts` +
`state-continuity.test.ts`); it is not yet a PR and not yet wired to CI. Tier 1
— the schema gate — merged as [#5144] and runs on every PR.

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
- **Tier 1 cannot see this class.** It proves argument/result contracts are
  backward compatible. A schema does not describe everything a pattern writes:
  data under keys the new version drops or renames becomes unreachable with no
  subset violation, and a migration can refuse a document older than a field
  while both contracts are individually fine. A document is precisely the thing
  a schema check does not have.

The concrete precedent is the 2026-07-22 estuary brick: a home root doc
predating six separately-added required fields, where "first-absence-wins, so
each fixed field unmasks the next"
(`packages/patterns/system/home.vintage-defaults.test.ts`). That guard is
currently a hand-enumerated list of source-text assertions — it only covers
fields someone remembered to add after each incident.

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
| The CFC additive-required guard does **not** fire on a bare `runtime.setup` onto a plain cell, even at `enforce-explicit` | `state-continuity.test.ts` boundary test; the pattern's own setup creates the owned cell with its initial value, so no value is missing to preserve |

That last row is a correction to an assumption this work started with, and it
sets the next stage: reaching the guard at
`packages/runner/src/cfc/schema-merge.ts` needs the root repair path
(`PiecesController` / `ensureDefaultPattern` over a piece result cell), the way
`packages/piece/test/check-update-default-pattern.test.ts` drives it — not a
bare setup.

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

- [ ] Replay through `PiecesController` / `ensureDefaultPattern` rather than a
      bare `runtime.setup`, so the root repair path — and with it the CFC
      additive-required guard — is actually exercised
- [ ] Reproduce the estuary brick from a captured vintage: red before the
      `Default<>` fix, green after
- [ ] Decide `setPattern` (the `setsrc` semantics) versus `PatternUpdater` (what
      the field actually runs); prefer the latter, and say so where they differ

Gate: a test that is red against a pattern missing `Default<>` and green with
it, driven from a captured vintage rather than inline sources.

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
