# Independent reference labels: retiring the carried target view and the `LinkReference` atom

_Proposed 2026-10-12. No stage is in place; stage 1 is in flight as a separate
change. Each stage below says what it depends on and what lands with it._

## What this plan holds to

The specification settled what a reference carries in `cfc/08-02-pass-through-via-references.md`
(§8.2) and `cfc/08-12-store-label-monotonicity.md` (§8.12.8). A reference is
independently labeled data. Its label is the join of how the reference was
acquired and what the creating attempt observed (§8.2.3: identity and
acquisition restrictions, plus the attempt's conservative observation and
control join, triggers included). The target's content labels stay on the
target and are consumed when the target is read through the reference
(§8.2.4): confidentiality of a dereference is the reference restriction
conjoined with the target's current labels; integrity is the target's current
integrity plus the reference's still-applicable scoped endorsements. The
link-carried component a slot persists is "the reference's own
identity/acquisition restrictions and validated reference provenance; excludes
target-content labels and target-evidence caches" (§8.12.8), and it is replaced
when the reference at the slot is rewritten.

A runtime may instead add historical target restrictions to the reference
label, but only as a declared over-approximation, and that posture "is not the
precise reference profile" (§8.2.5). The runtime in this repository is in that
posture without declaring it: `derivePersistedLinkLabel` in
`packages/runner/src/cfc/prepare.ts` joins the source path's stored label into
the link entry, and `persistedLinkEntries` persists every source entry at or
below the source path, rebased under the slot. `docs/specs/cfc-conformance-statement.md`
says the precise profile is not claimed; nothing says the over-approximation is
in force. This plan moves the runtime to the specified contract, and then
removes the atom that the over-approximation left behind.

## The atom and what reads it

Every link write mints a `LinkReference` integrity atom naming the pointee and
the slot (`linkReferenceIntegrity` in `prepare.ts`), and a second mint site adds
one to the writer's value stamp at a slot the runtime recorded storing a
reference at. The atom restates the link value beside it: for an entry at a
slot, its `source` is the link stored there and its `target` is the document
plus the entry's own path. The specification itself says what this proves:
"Merely recording 'this reference was written' proves no semantic property"
(§3.7.2). The runtime classifies it accordingly: its fields are
"display/provenance only; nothing dereferences the persisted copy"
(`cfc/label-field-classification.ts`), it never gates a `requiredIntegrity`
write (`STRUCTURAL_LINK_PROVENANCE_ATOM_TYPES`), and it never enters the
hereditary meet.

Two readers depend on it, and both exist because of something else:

- `stampNamesReference` and `slotStampDescribesAnother`, which
  `followedReferenceWitnesses` consults. They decide whether a writer's value
  stamp at a slot describes the reference the slot holds now. The question
  arises because an append commits as a tail-relative operation that the server
  places at the list's live tail, while the label envelope the appending
  transaction wrote is positional and describes the list as the transaction saw
  it. Under concurrent appends the envelope written last describes one element
  at the position another took. The atom lets the witness pass refuse a stamp
  that sits beside another writer's reference. It does not put the labels at
  the right positions: the element the server moved to the tail is left with
  no slot entry at all, and the slot it was described at carries another
  writer's label. That is an under-taint of "which reference sits at this slot"
  that stage 2 closes at the append, after which the guard has nothing to
  guard.
- The root entry at every accepted link. `persistedLinkEntries` keeps an entry
  only when its label has values, and for a link to an unlabeled source by an
  attempt with an empty join, the atom is the only value. The entry exists to
  hold the atom. With the slot carrying the creation join, a slot with nothing
  to say persists nothing, and every consumer of a missing link entry already
  reads it as "no restriction".

The carried descendants, which the atom's `target` field exists to address
once copied away from their origin, are what stage 1 removes.

## What a link slot persists after this plan

One entry at the slot, and nothing beneath it:

- `origin: "link"`, `observes: "followRef"`, replaced when the pointer at the
  slot is rewritten and cleared when an ancestor overwrite removes the pointer
  (§8.12.8, as `linkEntrySuperseded` already does).
- Confidentiality: the join of the creating attempt's flow join (its reads, PC
  and triggers), the link schema's declared confidentiality, and the
  acquisition restriction the written handle carries (the root of its
  `cfcLabelView`, which is what `referenceRestrictionsOf` in
  `cfc/label-view-state.ts` already extracts for a dereference).
- Integrity: the link schema's integrity after `gateRuntimeMintedIntegrity`,
  and the writer's own value stamp where the flow stage mints one. No
  `LinkReference`.

