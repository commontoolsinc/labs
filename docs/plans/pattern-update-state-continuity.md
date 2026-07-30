# Pattern update state continuity (Tier 2)

Status: In progress. Stages 1–4 are complete and the tier is now a REAL GATE:
`deno task pattern-vintage` runs on every PR, replaying committed vintages of
`system/home.tsx` and `system/default-app.tsx` under the source being merged.
Stage 2 landed as [#5148]; stage 4 as [#5196].

Vintages are now TEST-POPULATED: capture runs a pattern's own tests against a
file-backed store, so the state in a fixture arrived through real handlers, and
a runtime hook records every instantiation the run materialized. Each recorded
root names the artifact it holds and the file that artifact was authored in, so
nested sub-patterns are validated too — coverage they can never get from their
own vintage, having none.

Stage 5 remains: the gate still asserts "the update still APPLIES", not "the
data survives". The fixtures now hold data a change can strand; what is missing
is the VALUE comparison that would notice. Tier 1 — the schema gate — merged as
[#5144].

This plan takes the pattern-update regime from "the contract still type-checks"
to "the new pattern can still read what the old one wrote".

[#5144]: https://github.com/commontoolsinc/labs/pull/5144
[#5148]: https://github.com/commontoolsinc/labs/pull/5148
[#5196]: https://github.com/commontoolsinc/labs/pull/5196

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
| A snapshot of a trivial one-pattern space is **1.5 MiB** raw | measured; it is the floor, since the store carries compiled artifacts |
| Real patterns are larger raw but COMPRESS 15-48x | measured: `home.tsx` 3.50 MiB raw / 226 KiB gzipped; `favorites-manager.tsx` 1.53 MiB / 32 KiB. A store is mostly slack — 99 revisions in 3.5 MiB — which is why the retention decision below was made on the wrong number |
| The gate catches a real break, not just a synthetic one | measured by mutation on the ACTUAL `home.tsx`: adding a required defaultless output field makes `deno task pattern-vintage` exit 1 naming the field; restoring returns exit 0 |
| The gate does NOT catch a moved storage key | measured by mutation on the ACTUAL `home.tsx`: `.for("favorites")` → `.for("favouriteList")` exits 0. The replay compares no values — which, now that a captured vintage holds real handler-written data, is the whole of the remaining gap. Pinned as a limit in `tasks/pattern-vintage-run.test.ts`; the class itself is covered by `state-continuity.test.ts` over a populated vintage. Closing it in the gate is stage 5 |
| The gate could exit 0 having replayed NOTHING | measured twice: a `home.tsx` that does not compile, and a truncated fixture, both leave `harness.resolve()`'s promise pending forever while the error surfaces as an unhandled rejection — `main` never reached a verdict, the event loop drained, and the process exited 0 printing no verdict at all. Fixed: `beforeunload` is the last point where that is still distinguishable from success, so it reports and exits 1. Re-measured after the fix: broken source exits 1 naming the rejection, corrupt fixture exits 1, clean tree exits 0 |
| A run that replays zero fixtures is a FAILURE | `isClean` takes `replayed` and requires it positive. Measured: with the fixture tree moved aside the task exits 1 reporting both the uncovered patterns and "covered NOTHING" |
| A fixture that does not RESTORE would have read green | measured: an empty store presents to the runtime as a fresh space, today's source materializes onto a fresh space, the root reads as something, and every check the replay makes passes while nothing was replayed. Fixed by two controls, both BEFORE any candidate is applied: the fixture must hold a captured root at all, and its manifest must contain the identity its filename records — so a fixture restored from the wrong file, or renamed, says so instead of replaying under a version it never came from. Red/green: with the first disabled, that case is the only one in `pattern-vintage-run.test.ts` that fails |
| The committed fixtures really do restore, and their names are provenance | the same controls, run against them: both replay clean, so each fixture contains the identity its filename records |
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

**Every capture lives in git. DECIDED — this reverses the original split.**
Auto captures were to live in CI artifacts because "at ~1.5 MB a floor,
committing every capture would grow the repo without bound". That number was
wrong, and measuring it properly reversed the conclusion.

Stored RAW, a capture costs git **~9 KiB per generation** against a 3.5 MiB
file (see the cross-generation table below), because git's packfile delta
search runs across the whole repository and adjacent generations of a
near-identical store delta almost perfectly. A hundred generations of
`home.tsx` is on the order of a megabyte of history. The artifact machinery —
upload, fetch, retention-by-count, a pruner that cannot reach `pinned/` —
existed to avoid a cost that is not there.

So: captures are committed, under the same append-only discipline as pinned
vintages and Tier 1's baselines — though only Tier 1's is mechanically checked;
for vintages the discipline is the command's refusal to overwrite plus review of
the diff, which is a deliberate choice to operate on trust rather than a gap to
close. That deletes a whole apparatus from stage 4.

What survives the reversal is a DIFFERENT constraint with a different
threshold, and it should be argued on its own terms rather than inherited:
**working-tree disk**. Every fixture is 3.5 MiB uncompressed in every checkout,
where its history cost is ~9 KiB. If a retention rule survives, it bounds
CHECKOUTS, not history — and it must still be structurally unable to reach a
pinned vintage.

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
- The runtime that WRITES a fixture is torn down before the snapshot, and that
  takes a `dispose({ closeStorage: false })` to express: the store belongs to
  the capture, which needs it open to flush, so the runner cannot use a plain
  `dispose()`. What it buys over the per-step `idle()`/`synced()` is the
  background work that lives OUTSIDE the scheduler — `patternUpdater`'s source
  checks and the runner's pointer-commit roll-forwards, which no settle covers.
  Measured on both required fixtures: quiescing the writer at the snapshot point
  runs no further scheduler action and adds no commit, so this is the contract
  made structural rather than a bug fixed. It matters because the alternative is
  a snapshot whose completeness depends on which of two runtimes won a race, and
  the tier's whole claim is that a fixture holds a state the pattern reached.

On `setPattern` versus `PatternUpdater`: the replay drives the updater's path,
because that is what the field actually runs. The difference is the whole
reason this regime is CI-only — `cf piece setsrc` calls
`assertPatternSchemasBackwardCompatible` and refuses on failure, while the
automatic updater performs no structural check at all.

### 3. Curated vintages in git

- [x] `packages/piece/test/vintages/<pattern key>/pinned/<iso>-<identity>.sqlite`,
      labelled by the pattern identity that wrote it (provenance, not an
      address — nothing looks a fixture up by it; the replay enumerates the
      directory). **Not** under `packages/patterns/`, though the key is a path
      relative to it: `build-binaries.ts` hands that whole directory to
      `deno compile --include`, which is recursive over non-source files
      (measured; neither `deno.json`'s `exclude` nor `.denoignore` filters it),
      so fixtures would ship inside the toolshed binary and grow it with every
      stage-4 capture — and `PatternsServer` serves the same directory by path,
      so they would be fetchable from any deployment
- [x] Seed the auto-updating patterns from today's source
- [x] Assert every REQUIRED pattern has a vintage, and replay every vintage
      that exists under today's source
- [x] `deno task pattern-vintage` wired into CI

Gate: **met, and verified by mutation.** Adding a required, defaultless output
field to the real `home.tsx` makes the task exit 1 with the estuary rejection
naming the field; restoring it returns exit 0.

**What a green run does and does not assert.** Per fixture it asserts that the
vintage RESTORED — its root already carries the identity the filename records,
checked before anything is applied — that today's source resolves, that the
setup commit carrying it onto that root is not refused, and that the root then
reads as something rather than nothing. The restore control is not ceremony: an
empty or truncated store presents as a fresh space, today's source materializes
onto a fresh space, and without it every remaining check passes while nothing
has been replayed. It compares no VALUES, though — and that is now the only
reason, since a captured vintage holds real data written through real handlers.
So the storage-move class — the one this tier
was built for — replays clean here: measured on the real `home.tsx`, renaming
`.for("favorites")` to `.for("favouriteList")` exits 0. That is pinned as a
limit in `tasks/pattern-vintage-run.test.ts`, covered as a behaviour by
`state-continuity.test.ts` over a populated vintage, and listed in stage 5 as
the thing to close. Until it is closed, this gate's honest claim is "the update
still APPLIES", not "the data survives".

**A run that reaches no verdict is a failure.** The first version of this gate
could exit 0 having replayed nothing and printed nothing: a pattern that fails
to compile, and a corrupt fixture, both reject a promise nobody awaits while
`harness.resolve()`'s own promise never settles, so the event loop drained with
`main` still mid-flight. A `beforeunload` guard now reports the last rejection
and exits 1, and `isClean` takes `replayed` so zero replays cannot be a pass.
`unmappedPatternUrls` covers the third shape of the same failure: a
`HOME_PATTERN_URL` that stopped containing `/patterns/` would derive an empty
required set and quietly stop insisting on anything.

**Scope is what provably auto-updates**, derived from `HOME_PATTERN_URL` and
`DEFAULT_APP_PATTERN_URL` rather than a hand-kept list, so the gate cannot
drift from the runtime. This plan previously said "every
`packages/patterns/system/**` pattern"; that over-reached. The directory also
holds personal variants (`*-ben.tsx`) and modules that are not patterns
(`piece-registry-migration.ts`), and a first attempt at requiring all 23 wedged
on a file with no default export. A vintage that EXISTS is always replayed;
the required list only governs what CI insists on. Pinning a profile or other
long-lived pattern is a deliberate act, and is spelled
`deno task pattern-vintage --update <pattern key>` — named keys are captured
under the same only-ever-ADD rule as the required ones.

**Fixtures are stored RAW, and both size arguments this plan reasoned from were
wrong.** A store is mostly slack — 99 revisions in 3.5 MiB — and gzips 15-48x
(`home.tsx` 3.50 MiB / 226 KiB; `favorites-manager.tsx` 1.53 MiB / 32 KiB), so
pre-compressing looks free given git zlib-compresses blobs anyway.

Measured, it is not free: **it defeats git's DELTA compression**, which is the
mechanism that makes accumulating vintages cheap.

Two captures of `home.tsx`, each committed into a fresh repo (`git init`, add,
commit, `git gc`) and read off `git count-objects -vH`:

| Storage | git, 1 vintage | git, 2 captures | working tree, 2 captures |
| --- | --- | --- | --- |
| Raw `.sqlite` | 232.50 KiB | **232.86 KiB** (+0.36) | 7.00 MiB |
| Gzipped, level 9 | 240.30 KiB | 260.92 KiB (+21) | 484 KiB |
| Gzipped, level 6 | 225.59 KiB | 449.53 KiB (+224) | 452 KiB |

Method: `git init`, add, commit, `git gc`, `git count-objects -vH` size-pack.
Two INDEPENDENT captures of `home.tsx`, not a perturbed copy — a one-byte
perturbation flatters delta compression and was measured first by mistake.

A second raw vintage costs essentially nothing; git deltas it against the
first. A second gzipped one costs between +21 KiB and the entire file
depending on the compression LEVEL — level 6 (what `CompressionStream` emits)
deltas not at all, level 9 partially. That instability is itself an argument
for raw: its delta behaviour is predictable, where gzip's swings tenfold on a
setting nobody would think to hold constant. Two different patterns gzipped
delta not at all either (+249 KiB).

**Across generations, which is what stage 4 actually accumulates.** Four
captures of `home.tsx`, each after a real pattern change, each its own commit;
pack size after each:

| After | Raw `.sqlite` | Gzipped, level 6 |
| --- | --- | --- |
| gen 1 | 232.50 KiB | 225.87 KiB |
| gen 2 | 241.11 KiB (+8.6) | 451.52 KiB (+225.7) |
| gen 3 | 249.75 KiB (+8.6) | 677.19 KiB (+225.7) |
| gen 4 | 259.46 KiB (+9.7) | 904.89 KiB (+227.7) |

Raw costs ~9 KiB a generation against a 3.5 MiB file; gzipped costs the whole
file again every time. Git's packfile delta search runs across the WHOLE repo,
not within a commit, so adjacent generations of a near-identical SQLite store
delta almost perfectly. Compressing ourselves pre-empts that with a worse
scheme — worse because it is per-file where git's is cross-file.

No custom append/chunk format is warranted: packfile delta already is that
mechanism, content-addressed, and a bespoke one would need its own reader,
pruner and corruption handling while breaking the property that chose SQLite
over a JSON dump — restore is a single `Deno.copyFile`.

Two caveats. WORKING-TREE disk is the real price (3.5 MiB a generation
uncompressed), so retention bounds checkouts rather than history. And git's
delta chain depth (default 50) means growth is ~9 KiB a generation with a
periodic full-size restart.

Stage 4's whole job is accumulating vintages, so the compounding term
dominates the one-off. The price
is working-tree disk (3.5 MiB a fixture rather than 226 KiB), which is transient
and local where git history is permanent and shared by everyone who clones.

An earlier revision reported 352/352 and 360/380 KiB. Those measured `du -sk
.git`, which reproduces exactly but overstates by ~120 KiB of git overhead
(config, hooks, refs) that is not blob storage. `count-objects` is the honest
metric and is used above. They are corrected rather than
patched; the direction they were used to argue survives, and is larger than
they showed.

Two constraints the harness imposes, both measured:

- **A cross-DID restore is fine — corrected.** An earlier revision claimed a
  vintage captured under one DID and restored under another reads EMPTY, which
  would be a false positive on the gate (emptiness is this tier's stranding
  signal). **It does not reproduce.** Capture under signer A, restore under
  signer B, replay reads `["alpha","beta"]` with no error. The capturing DID is
  embedded — 16 occurrences in a 1.5 MiB snapshot — but is not load-bearing for
  the read path, because a root is addressed by cause alone and the space is
  whichever file the server opens. The task still uses a fixed signer, for
  reproducibility rather than correctness.

  Still untested: a label lowering `CurrentPrincipal` names the capturing
  space, so an owner-scoped label may behave differently across DIDs.
- **One root key per pattern.** Roots are addressed by cause and the cause
  alone determines the entity id, so a fixture holding two patterns needs two
  keys (`vintageRoot(vintage, schema, key)`). One fixture per pattern needs
  nothing further.

Three bugs the gate found in itself, all now pinned by tests, all of the class
that fails SILENTLY rather than loudly — which for a gate means passing:

- **Identities are base64url and contain dashes.** Parsing the identity as the
  last dash-separated field split `home.tsx`'s own filename in the wrong place,
  so the gate did not recognise the fixture it had just written and reported the
  pattern as uncovered with the file sitting right there. Anchored on the
  stamp's fixed shape now — both fields contain dashes, so only that is a
  reliable boundary.
- **`Deno.readDir` is lazy**, so a try/catch around the call alone caught
  nothing and a missing tree escaped as ENOENT instead of "no fixtures yet".
- **Ending without a verdict counted as passing.** The worst of the three,
  because the two inputs that trigger it — a pattern that does not compile, and
  a corrupt fixture — are exactly when you most want a red. Both reject a
  promise nobody awaits while the promise the replay is awaiting never settles,
  so the process exited 0 with no output at all. A `beforeunload` guard now
  reports the last rejection and exits 1, `isClean` requires a positive
  `replayed`, and a system pattern URL that no longer derives a key stops the
  run rather than emptying the requirement.

### 4. Test-populated vintages, captured per generation, in git

The vintages stage 3 seeds are captured straight off setup, so they hold a
freshly materialized root and **no data**. That is why the gate can only assert
"the update still applies" — there is nothing in the fixture for a change to
strand. This stage fixes the fixture rather than the gate.

A vintage becomes **a fresh database with that generation's pattern tests
having run on it**. Not one root database migrated forward: each generation
captures its own, seeded by the tests as they stood at that version. The
fixture set is then a series of independent snapshots of what version N's world
looked like, and the question the gate asks is whether today's source can take
each of them forward.

That the databases are independent is the point, not an implementation detail.
A single lineage carried forward would have every later generation already
shaped by every migration that touched it, so the one thing the gate wants to
test — reading state written by a version that knew nothing about today's — is
exactly what a migrated-forward database no longer holds.

- [x] Give `runTestPattern` an injection point for its storage manager. It
      hard-codes `StorageManager.emulate` (`test-runner.ts` ~:988), which runs
      against `:memory:` — there is no file to snapshot.
- [x] Let the caller pin the test's result cause. The runner causes it
      `test-pattern-result-${Date.now()}`, which is fine for a store that is
      thrown away and fatal for one that is kept: an id that differs every run
      cannot be addressed again.
- [x] **Record every pattern instantiation and its result cell**, via a runtime
      hook, and persist the log INSIDE the store under a reserved cause. See
      "finding the update targets" below — this is the part that was tried the
      obvious way first and failed.
- [x] Capture by running a pattern's OWN tests against a file-backed store,
      then snapshotting. Pattern tests are themselves patterns
      (`home.test.tsx` instantiates `Home({})` and drives it with
      `action()`/`assert()`), so the state they produce is real pattern state
      written through real handlers.
- [x] Replay by applying today's PATTERN to EVERY recorded instantiation, and
      report the count. Resolved on implementation: the soundness floor is
      CANDIDATES, not `updated`. "Updated 0" IS a legitimate success — no
      pattern changed, which is the common case and the same condition the
      auto-updater fires on — whereas zero candidates means no update target
      was examined at all. `isClean` requires `candidates > 0`, and the run
      prints candidates / changed / updated separately so the three can never
      be read as one number.
- [x] Make the replay path REFUSE a `*.test.tsx` entry, with its own case in
      `pattern-vintage-run.test.ts`. See the invariant below: a test pattern
      creates stores and is never an upgrade target, and this is the guard that
      keeps that from being merely written down.
- [ ] Capture on identity change, committed — not uploaded as an artifact
      (see the decision above).
- [ ] Retention, if any, weighed as LOST COVERAGE against working-tree disk —
      not applied as housekeeping, and still structurally unable to reach
      `pinned/`.

**INVARIANT: a test pattern creates stores. It is never an upgrade target.**

The test pattern's whole role is to produce a fresh, populated store for later
rounds to upgrade. It is a capture-time tool and must never appear on the replay
side. The upgrade always applies **the pattern**, never the test that exercised
it.

Enforce this mechanically rather than by comment. The replay path must REFUSE a
program whose entry resolves to a `*.test.tsx`, and the refusal needs its own
case in `pattern-vintage-run.test.ts`. Prose is what failed the first time:
"don't take that shortcut" was already the plan's wording when the shortcut got
taken anyway, because at the moment of writing the code it looks like the
obvious way to reach the root.

Why it is wrong, measured rather than argued: a test-populated store puts the
TEST pattern at the top, with the pattern under test a nested instance
(`Home({})`) that has no stable id. Applying today's test pattern there **makes
the gate weaker** — the additive-required break that stage 3 catches (exit 1,
naming the field) exits 0, because materializing the test pattern never re-runs
the CFC schema merge against the inner pattern's own stored envelope. The gate
keeps reporting success while checking nothing, which is this tier's worst
failure mode and the third time it has appeared in this work.

Three ways to get the targets were compared:

1. *Tests declare them* — every test returns its instantiated patterns as
   update targets. Rejected: churn across every test plus the test-authoring
   skill, and its failure mode is SILENT. A test that forgets to declare
   reduces coverage invisibly, which is the exact shape that has bitten this
   work twice.
2. *Scan the restored store.* `setupInternal` already stamps `patternIdentity`
   on the result cell of every instantiated pattern that has an entry ref
   (`runner.ts:1512`), and `run()` routes through it (`:2739`) — so pattern
   roots are self-labelling and no graph traversal is needed. But there is **no
   sanctioned way to enumerate them**: the `_` wildcard selector survives only
   as an optional field in `Select<>` and two comments in
   `memory/interface.ts`, with no implementation anywhere; and
   `SpaceSession.sqliteQuery` reaches a CELL-derived db (the sqlite-builtin
   feature), not the space store's own tables. Enumerating means reading `head`
   directly AND decoding the metadata encoding.
3. *Runtime hook* — record instantiations as they happen. **Chosen.** The
   absence of an enumeration API is what decides it: the hook buys access, not
   merely a second copy of what the store already knows.

The log is persisted **inside the store** under a reserved cause rather than as
a sidecar file. A sidecar would be a second artifact that can drift from the
state it describes and would need its own append-only discipline; an in-store
doc travels in the same file, is copied atomically with the state, and keeps
"restore is a single `Deno.copyFile`" true. The cost is one doc in the fixture
that no pattern wrote — acceptable for a fixture, provided it is namespaced so
it can never collide with pattern state.

Record ALL invocations and try updating all of them. That turns a selection
problem into a coverage bonus: a nested pattern's migration gets validated too,
which is coverage it would otherwise never have, since nested patterns have no
vintages of their own. An instantiation that legitimately cannot be updated
fails CLOSED and is reported as a finding rather than skipped.

A fixture captured before the hook existed records no instantiations, and the
replay REFUSES it by name rather than reading it clean — the two committed
vintages were recaptured on that basis. Option 2 remains the documented route
for a deep vintage that could not be recaptured; nothing implements it, and a
manifest carries no version field, so a change to its shape forces the same
recapture again.

Gate: a vintage contains data a change can strand, so stage 5's value
comparison has something to compare, and every change is checked against every
world ever captured.

**The cycle — DECIDED.** Per change:

1. Run the current tests against a file-backed store → a new database.
2. Apply the CURRENT pattern to **every prior** database. All must succeed.
3. Commit the new database, so future changes are validated against it too.

That makes the fixture set an accumulating regression corpus rather than a spot
check: every change is tested against every version of the world that has ever
been captured, not just the most recent one.

**Step 2 does not write back.** "Update all prior databases" means apply and
verify, on a scratch copy; the committed vintage is never the upgraded result.
Writing back would rebuild the single lineage this design exists to avoid —
each vintage would carry every migration since, and would no longer be state
written by a version that knew nothing about today's. It would also break
append-only: an upgrade that silently succeeded would overwrite the very
fixture that would have caught the next break.

Two consequences of validating against ALL prior vintages, both bounded but
worth naming before they bite:

- **Cost is O(N) per CI run.** A replay is ~1-2s, so 50 generations is under
  two minutes and 200 needs sharding — `pattern-compat`'s 4-way split is the
  precedent, and the work is already per-fixture so it shards trivially.
- **Retention now REMOVES coverage**, which inverts its meaning from stage 3.
  Pruning a prior vintage deletes a regression the corpus was carrying. Git
  cost is ~9 KiB a generation, so history is not the reason to prune;
  working-tree disk (3.5 MiB a fixture, uncompressed, in every checkout) is the
  only pressure, and it should be weighed against losing coverage rather than
  applied as housekeeping.

### 5. Value comparison, and migration coverage

With stage 4's fixtures holding real data, the gate can finally ask the
question it is named for.

- [ ] **Compare VALUES on replay**, not just "was the commit refused". Both
      halves are needed and neither is sufficient: a vintage with no data has
      nothing to strand, and a replay that only checks for a refusal would not
      notice if it did. Inverting the pinned limit in
      `tasks/pattern-vintage-run.test.ts` — the case that currently asserts a
      moved `.for()` key goes UNCAUGHT — is the acceptance test.
- [ ] Replay the vintage's OWN source first as a control, so an empty read is
      attributable to the change rather than to a fixture that never restored.
      `state-continuity.test.ts` shows the shape, and stage 3 already learned
      this the hard way: an unrestored fixture reads exactly like a stranded
      one.
- [ ] Trigger on memory-engine schema change; promote the affected captures to
      pinned rather than recapturing, since a dump regenerated after a
      migration proves nothing — the pre-migration state is the artifact.
- [ ] Breadth across shapes rather than depth per pattern, since the selection
      rule here is a memory change rather than a pattern change.

Gate: a change that strands data fails even when it applies cleanly, and a
memory migration cannot land without replaying pre-migration stores.

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
