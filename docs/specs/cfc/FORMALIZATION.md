# CFC Spec: Lean Formalization Status

This repo contains a small Lean4 model of selected CFC core concepts and safety invariants.
It is intentionally minimal (Std-only, no Mathlib) and focuses on proving "load-bearing"
security properties rather than modeling the full runtime.

## What Is Modeled (Lean)

### Label Algebra (Spec Sections 3.1, 3.3, 4)

- CNF confidentiality:
  - `formal/Cfc/Label.lean`: `Clause := List Atom`, `ConfLabel := List Clause`
  - Join is CNF conjunction by list concatenation (`Label.join`, `HAdd` instance).
- Integrity:
  - `formal/Cfc/Label.lean`: `IntegLabel := List Atom`
  - Join is intersection (`Label.joinIntegrity`)
  - Endorsement integrity is additive at creation (`Label.endorseIntegrity`, `Label.endorse`).

Key lemmas:
- `formal/Cfc/Label.lean`: `Label.mem_joinIntegrity`, `Label.mem_endorseIntegrity`

### Access Semantics (Spec "Who can read what?")

- `formal/Cfc/Access.lean`: principals, clause satisfaction, `canAccessConf` / `canAccess`
- Standard decomposition lemma:
  - `canAccessConf_append_iff` (CNF conjunction splits over list concatenation)

### Exchange Rules (Spec Sections 3.6, 3.9; plus invariant 3/6 in Section 10)

Implemented rules (subset of the spec):
- Space role-based exchange ("SpaceReaderAccess"):
  - `formal/Cfc/Exchange.lean`: `exchangeSpaceReader`
- Multi-party consent collapse + view-side rewrite:
  - `formal/Cfc/Exchange.lean`: `exchangeMultiPartyConsentCompute`, `exchangeMultiPartyResultView`
- Generic guarded rewrites:
  - `formal/Cfc/Exchange.lean`: `exchangeAddAltIf`, `exchangeDropSingletonIf`

Proof building blocks:
- `formal/Cfc/Proofs/Exchange.lean`: monotonicity lemmas (exchange doesn't *reduce* accessibility)
- `formal/Cfc/Proofs/Scenarios.lean`: worked examples for spaces, links, multiparty, authority-only drop, expiration.

### Policy Evaluation at Trusted Boundaries (Spec Sections 4.3 / 4.4 / 5)

- `formal/Cfc/Policy.lean`: minimal policy-record + exchange-rule evaluator:
  - discovers policy principals in a label (`Atom.policy ...`) and looks up policy records in scope
  - matches exchange rules using a small pattern language with variable bindings
  - applies rewrites and iterates to a fuelled fixpoint (`Policy.evalFixpoint`)
- `formal/Cfc/Proofs/Policy.lean`: executable regressions showing:
  - the Gmail "authority-only token drop" behavior can be expressed via a policy record, and
  - without integrity guards the evaluator is a no-op (safe default).

### Trusted Boundary Egress Checks (Spec Chapters 11 / 13)

- `formal/Cfc/Atom.lean`: `Atom.capability kind resource` (spec 13.2 "Capability") for modeling egress sinks
- `formal/Cfc/Egress.lean`: small boundary wrapper:
  - evaluate policies at the boundary, then check `canAccess` for the boundary principal
- `formal/Cfc/Proofs/Egress.lean`: end-to-end regressions:
  - without guards, the boundary cannot unlock egress
  - with guards, policy evaluation can add the capability needed for `canAccess`.

### Links / Endorsement Integrity (Spec Section 3.7)

- `formal/Cfc/Link.lean`: `Link.deref` (conf conjunctive, integrity additive)
- `formal/Cfc/Proofs/Link.lean`: access/integrity facts about deref

### Tiny Language + Core IFC Proofs (Spec Section 10: invariants 7/8/9)

Two tiny expression languages are modeled:

1) **Pure IFC language** (confidentiality only)
- `formal/Cfc/Language.lean`: `Expr`, `eval`, `observe`
- `formal/Cfc/Proofs/Noninterference.lean`: non-interference theorem for `Expr`

