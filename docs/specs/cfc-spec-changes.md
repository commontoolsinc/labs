# CFC Spec Change List (running)

Changes `~/src/specs/cfc` needs so the spec can answer the questions that came
up while designing implementation work. Started 2026-06-10 during the S16
(default transition) design; intended to grow as later sessions hit new gaps.
Each item: where, what's missing or contradictory, proposed edit. Tags:
[clarify] prose fix, [normative] new requirement/profile text, [reconcile] two
spec passages disagree, [registry] table data.

Status legend: `open` (not yet applied to the spec), `applied`.

## From the S16 default-transition design

**SC-1 [normative] Store labels vs per-value data labels — §8.12 + §4.6.4.** The
biggest gap this design hit. §8.12 makes "store labels" monotonically
non-decreasing; §8.9/§4.6.1 derive per-value labels at every write/recompute;
§4.6.4's persisted `cfc.labels` map never says which of the two it holds, and
§8.12.4 says readers are tainted by "the store's label" as if there were only
one object. Consequence: it's unanswerable from the spec whether a persisted
path label may _decrease_ when the value at that path is overwritten by a
less-tainted computation — i.e. whether the envelope ratchets forever (label
creep) or tracks the current value. Proposed edit: define **label components**
with distinct update disciplines — `declared` store policy (monotone per §8.12;
the thing §8.12.4's reader-taint and writer-fit rules refer to), `derived`
per-value data labels (replace-on-overwrite by the committing attempt's verified
derivation; an ancestor overwrite clears derived descendants), `link/carried`
reference labels (replaced when the reference is rewritten). Effective label at
a path = join of components. State explicitly that derived-component decrease on
value replacement is sound because reads journal labels at read time (§8.12.2's
aliasing rationale concerns the declared policy, not data labels). Update
§4.6.4's envelope to carry the component tag.

**SC-2 [clarify] Stale derived labels — §8.9 (new subsection).** Nothing says
what happens when a _source's_ label grows after an output was derived from it:
the output keeps a point-in-time label that is now lower than a fresh derivation
would produce. State the intended model: derived labels are facts about the
write-time derivation; re-derivation on recompute refreshes them; there is no
retroactive relabeling obligation for cold copies (and if a deployment wants
one, it's a policy-layer sweep, not a runtime invariant).

**SC-3 [normative] Trigger reads for dependency-scheduled reruns — §8.9.2.** The
PC definition includes "trigger or gating reads that determined whether the
handler ran at all" but is written for explicitly-invoked handlers. For a
reactive runtime, define the trigger set of a scheduled rerun: the addresses
whose invalidating writes caused the scheduling, joined at their current labels.
Note the residual channel this closes (~1 bit per change event via write timing
of a rerun that branches away from re-reading the changed input) so implementers
know what skipping it costs.

**SC-4 [clarify] Existence channel under whole-path labels — §4.6.3 or §8.12.**
Until the `shape`/`value`/`iterate` observation classes are implemented, one
label covers all observation kinds at a path; replacing a derived label on
overwrite then also shrinks the _existence_ label, leaving "this path was once
written" as a public bit. Document as a known residual of the phase profile,
fixed by PathLabelTemplate observation classes.

**SC-5 [normative] Bless the prepare/digest factoring — §8.10.1.** The runner
implements the per-attempt verify loop as verify-at-prepare + a canonical-digest
recheck at commit with invalidation on post-prepare activity. Add a conformance
note: this factoring satisfies §8.10.1 iff the digest binds _that verification
ran over exactly this activity_ (not merely that activity matched some
caller-supplied input — the audit's S2 bypass), and any post-prepare read/write
invalidates the preparation. (Already flagged as audit item 2.1/3.2; the S16
design extends the digest to cover staged label-metadata writes, so the
requirement should be stated once, normatively.)

**SC-6 [normative] Relevance predicate / conforming fast path — new §18 profile
text.** The spec assumes boundary verification everywhere; real runtimes need a
skip. Define when skipping is conforming: a transaction whose reads touch no
labeled document (no persisted labels, no carried views), whose writes touch no
labeled document, and which triggers no policy-bearing schema may treat boundary
evaluation as a no-op. Also specify the read-exclusion mirror: runtime-internal
reads (verifier reads, label metadata at `["cfc"]`, program/source text,
content-addressed schema docs) do not enter the consumed set or PC — and note
this is a profile decision that must be revisited when label-metadata
confidentiality (invariant 12) is implemented.

**SC-7 [clarify] Pointwise precision by transaction decomposition — §8.9.1 and
§8.5.** §8.9.1's flow-precision claims assume one boundary observes the whole
collection op. A runtime that runs each element op in its own transaction
reading only that element gets pointwise output labels as a _structural fact_,
with no trust gate needed (the per-element journal simply doesn't contain the
other elements). State that decomposition is the preferred mechanism; trusted
claims exist for runtimes/ops that cannot decompose. Clarify what the
coordinator's own writes (container structure, membership, order, length) must
be tainted by — the container/enumeration observations plus any predicate
outputs it consumed (this also gives the §8.5.6.1 membership taint without
claims). Also note that dependency-structure assertions, if they return, are
expected to originate from static analysis earlier in the pipeline (§14.4.4)
rather than runtime schema metadata — the claim mechanism should not assume
schema embedding is the only carrier. (Implementation note 2026-06-10: claim
minting deleted from the list builtins; the schema key is reserved-and-tolerated
for already-persisted data. The coordinator-write taint is implemented as the
`structure` labelMap component: container nodes of pure-link-structure writes
carry the writing tx's J as exact-path shape labels — joined by reads at the
container path and by recursive ancestor reads, never by reads strictly below —
so the §8.5.6.1 membership/length channel is labeled while per-slot pointer
handling stays clean. Pointer identity at a slot, i.e. WHICH element sits
there observed without dereferencing, remains an SC-4/SC-8 residual.)

**SC-8 [normative] Read-API → observation-class mapping — §4.6.3.** The
primitive read profile defines `shape`/`value`/`enumerate`/`count`/ `followRef`,
but there's no mapping from a concrete runtime's read API to those classes.
Minimal needed now: reading an array whose items resolve to references _without
dereferencing_ consumes container enumeration + per-item shape only — not
element `value`. (This is what makes SC-7's coordinator taint well-defined.) A
fuller table can come with the observation-class implementation.

**SC-9 [normative] Staged conformance for the default transition — §8.9.3 or
§18.** §8.9.3 derives both confidentiality and integrity (TransformedBy +
hereditary meet). An implementation that derives confidentiality only and
attaches _no_ integrity to outputs under-claims integrity, which is sound
(fail-safe) but on its face non-conformant. Bless the staging:
confidentiality-join first; hereditary meet second; TransformedBy minting third
— with the invariant that no stage may _over_-claim integrity.

**SC-10 [registry] Propagation classes per atom — §15.** The hereditary meet
(§8.9.3, §3.1.6.2) needs `propagationClass(atomType)` to be normative data, but
§15 doesn't assign classes. Add a propagation-class column (hereditary |
value-bound | provenance/non-propagating) for every registered atom. Also
register the implementation's atoms that are missing entirely (`LinkReference`,
`PromptSlotInfluence`, caveat alias kind strings — already an audit hygiene
item).

**SC-11 [normative] Idempotent label persistence — §4.6.4.** Reactive runtimes
re-derive labels on every recompute; require that persisting an unchanged
effective label is a no-op (no envelope write, no version bump, no replication
traffic), with equality defined over the canonical form (§4.1.3 c14n). Without
this, label persistence and reactive scheduling interact pathologically.

**SC-12 [clarify] Degenerate CNF join — §8.9.3.** `concatClauses` over
all-singleton clauses is atom-set union; confirm that structural dedup of
identical clauses/atoms is conforming (the monotonicity section has the
all-singleton note, the join section doesn't).

**SC-13 [normative] Propagation dial × enforcement ladder — §18.** The runner
has enforcement modes (`disabled|observe|enforce-explicit|strict`, audit item
3.1) and S16 adds a propagation dial (`off|observe|persist`). Spec the matrix:
what each combination means, which combinations are conforming deployment
states, and the rollout ordering constraint (propagation-observe before
propagation-persist; persist before any enforcement that consumes derived
labels).

**SC-14 [clarify] Cross-space derived labels — §4.6.4.1 or §17.** Deriving J
from space-A reads and persisting it into a space-B document's envelope
discloses A-derived label metadata to B's readers. Until label-metadata
confidentiality (invariant 12) exists, note the exposure and that atom payloads
(e.g. `Caveat.source`) are the sensitive part.

**SC-15 [reconcile] §4.6.1 vs §8.9.3 integrity meet.** §4.6.1 (reactive
propagation) intersects _all_ integrity atoms; §8.9.3 (default transition) keeps
only the _hereditary_ subset of the intersection plus TransformedBy. Plain
intersection can carry a value-bound atom whose binding no longer holds (caught
later only by §8.10.4 binding checks, and only at boundaries that run them).
Make §4.6.1 class-aware to match §8.9.3/§3.1.6.2.

**SC-16 [normative] Default display-boundary release profile — §8.10.5 / §18.**
Owner direction (2026-06-10): rendering is the first label-gated egress, with a
default ceiling of roughly _acting-user identity atoms plus an allow-list of
caveat-kind confidentiality classes_, admitted by default and tightened over
time; author-supplied declassification on render boundaries is policy-gated (the
`renderDeclassificationPolicy` knob of PR #3994, end state = verified authority
only). The spec has display-sink boundary context (§8.10.5
`sinkClass: "display"`) and caveat discharge rules, but no notion of a _default_
release profile for display sinks when no policy is authored. Spec the profile:
which atom families a display sink admits by default (acting-user/audience
identity; enumerated caveat kinds whose display-stage discharge rules apply),
that everything else fails closed, and that the default may only be tightened,
not loosened, without a new release judgment (§8.10.5.2 audience-expansion logic
applies).

## Status: SC-1..SC-16 applied (2026-06-10)

Applied to `~/src/specs/cfc` by the spec/Lean session: prose commit `f4647273`,
Lean mechanization `ce595217` (StoreComponents: declared monotonicity under the
combined update rule, effective ≥ declared, ancestor derived-clears never bypass
declared, journaled reads stable under later derived writes; TriggerReads:
PC-with-triggers is a monotone strengthening; DegenerateJoin: all-singleton CNF
join = dedup union — all sorry-free, `lake build` green), correspondence-block
sync `6ac0060f`. SC-16 landed as new §8.10.6; SC-1 as §8.12.8 + §4.6.4
`LabelComponent`; SC-6/SC-13 as §18.6.1-3.

## New observations (from applying SC-1..16; not yet designed)

**SC-17 [clarify] `provenance` propagation class × §8.4 exact copies.** Whether
provenance-class evidence (event/gesture-shaped atoms) survives an `exactCopyOf`
transition is unstated. Decide and state it (lean: it survives — exact copy
preserves the value identity the evidence binds to — but say so).

**SC-18 [normative] `canWrite` rejection semantics under derived taint.**
§8.12.4's writer rule (data label must fit the store label) has no defined
behavior when a _derived_ (flow) label exceeds the declared store policy:
reject, auto-upgrade, or persist-and-flag. Currently only matrix-level coverage
in §18.6.3; belongs with the queued enforcement-ladder item (audit 3.1).

**SC-19 [clarify] Blanket "confidentiality always joins" dependency.**
§15.2/§15.3 now lean on the rule that confidentiality atoms uniformly join; if
an atom family with non-join combination semantics ever lands, those sections
need revisiting. Record the assumption where the rule is stated.

**SC-20 [registry] `UserSurfaceInput` registry status.** Runtime-minted- gated
in the implementation (`RUNTIME_MINTED_INTEGRITY_ATOM_TYPES`) but listed as
merely an "example" in §15.6 — promote to a registered atom with its minting
discipline.

**SC-21 [normative] Read-classification markers as the J exclusion profile.**
Phase B (pointwise precision) only holds because flow derivation excludes
machinery reads, and post-#3911 the traversal journal cannot distinguish
machinery from consumption on its own: dependency seeding, link/slot
dereference, and scheduling tags all journal as ordinary reads. The
implementation closes this with explicit read-classification markers
(`internalVerifierRead`, `linkResolutionProbe`, `schedulerDependencyRead`)
plus the link-origin/pointer-vs-content split; J consumes only unmarked
content reads. The spec states the pointer/content split (SC-8) but not the
marker vocabulary or the obligation that every runtime-internal read path be
classified — an unmarked machinery read silently coarsens J (sound), while a
wrongly-marked consumption read is a leak (unsound, the dangerous direction).
Make the profile normative: enumerate the classes, state the
default-is-consumption rule, and require that markers are only attachable by
runtime code (never pattern-controlled).

## Queue (from the audit, not yet worked through in a design session)

These were identified during the audit as spec-absent implementation mechanisms
that should become normative text once their design sessions happen; listed so
this file is the single tracking place:

- Enforcement-mode ladder semantics incl. `enforce-strict` (audit 3.1 —
  partially covered by SC-13).
- Setup-projection structural provenance carve-out (audit 3.3).
- Implementation-identity scheme (`bundleId`/`sourceFile`/`bindingPath`,
  rebinding rules) as the write-authority root of trust (audit 3.4).
- `ownerPrincipal` / `__ctCurrentPrincipal` + companion-claim chain (audit 3.5).
- `addIntegrity` annotation (audit 3.6).
- Claim-only labelMap entries as policy-applicability markers (audit 3.7 —
  partially covered by SC-1's component model).
- Carried label views / dereference-trace merging / `LinkReference` atom (audit
  3.8 — atom registration covered by SC-10).
- uiContract trusted-event system as normative (audit 3.9).
- Schema-merge per-key direction table (audit 3.10).
- Post-commit outbox + sink-release re-verification contract (audit 3.11).
- Schema-sanitization / contamination scoping promotion from ch. 14 to normative
  (audit 3.12).
- `/value` envelope-prefix wire-format decision (audit Wave 4 #28).