A dereference composes the slot's restriction with the target's own labels.
That is already how `cfcLabelViewForDereference` builds a label view and how
the flow join's `followRef` probe consumes the followed slot; neither reads the
copies beneath the slot. A link write no longer reads the source document's
stored envelope at all unless an assertion about linked content (a write floor,
an exact-copy claim) needs the source's evidence, which `verifyWriteFloor`
resolves through the link resolver against the current source and keeps doing.

## Stages

### Stage 1: a link write persists its own label, not the target's (in flight)

A separate change is landing this. What the later stages depend on it leaving
behind:

- `derivePersistedLinkLabel` no longer joins the source path's stored label or
  projects the source view; `persistedLinkEntries` persists the slot entry
  alone. `createLinkLabelDeriver`'s pending-source walk, which follows links
  staged into the source in the same transaction to project their views, is
  reduced to what a staged reference's acquisition needs.
- The slot entry carries the creating attempt's join. Today a link-covered path
  is skipped by the flow stamp because "the link machinery attaches the
  source's own label at those paths"; with no source label attached, the join
  lands at the slot as the link entry's confidentiality. The wildcard `*`
  templates a coordinator mints at a pure-link container already carry the join
  to its children, so coordinator slots change little; a single link written by
  a handler newly carries the handler's join on pointer reads, which is the
  §8.2.3 precision the contract asks for.
