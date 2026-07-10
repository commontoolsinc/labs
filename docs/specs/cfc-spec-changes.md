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
(Container-membership encoding residual, found 2026-07-06 during the C3
follow-up's spec ground-truthing: the spec encodes membership as per-child
`shape` entries plus container-level `iterate` (§8.5.6.1); the runner's
container-anchored structure stamp is an undefined compaction with a known
under-taint — a static per-child existence probe ("is `/items/3` present?")
is a `shape` read at the child (§8.10.1.1) and does not consume the
exact-path container stamp. The spec-conforming fix is per-slot shape
entries, at the per-row entry-count cost (#3998); recorded here until an
implementation decides to pay it. Existence-entry update discipline settled
as freeze-at-creation — spec §8.12.8 amendment on branch
`cfc/existence-freeze-at-creation`.)

(Design settled 2026-07-02, C0 #4476 + follow-up patches:
`docs/specs/cfc-observation-classes.md` — the §4 read-API → class table, the
§5 SC-4 grow-vs-replace split, the §3 `origin:"link"` ⇒ implicit
`observes:"followRef"` covering-rule carve-out, and `count` folding into
`enumerate`. The spec PR to `commontoolsinc/specs` for §4.6.3 is now owed;
file it once C1 validates the mapping in code.)

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

## New observations (from applying SC-1..16; re-scoped by the 2026-06-12
## verification sweep)

A targeted verification sweep (2026-06-12) checked each open item against the
spec as it stands after SC-1..16. Several were narrower than recorded — the
spec already had a position — and two acquired owner decisions. Status per
item below.

**SC-17 [reconcile → decided] `provenance` class × §8.4 exact copies —
provenance SURVIVES; nothing drops on a verified exact copy.** Verification
found this is not a gap but a conflict: §15.1.1 bars provenance atoms from
every carriage path ("**no** binding verification, projection scoping, or
endorsed transformer may carry them onto an output either") and §3.1.6.2's
output-integrity enumeration ("exactly" items 1–3) admits them nowhere, while
§8.4.2's verification pseudocode preserves the input path's integrity
**unfiltered** when `refer(input) == refer(output)`. Owner decision
(2026-06-12): §8.4.2 is right and the class machinery is overly cautious — a
runtime-verified exact copy preserves the **entire** integrity label, all
classes; the output IS the value the evidence attaches to, so there is
nothing for any class to lose. §15.1.1's bar is re-scoped to what its
rationale actually protects: **registry claims** (endorsed transformers,
projection scoping) may never claim preservation authority over provenance
evidence; runtime-**verified** identity transitions (pass-through §8.2, exact
copy §8.4) are not claims and carry everything. Edits: §3.1.6.2 gets a
lead-in stating verified pass-through/exact-copy preserve all input integrity
at the path, with the class rule applying to value-changing computations;
§15.1.1's "no … may carry" narrows to registry claims; check
`formal/Cfc/Proofs/PropagationClass.lean` for any lemma encoding the broader
bar and keep the correspondence note honest.

**SC-18 [normative] Writer-fit under derived labels — confidentiality
direction verified non-silent; integrity direction decided.** Verification:
the confidentiality side is already addressed. §8.12.4 states writer-fit
"remains an enforcement question against the declared policy" (a
non-rejecting deployment still persists the derived component; readers are
protected by the effective-label floor; "the derived component is a
measurement, not a write ceiling"), and §8.12.5 enumerates reject / upgrade /
new-store with upgrade blessed as monotone-safe. Genuinely open there: (a) no
standard profile picks a **default** the way §8.10.6 does for display; (b)
whether `enforce-strict` makes writer-fit itself reject — §18.6.3's
derived-consuming list names the display ceiling and missing-policy rules,
not writer-fit; (c) the rejection error contract and the audit/diagnostics
contract for persist-and-flag.

(b) and (c) are now **decided and landed (Epic H4 code step)**: the `canWrite`
confidentiality misfit — the per-tx flow join measured against the declared
store-policy component at each derived-stamp path — rejects at
`enforce-strict` only, and persists-and-flags (a
`writer-fit(persist-and-flag)` diagnostic carrying the identical reason
string) under every lower mode, with the stable SC-18c reason
`writer-fit confidentiality misfit for <doc> at /<path> (canWrite, §8.12.4):
<offending clauses>`. Contract text in
`docs/specs/cfc-enforcement-matrix.md` §4; implementation in
`prepareBoundaryCommit` (runner `cfc/prepare.ts`) sharing the egress gates'
clause-subsumption predicate; tests `cfc-writer-fit.test.ts`. Only (a) — the
standard-profile default — stays open on the confidentiality side.

The **integrity direction** is genuinely unstated (§8.12.4's `canWrite`
checks confidentiality only; §8.10.3's `requiredIntegrity` is consume-side)
and is now decided (owner, 2026-06-12): the schema's `requiredIntegrity` is a
**floor**, typically a concept-level principal/pattern (e.g. "minted by a
valid GPS measurement"); a write conforms iff the value's integrity satisfies
the floor by pattern match / exchange-rule derivation — any concrete
measurement sits above the concept in the trust lattice and passes. Writes
**above** the floor are always acceptable; an overwrite is checked against
the **declared floor only**, never against the prior value's integrity —
sibling replacement (B not ≥ A, both ≥ floor) conforms, and **no meet across
successive writes** is taken (the derived integrity component is
replace-on-overwrite per §8.12.8). Also state the near-collision explicitly:
§8.12.1's store-label integrity rule ("can only remove atoms") governs the
declared label as a **claim** about contents; the `requiredIntegrity` floor
is a **requirement**, and tightening it is the restrictive (allowed)
direction — the two must not be conflated. Write-side floor checking needs a
home in §8.10 (today §8.10.3 is input/consume-side only).

The **integrity-direction code home is now landed (Epic D3, `verifyWriteFloor`
in `prepare.ts`)** behind the `cfcWriteFloor: off | observe | enforce` dial
(default `off`, orthogonal to the enforcement and flow dials). It tests the
**written value's** integrity — the schema-derived label (`addIntegrity` mints
+ `exactCopyOf` carry, evidence-gated by `gateRuntimeMintedIntegrity` so a
pattern cannot forge runtime-minted atoms to pass its own floor), each link
written at/under the path (the linked source's own label — the D2 by-reference
contract on the write side, one contribution per link so no laundering across
siblings), and the flow hereditary meet when flow labels persist — against the
floor with **exact-match** membership via the single shared predicate
`cfcIntegritySatisfiesFloor` (observation.ts), which the read-side gate and the
D2 tool-input floor now also call so D5's pattern/concept upgrade lands in one
place. SC-18's own semantics are honored: floor-is-a-minimum, overwrite checked
against the declared floor only (no meet across successive writes, no prior-
value consultation), and empty integrity on a floor-declaring path fails (a
stamped-`LlmDerived`-only value fails any floor by construction — closing the
write-side half of the vacuous pass). Wildcard (`*`) floor entries and
pattern-setup/seed initialization stay exempt (v1 scope); (a) the standard-
profile default and (c) the §8.10 spec home remain open — (b),
`enforce-strict` making writer-fit itself reject, landed with the H4 code
step (see the confidentiality paragraph above).

**SC-19 [clarify] Blanket "confidentiality always joins" dependency.**
Verified open (the rule is stated as fact in §15.1 and §3.1.2, nowhere
recorded as a revisit-trigger assumption). Record the assumption where the
rule is stated; one sentence.

**SC-20 [registry] `UserSurfaceInput` registry status.** Verified: §15.6
lists it in the explicitly non-normative example/extension table, classed
**value-bound** (`valueDigest`-bound), with no minting discipline — while the
implementation gates it in `RUNTIME_MINTED_INTEGRITY_ATOM_TYPES`. Promote to
a registered atom with its minting discipline (runtime-minted only), keeping
or justifying the value-bound class.

**SC-21 [normative] Read-classification markers — shrunk to a delta.**
Verification: §18.6.1–.2 already enumerate four exclusion classes
(verifier-internal reads, which "MUST be marked as such in the journal per
§8.10.1"; label-metadata reads at `/cfc/...`; program/source text;
content-addressed schema docs), state the default (everything else is
consumed), and flag the invariant-12 revisit; §4.6.3 has the
reference-without-dereference mapping and §8.9.2 makes trigger reads
normatively INCLUDED. Remaining delta: (a) the implementation's
`linkResolutionProbe` (coordinator link/slot scaffolding) and
`schedulerDependencyRead` (dependency seeding) are machinery but not
"verification machinery" — either generalize class 1 to runtime-internal
machinery reads or add them as named classes; (b) state explicitly that
markers are attachable only by runtime code, never pattern-controlled; (c)
state the asymmetry: over-exclusion is unsound (leak), under-exclusion merely
coarsens J.

**SC-22 [normative] Implementation identity = content hash of the code
artifact + symbol within it — §8.15.** §8.15.6 currently says "the handler's
identity (code hash) is the unit of write authorization—no separate naming
scheme is required" and leaves the hash target and rebinding semantics
undefined (audit 3.4). Owner decision (2026-06-12), matching the shipped
scheme (identity PRs E1–E4; `docs/specs/content-addressed-action-identity.md`
in the labs repo): implementation identity is the pair **(content hash of the
verified code artifact, symbol/binding path within it)**. Same artifact hash
+ same symbol = same identity wherever the artifact is loaded; any code
change changes the hash and with it every identity within the artifact —
rebinding is re-authorization, not inheritance; `writeAuthorizedBy`
references resolve against this pair. Replace §8.15.6's "no separate naming
scheme" claim with the pair definition and state the rebinding rule.

**SC-23 [interpretation] Per-write read-prefix provenance classed as
decomposition-grade precision — §8.9.1/§8.9.2 (Epic D4).** The runner's
input-requirement gate (`requiredIntegrity`/`maxConfidentiality` in
`verifyInputRequirements`) quantifies each protected write over the reads
whose activity-clock position precedes the LAST write attempt overlapping the
protected path (either prefix direction, matching floor applicability),
trigger reads joining every prefix at −∞. Interpretation call (owner note in
`cfc-write-prefix-provenance.md` §7.4): this is treated as a **structural
fact of the journal order in §8.9.1's decomposition class** — a read past the
last overlapping write provably did not feed the committed value — so it is
applied WITHOUT the `flow-taint-precision` trust gate; it is not an untrusted
`L_claim`. Two boundaries of the interpretation, both deliberate: (a) the
confidentiality **egress ceiling** stays transaction-global (a sink request
records no per-write provenance — §8.10); (b) the flow-label join `J(tx)` and
the D3 floor's flow-meet credit stay transaction-global too (one per-tx label
is load-bearing for stamp-collapse and persist-credit coherence); per-write
narrowing there needs per-path derived components first. The audit-#14
read-side vacuous pass resolves by DELEGATION: with an empty prefix the only
possible endorsement is the one the written value carries, which is exactly
the D3 write floor's check (§8.12.4.1) under its staged dial — an
unconditional read-side rejection would duplicate it under `enforce` and
break the pinned dial-off/observe byte-compat. If the spec wants the read
gate itself to reject empty-input floored writes independent of the floor
dial, that needs its own normative text + rollout dial. _Spec home landed:
specs#14 added §8.9.1.1 (journal-order structural precision — the prefix,
its bounds, trigger reads, digest binding), discharging the owed home; the
interpretation recorded here is now normative text._

**SC-24 [normative] Journal-order precision blessed; span-attributed
provenance profiled — §8.9.1.** SC-23's interpretation still has no spec home:
§8.9.1 names decomposition and trusted claims only, and nothing in the spec
mentions journal-order bounds. Proposed edit, two parts
([`cfc-value-level-provenance.md`](./cfc-value-level-provenance.md)): (1) a
normative paragraph sanctioning per-write gating over the last-overlapping-
write read prefix as structural precision (both prefix directions, trigger
reads at −∞, read|write interleaving digest-bound per §8.10.1) — the shipped
D4 mechanism; (2) a MAY profile for span-attributed provenance: runtime-
bracketed span tags on the activity record, per-write feeds-closure over
observed span edges, sound only where the executor structurally enforces span
non-interference — interpreter-class executors under §18.7-style obligations
(specs#11); sandboxed executors under the **instance rule** (the span is the
executor instance: executions sharing a live user-code instance share one
span; per-run instantiation recovers per-run spans) plus SES-closed
cross-instance channels and a commit-time observed-vs-attributed consistency
check — **no trusted static analysis assumed anywhere**; violations surface
as late errors (prefix fallback / commit rejection), never unsoundness. Bare
opaque handlers stay at the prefix; the §8.9.1 `flow-taint-precision` gate
remains only for semantic claims beyond runtime structure. States that the
egress ceiling / flow join / floor credit MAY upgrade from transaction-global
where the profile is enforced (upgrades SC-23's boundaries (a)/(b) from
deliberate to staged). `applied` — specs#14 (2026-07-09): part (1) as
§8.9.1.1, part (2) as the §8.9.1.2 span-attributed provenance profile
(executor classes incl. the instance rule, late-error framing, digest
discipline, predictions-never-narrow). Runner-side stage 0 (precision
counters) shipped as labs#4623; span machinery remains behind the
entry criteria in `cfc-value-level-provenance.md`.

**SC-25 [normative] Cross-space label-metadata representation classes —
§4.6.4.1/§4.6.4.2 (inv-12; supersedes SC-14's posture).** §4.6.4.1's
known-exposure paragraph is posture ("MUST treat persisted label metadata as
visible … SHOULD prefer atom forms"); the enforcement design
([`cfc-label-metadata-confidentiality.md`](./cfc-label-metadata-confidentiality.md))
needs it normative: cross-space persistence of source-bearing atom fields
follows a classification-governed representation — `public` / `commitment`
(canonical digest, equality-preserving, honestly probe-able) / `reference`
(source-space back-reference; resolution rides the source's read authority;
failure collapses to `notAvailable`) — applied identically to envelope
entries and sigil-carried label views, with same-form matching semantics.
Initial-assignment exception to record: `Space.id` in confidentiality clauses
stays `public` because §4.9.3's ACL point query must dereference it. Also:
§4.6.4.2 gains the interim population rule (source-identity confidentiality
when known; else, for **derived-component** entries only, the entry's own
effective confidentiality — sound because the §8.9.2 conservative join
contains each influencing source's confidentiality; else fail closed —
computable without new persisted metadata), and SC-6's "revisit when
invariant 12 is implemented" note is discharged by the introspection-surface
observation channel. `applied` — specs#14 (2026-07-09): the §4.6.4.1
known-exposure paragraph upgraded to the normative representation rule
(public/commitment/reference, same-form matching, `notAvailable` collapse)
and §4.6.4.2 gained the derived-component interim fallback. Runner-side:
stage 0 shipped as labs#4624 (seam close, persist re-derivation, sigil
redaction, classification table), stage 1 as labs#4638
(`cfcLabelMetadataProtection` dial, `{digestOf}` commitment transform,
commitment-aware matching); stages 2–3 remain per the design doc.

**SC-26 [reconcile] §8.12.7 route 2 conflates grant records with the rewrite
event — §8.12.7/§13.4.3.** Route 2's cited shape (§13.4.3) persists a
ShareGrant consulted at access time — a durable *input* to route-1 evaluation
— while route 2's text describes an in-place store-label rewrite (durable
*output*); the §13 summary table says "persistent policy state / label
rewrite" as if one thing. Proposed edit
([`cfc-persisted-declassification.md`](./cfc-persisted-declassification.md)):
split into 2a (grant records: reserved-path, trusted-writer,
content-addressed, fail-closed point-query resolution per §4.9.3, consumed
via a `policyState` exchange-rule guard kind, revocable, digest-bound into
the evaluation) and 2b (the rewrite event proper: intent-gated per §6.5 +
§3.8.4, authority-verified per §8.10.5.2, requires a declared-component
monotonicity gate to exist first, event record = a create-only document
causal to the consumed intent's id — the shipped `commitPreconditions`
receipt discipline — with canonical clause-digest identity, outside the
churn-free envelope). Guidance refines to:
2a when revocable or policy-derived; 2b only when the widening must survive
without evaluation (export/publish). Unconflate the §13 table row.
`applied` — specs#14 (2026-07-09): §8.12.7 route 2 split into 2a/2b with the
2b contract (including the create-only intent-causal record shape) and the
§13 summary-table row unconflated. Runner-side: grants build-order items 1–3
shipped as labs#4627 (`policyState` guards, owner-space `grant:cfc:` records,
consulted-grant digest binding); the rewrite event is **superseded** per
`cfc-persisted-declassification.md` §5 (owner decision 2026-07-10: in-fabric
federation trust comes from remote attestation, so trust-free release buys
nothing; out-of-fabric irrevocability is served by egress records, SC-27).

**SC-27 [normative] Egress records at send sinks — §8.10.5.2 follow-up.**
Out-of-fabric egress is irrevocable; modeling it with the same revocable
artifact as internal sharing invites the un-sending confusion (revoking the
record of a send is not un-sending). Proposed edit
([`cfc-persisted-declassification.md`](./cfc-persisted-declassification.md)
§6): the permanent **sent** record is minted by the successful post-commit
send path (the transaction commits before the outbox flush, and the release
can still be refused during the flush — a commit-time record would assert
disclosures that never happened): a create-only record causal to the outbox
idempotency key — `{valueDigest, destination, boundaryContext,
releasedAudienceEvidence, at, intentId}`, destination per the §8.10.5.2
destination/audience binding (discharging the audit's open
"destination-binding follow-up"), written record-then-clear against the
outbox entry so the record can understate but never overstate; an optional
commit-time attempt marker MUST NOT display as sent. Spec this together
with the audit's open "post-commit outbox + sink-release re-verification
contract" item (§8.10 is entirely pre-commit today).
The record is permanent (create-only, never deleted, no revocation surface)
and has **no enforcement role**: it never feeds a future release decision —
labels keep governing what the fabric serves; the record exists for honesty,
audit, and deriving "who could have this" (current grants ∪ past egress).
State the shared-vs-sent vocabulary distinction normatively so UIs cannot
present an egress as revocable. `open`.

## Queue (from the audit; statuses re-checked by the 2026-06-12 sweep where
## noted)

These were identified during the audit as spec-absent implementation mechanisms
that should become normative text once their design sessions happen; listed so
this file is the single tracking place:

- Enforcement-mode ladder semantics incl. `enforce-strict` (audit 3.1 —
  partially covered by SC-13; the writer-fit remainder is SC-18 (a)–(c)).
- Setup-projection structural provenance carve-out (audit 3.3). Not
  re-verified.
- ~~Implementation-identity scheme (audit 3.4)~~ — superseded by **SC-22**
  (decided: artifact content hash + symbol).
- `ownerPrincipal` / `__ctCurrentPrincipal` + companion-claim chain (audit
  3.5). **Verified silent** 2026-06-12: no principal-resolution chain in §6 or
  §8.15 — confirmed open.
- ~~`addIntegrity` annotation (audit 3.6)~~ — **verified: spec already
  explicit.** §8.8/§8.7.3 define `addedIntegrity` with semantics (transformer-
  minted output atoms, boundary-verified). The remaining work is
  **implementation conformance**, not spec text: the code's `addIntegrity`
  spelling and the schema-merge path that silently drops the annotation need
  to align with the spec's name and honor it (or visibly reject it).
- Claim-only labelMap entries as policy-applicability markers (audit 3.7 —
  partially covered by SC-1's component model). Not re-verified.
- Carried label views / dereference-trace merging / `LinkReference` atom (audit
  3.8 — atom registration covered by SC-10). Not re-verified.
- uiContract trusted-event system as normative (audit 3.9). Not re-verified.
- Schema-merge per-key direction table (audit 3.10). **Verified silent**
  2026-06-12: §4.2.2.1 covers schema evolution, not per-key conflict
  resolution between composed schemas' IFC annotations — confirmed open.
- Post-commit outbox + sink-release re-verification contract (audit 3.11).
  **Verified silent** 2026-06-12: §8.10 is entirely pre-commit — confirmed
  open.
- Schema-sanitization / contamination scoping promotion from ch. 14 to
  normative (audit 3.12). Not re-verified.
- ~~`/value` envelope-prefix wire-format decision (audit Wave 4 #28)~~ —
  **verified: decided by the spec.** §4.6.4/§4.6.5 normatively require the
  `/value` envelope prefix for persisted payload labels and value-relative
  normalization before IFC matching. Remaining work is **implementation
  conformance** (or documenting equivalence), not a decision.

## Also noted by the sweep (not previously tracked)

- §8.10.6 already specifies the display-ceiling atom families exactly
  (`User(actingUser)` + `PersonalSpace`/`Space`-with-`HasRole` principal forms
  resolved by exchange rules, plus the deployment-declared caveat-kind
  allow-list seeded from influence-class kinds). The shell ceiling flip is
  therefore **implementation alignment** — the runner's render-gate atom
  vocabulary does not currently use the §15.2 shapes, and the
  exchange-rule resolution step does not exist in the reconciler — not an
  atom-shape design question.
- §8.12.8 already documents the observation-class residuals (existence
  channel; pointer-identity-at-a-slot) as profile residuals with
  `PathLabelTemplate` named as the fix; the open part of that build is the
  envelope persistence/population design, tracked with SC-4/SC-8.