2) **Declassification/endorsement language** (PC confidentiality + PC integrity)
- `formal/Cfc/Language/Declassify.lean`: `ExprD`, `evalD`
  - PC confidentiality flows through branching/guards.
  - PC integrity (`pcI`) tracks trusted control-flow for robust declassification.
  - `endorseIf`: only adds integrity when `TrustedScope` is in the updated PC-integrity.
  - `declassifyIf`: only rewrites confidentiality when an integrity token is present and `TrustedScope` is in `pcI`.

Proofs corresponding to safety invariants:
- Invariant 6 (no silent downgrade when guards fail):
  - `formal/Cfc/Proofs/RobustDeclassification.lean`: `declassifyIf_guard_absent_preserves_conf`, `declassifyIf_pc_absent_preserves_conf`
- Invariant 7 (robust declassification / control-integrity):
  - `formal/Cfc/Proofs/PcIntegrity.lean`: `declassifyIf_blocked_by_untrusted_cond`
- Invariant 8 (transparent endorsement, plus control-integrity blocking):
  - `formal/Cfc/Proofs/TransparentEndorsement.lean`: `endorseIf_*` lemmas
  - `formal/Cfc/Proofs/PcIntegrity.lean`: `endorseIf_blocked_by_untrusted_cond`
- Invariant 9 (flow-path confidentiality):
  - `formal/Cfc/Proofs/FlowPathConfidentiality.lean`: `pc_subset_evalD_conf`,
    `observe_endorseIf_eq_none_of_hidden_guard`, and a composed regression:
    `observe_declassifyIf_endorseIf_eq_none_of_hidden_guard`

### IntentOnce Consumption (Spec Sections 6/7; invariant 4)

- Minimal model of "no-consume-on-failure" + single-use intents:
  - `formal/Cfc/Intent.lean`: `Intent.commitOnce`
  - `formal/Cfc/Proofs/Intent.lean`: `commitOnce_no_consume_on_failure`, `commitOnce_single_use`
- Minimal commit-point wrapper (ties intent consumption to declassification-at-commit):
  - `formal/Cfc/CommitPoint.lean`: `CommitPoint.declassifyCommit`
  - `formal/Cfc/Proofs/CommitPoint.lean`: `declassifyCommit_single_use`

### Worked Example: Gmail OAuth (Spec Chapter 1)

- `formal/Cfc/Proofs/GmailExample.lean`: small regression suite covering:
  - authority-only token secrecy dropping with integrity guards (1.2),
  - query secrecy tainting the response (1.3),
  - commit-coupled intent consumption (1.4.6).

### Label Transition Rules (Spec Chapter 8)

Trusted-runtime label propagation rules (schema-driven transitions):

- Pass-through / reference preservation (8.2), projection scoping (8.3), exact-copy verification (8.4), transformation provenance (8.7/8.9.2):
  - `formal/Cfc/LabelTransitions.lean`: `LabelTransition.passThrough`, `LabelTransition.projection`,
    `LabelTransition.exactCopyOf`, `LabelTransition.combinedFrom` (8.6),
    `LabelTransition.transformedFrom` (default transition / transformation integrity)
  - `formal/Cfc/Proofs/LabelTransitions.lean`: core preservation lemmas (e.g. scoped integrity membership,
    exactCopyOf success/failure characterizations, `transformedFrom` adds `TransformedBy`)
- Endorsed transformations (8.7.2):
  - `formal/Cfc/LabelTransitions.lean`: `LabelTransition.TransformRule`, `LabelTransition.verifyEndorsedTransform`,
    `LabelTransition.endorsedTransformedFromChecked`
    - checked registry-based transition: preserves only allowed integrity atoms that are common to all inputs
  - `formal/Cfc/Proofs/LabelTransitions.lean`: soundness lemmas for the registry check and preserved-atom behavior