- The live documents that describe the copy are rewritten:
  `docs/specs/cfc-cross-space-integrity.md` (its premise that a reference
  carries the label across a space boundary becomes: a reference carries its
  own restriction, and the target's labels are consulted at dereference),
  `docs/specs/cfc-observation-classes.md` ("Label views across a link"),
  `docs/specs/cfc-label-metadata-confidentiality.md`, and the conformance
  statement, which stops needing the over-approximation that was never
  declared.
- The tests that pin copying are reshaped, not deleted:
  `cfc-cross-space-integrity.test.ts` scenarios 1c, 3b, 3d and 3e;
  `cfc-list-link-labels.test.ts`, whose "labels of a linked element at its
  position" become "the labels at a position are the creation label, and the
  element's labels are read at the element"; `cfc-link-integrity-gate.test.ts`.
  Two §8.2 scenarios are added as the contract's own tests: a publicly acquired
  reference to confidential content stays public on identity reads and is
  denied on content; a private selection among public targets labels the
  pointer with the selection.

Acceptance for stage 1: the first-run commit of the thirty-row fabrichat room
(the capture `docs/plans/resume-presync-cost.md` tracks) writes no `["array",
k]` entry on any row's argument document, and the staged-reference diamond
probe of
`docs/history/development/performance/2026-09-25-staged-reference-cache/README.md`
prepares a map whose entry count is the number of references, not the number
of root-to-leaf paths.

### Stage 2: a label envelope describes the document it commits into

Depends on nothing; can land beside stage 1.

The envelope a transaction writes at the document's reserved position is a
whole-member replace, computed against the list the transaction read. The
mergeable tail operation beside it is resolved by the server against the live
list. Two concurrent labeled appends both commit today, and the later envelope
describes the earlier list. The fix is that a commit whose document envelope
moved under it conflicts and retries, the way a whole-value write to the same
document already does. The handler re-runs against the live list, the append is
re-recorded as a tail operation, and preparation stamps the live position. The
tail operation stays mergeable; what stops merging is a stale envelope. The
seam is the memory engine's conflict decision for the reserved position when
the commit's other operations on the document are mergeable; confirm it with
the existing `packages/memory/test/v2*.test.ts` conflict suites before
changing it, and record the retry cost on the chat-room workload (every
message append under persisted flow labels is a labeled append).

With that in place, a value stamp at a slot describes the value the slot holds
in the committed document. `cfc-transformed-by-input-witness-concurrent-append.test.ts`
is reshaped so that each scenario asserts the stamps' positions after the
retry rather than the guard's refusal; the "copied reference" attack is still
refused, because the slot holding the copy carries the attacker's stamp, not
the submit step's.

If the retry cost on contended lists proves too high, the follow-on is an
append operation that carries the entries for the elements it appends,
relative to the operation, which the server places with them. That is a
memory protocol change and a specs change to §4.6.4; it is not needed for this
plan's correctness.

### Stage 3: the specification retires the atom

Depends on stages 1 and 2 being understood, not on their landing; a ruling
can be sought in parallel. This is a semantic gap under
`docs/development/cfc-spec-correspondence.md`, filed as a ruling in the form
of `cfc/13-11-decisions.md`:

- `cfc/15-atom-registry.md` §15.4: remove the `LinkReference` row, or keep it
  marked as a legacy atom no conforming runtime mints. "The only evidence atom
  a link write may legitimately mint" becomes "a link write mints no evidence
  atom; the writer's scoped endorsement is its value stamp (§3.7.2)".
- `cfc/08-15-write-authority.md` §8.15.4 item 3: a staged reference "carries at
  most the reference provenance a link write may mint" becomes "carries the
  staging attempt's reference restriction and its writer's stamp, and no
  claim about the entry's content".
- `cfc/08-12-store-label-monotonicity.md` §8.12.8: "validated reference
  provenance" in the link-carried row is stated as the writer's scoped
  endorsement persisted at the slot, so that nothing in the row names an atom.
- A sentence under §8.10.2 or §15's `TransformedBy` row stating the invariant
  stage 2 establishes: a value stamp persisted at a slot describes the value
  the committed document holds there, and a runtime whose storage can move a
  written element after the stamp was computed must re-derive the stamp.
- Legacy: the §18.7 rule that unresolved legacy mixtures stay conservatively
  restricted already covers confidentiality. For integrity, the ruling adds
  that a value stamp at a reference slot persisted before the invariant held
  is not input-witness evidence.

The Lean development needs no new theorem: `StoreComponents.linkCarried` is a
label, `Reference.create` takes endorsements as a separate list, and nothing
mechanizes the atom. The ruling's correspondence note says so.

### Stage 4: the runtime stops minting and reading the atom (labs companion)

Depends on stages 2 and 3.

- Remove the two mint sites (`linkReferenceIntegrity` and the `rootReferences`
  addition in the flow persist), `recordedReferences`, `stampNamesReference`,
  `slotStampDescribesAnother`, and the `LinkReference` rows of
  `STRUCTURAL_LINK_PROVENANCE_ATOM_TYPES`, `RUNTIME_MINTED_INTEGRITY_ATOM_TYPES`,
  `cfc/atom-classes.ts` and `cfc/label-field-classification.ts`. The
  cross-space persist transform has one fewer commitment field; its tests in
  `cfc-label-metadata-protection.test.ts` drop the atom case.
- `followedReferenceWitnesses` keeps the value stamps that resolve at the slot
  and withholds nothing by binding. The legacy rule from stage 3 is applied
  where an envelope is re-persisted: a carried-forward value stamp at a slot
  holding a reference that still carries a `LinkReference` not naming the
  slot's current pointer, or that carries none and predates the stage 2
  runtime, loses its `TransformedBy` and keeps its confidentiality. The
  envelope version is the vintage; a bump to version 3 marks envelopes written
  under the invariant, and `cfc/metadata.ts` reads all three.
- `packages/api/cfc.ts` keeps the constant for one release so stored legacy
  atoms display under their name in `cf label`; the pattern-facing ambient
  type in `packages/static/assets/types/cfc.ts` drops it, since no pattern can
  mint it or require it. `atomPropagationClass` already reads an unregistered
  atom as value-bound, so a legacy atom in a stored label is inert.
- The thirteen test files naming the atom are updated; the ones that only use
  it as a stand-in for "some runtime-minted atom"
  (`cfc-required-integrity-provenance.test.ts`, the benches) switch to
  `Origin`.
- Live documents: `docs/specs/cfc-transformed-by-input-witnesses.md`,
  `docs/specs/cfc-observation-classes.md` §6.1 (the comment that "the
  integrity evidence is the LinkReference chain" goes with the code comment at
  the `followRef` branch of `deriveFlowJoin`),
  `docs/specs/cfc-protected-initialization.md`,
  `docs/development/EXPERIMENTAL_OPTIONS.md`. `docs/specs/cfc-spec-changes.md`
  is frozen and is left alone.
- `deno task cfc-spec-snapshot` after the specs ruling merges, and the
  manifest rows that moved.

### Stage 5: a handle carries its acquisition, not the target's labels

Depends on stage 1; independent of stages 2 to 4.

The `cfcLabelView` a handle carries into a link write is built in
`packages/runner/src/data-updating.ts` (`cfcLabelViewForPrimitiveLink`, the
carried view on `set`) and `packages/runner/src/schema-view.ts`
(`createOpaqueReference`, `readChild`, the rebase on narrowing) from the label
view of the read that produced the handle, which is the target's labels at read
time. Under the contract that view is the acquisition restriction: the
confidentiality of the slot the handle was read from and of the query or
selection that produced it. This stage narrows what a handle carries to
`referenceRestrictionsOf` of the read's view plus the reading attempt's join,
so that a handle obtained from a query result under a secret filter carries the
filter and nothing else, and a handle read from a public slot carries nothing.
It is the part of this work that reaches outside `cfc/`: query-result proxies,
lazy reads, immutable containers holding references, and worker reference
tokens each build or forward a view. Each is changed with its own test, and the
stage is measured on the room capture separately from stage 1, since stage 1
already removes the persisted copies and this stage removes what a handle
holds in memory and sends over IPC.

### Stage 6: retire what the copying made necessary

Depends on stage 1's acceptance measurement.

`docs/plans/compact-cfc-label-maps.md` proposes a shared-subtree label map to
bound the exponential growth of staged-reference diamonds. The growth is the
copy; with stage 1 a diamond's map holds one entry per reference. Archive that
plan to `docs/history/plans/` as superseded once the diamond probe confirms the
bound, with the measurement linked from the archive note.

## Legacy data

No migration runs. A link entry persisted under the over-approximation carries
the target's labels of its day; the specification admits that as a
conservative restriction (§8.2.5, §18.7), and it is replaced the first time the
pointer at its slot is rewritten (§8.12.8), which the persist loop already does
through `linkEntrySuperseded`. The carried descendants beneath a legacy slot
clear with it. A reader that follows a legacy link composes the stale
restriction with the target's current labels, which over-taints and never
under-taints. The only data rule is the one stage 3 states for input
witnesses, applied lazily where an envelope is re-persisted. No Home contract
changes, no readiness marker, no admission gate.

## Measurements and gates

Before stage 1 and after each of stages 1, 2 and 5, on the same checkout:

| Probe | What it measures |
|---|---|
| The thirty-row room's first-run commit (`commit288.json` capture, or a fresh capture through `seed-room.ts`) | Per-row label-map bytes and entry count; today 36 KB of a 40 KB row and 85 entries, 63 of them copies and 16 KB of them atoms |
| The staged-reference diamond probe at depths 8, 10 and 12 | Prepared entry count and serialized bytes; today 24,560 entries and about 3 MB at depth 12 |
| `cfc-prepare-ladder.bench.ts`, `cfc-staged-reference.bench.ts`, `cfc-input-witness.bench.ts` | Preparation time; the `authoritativeCoverCalls` and `stagedReferenceDerivations` work counters should fall to the number of links written |
| The `cfc*` pattern integration tests and the CFC demos under `packages/patterns` | Refusals that appear because a pointer read newly carries its writer's join; each one is either the contract working or a coordinator whose read should carry the wiring marker of §18.6.2 |

The usual gates apply: `deno task check`, `deno task check-cfc-correspondence`
(the `§` citations the removed code carried go with it), `deno task
check-docs`, and the coverage ratchet on `packages/runner`.

## Pull request 7243

[commonfabric/labs#7243](https://github.com/commonfabric/labs/pull/7243)
implemented the same contract and is not merged. This plan does not rebase it.
What it carries that this plan reuses, lifted by hand:

- its §8.2 scenario tests (public pointer to secret content; private selection
  of public targets; mixed identity read and dereference in one attempt);
- its finding that the reserved position's read must not be filtered by the
  mergeable-write conflict filter, which is stage 2;
- the prose of its `docs/specs/cfc-references.md` as the seed of the live
  document that describes a link slot's label after stage 1.

What it carries that this plan does not take: the version-3 envelope with a
per-slot `referenceAcquisition` marker and the readiness classification built
on it; refusing legacy references in a precise mode; the Home published
contract change and its migration protocol; worker acquisition tokens and the
event dispatch-context version. Each of those follows from treating a legacy
reference as unresolved rather than as a conservative restriction, which the
specification does not require.

## Behavior changes to watch

- A pointer read through a slot written by a handler that read confidential
  data carries that confidentiality, where today it carries the target's. A
  public target reached through such a slot is confidential to read, which is
  §8.2.4; a pattern that relied on the pointer being public needs the handler
  to not have read the secret, not an exemption.
- A pointer read through a slot holding a public reference to a confidential
  target is public, where today it carries the target's label. Content reads
  through it are unchanged.
- A link write to a document whose envelope the transaction cannot read no
  longer refuses with "missing link source metadata"; it needs the source only
  when an assertion about linked content needs it. The retry disposition
  around that refusal in `derivePersistedLinkLabel` goes with it.
- A labeled append to a list another session appended to concurrently retries
  instead of committing a misplaced envelope.
