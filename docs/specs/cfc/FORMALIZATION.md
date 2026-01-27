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

## What Is Not Yet Modeled (Gaps vs Spec)

The Lean model does *not* currently include:
- Full commit-point state machine (attempt tracking, deduplication, concurrency) and its integration
  with label transitions / side effects (Spec Sections 6/7; invariant 4)
- Write-authority sets (`writeAuthorizedBy`) and stateful authorization (Spec 8.15)
- Full policy record architecture (hash binding, fixpoint evaluation, targeting)
- Full schema-driven propagation algorithm (Spec 8.9) beyond local transition primitives
- Transformation integrity / endorsed transformation registries (Spec 8.7)
- Selection-decision integrity for ranking/recommendation scenarios (Spec 8.5.7)
- Side effects / egress enforcement beyond the abstract exchange/declassify rules above

These can be added incrementally, but would expand the model beyond the current "core IFC proofs"
focus.