- Safe recomposition of projections (motivated by 8.3.2 / 8.3.4):
  - `formal/Cfc/LabelTransitions.lean`: `LabelTransition.recomposeFromProjections`
    - checked transition that (a) validates each part via an abstract reference-equality check,
      and (b) requires the expected scoped integrity atom before restoring whole-object integrity
  - `formal/Cfc/Proofs/LabelTransitions.lean`: lemma `mem_recomposeFromProjections_whole_of_eq_some`
- Collections (8.5):
  - `formal/Cfc/Collection.lean`: `LabeledCollection` (separates membership label from member labels),
    `CollectionTransition.subsetOf`, `CollectionTransition.permutationOf`, `CollectionTransition.filteredFrom`,
    `CollectionTransition.lengthPreserved`
  - `formal/Cfc/Collection.lean`: selection-decision declassification primitive
    - `CollectionTransition.declassifySelectionDecisionIf` clears `selectionDecisionConf` taint when
      integrity evidence is present and `trustedScope` is in the ambient control-integrity (`pcI`)
  - `formal/Cfc/Collection.lean`: executable checks `CollectionTransition.Verify.*` and checked transitions
    returning `Option` (reject on verification failure)
  - `formal/Cfc/Proofs/Collection.lean`: key container/member preservation lemmas
  - `formal/Cfc/Proofs/LabelTransitionExamples.lean`: small regressions that exercise projection scoping,
    exactCopyOf rejection, and membership-vs-member separation
- Store label monotonicity (8.12):
  - `formal/Cfc/Store.lean`: CNF "more restrictive" relation + integrity weakening relation,
    combined `canUpdateStoreLabel` predicate, and an access monotonicity theorem
  - `formal/Cfc/Proofs/Store.lean`: regression examples (including expiration tightening)
- Opaque inputs / blind passing (8.13):
  - `formal/Cfc/Opaque.lean`: `OpaqueRef` + pass-through semantics (no content access in the model)
  - `formal/Cfc/Proofs/Opaque.lean`: router-style example showing a decision output can be readable
    while the opaque payload remains unreadable
- Modification authorization / write authority (8.15):
  - `formal/Cfc/WriteAuthority.lean`: handler identity, `writeAuthorizedBy`, schema union, and an
    in-place `modify` primitive that preserves the authority set
  - `formal/Cfc/Proofs/WriteAuthority.lean`: counter example and composition/stability lemmas
- Contamination scoping (8.14, open problem):
  - `formal/Cfc/Contamination.lean`: candidate model using scoped integrity atoms to isolate "blast radius"
  - `formal/Cfc/Proofs/Contamination.lean`: small regressions showing scoped evidence drops when steps recombine

## What Is Not Yet Modeled (Gaps vs Spec)

The Lean model does *not* currently include:
- Full commit-point state machine (attempt tracking, deduplication, concurrency) and its integration
  with label transitions / side effects (Spec Sections 6/7; invariant 4)
- Full policy record architecture from the spec (hash binding, richer pattern language / constraints,
  policy discovery/selection beyond `Atom.policy ...`, and an un-fuelled fixpoint semantics)
- Full schema-driven propagation algorithm (Spec 8.9) beyond local transition primitives
- Full transformation-integrity framework (Spec 8.7) beyond the minimal endorsed-transform allowlist
  and "preserve only common integrity atoms" checked transition that is modeled in Chapter 8
- Full selection-decision integrity framework (Spec 8.5.7) beyond the tokenized `selectionDecisionConf`
  taint + guarded declassification primitive modeled in `formal/Cfc/Collection.lean`
- Side effects / egress enforcement beyond the small trusted-boundary wrapper and regression examples

These can be added incrementally, but would expand the model beyond the current "core IFC proofs"
focus.
