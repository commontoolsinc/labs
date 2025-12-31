# CFC Spec Fix-Up Task List

This file tracks the doc work needed to make `docs/specs/cfc/*.md` internally consistent and implementation-ready.

## 1) Editorial + Cross-Reference Hygiene

- [x] Fix broken section references:
  - [x] Replace the incorrect `2.8.6/2.8.7` reference with `Section 3.8.6/3.8.7` in `10-safety-invariants.md`.
  - [x] Add missing `Section 5.6` (provenance integrity) in `05-policy-architecture.md` and ensure references resolve.
- [x] Fix duplicate section numbering in `06-events-and-intents.md` and update any references.
- [x] Run an additional cross-file scan for `Section X.Y` references and correct any remaining mismatches.

## 2) Commit / Consumption Semantics (Single Canonical Model)

- [x] Choose and specify a single commit-point state machine that matches the Gmail example and `07-write-actions.md`.
- [x] Rewrite `06-events-and-intents.md` commit/consumption sections to eliminate contradictions (consume-on-commit vs consume-first).
- [x] Ensure retries/idempotency story is consistent across Sections 1, 6, and 7.

## 3) Label / Atom Model Coherence

- [x] Make the atom model consistent and extensible:
  - [x] Ensure `Context`/`Policy` atoms include required policy content hashes at label-time (Section 4.1.2 / 4.4.2).
  - [x] Add missing commonly used atoms (e.g., `Expires`, `TTL`, `HasRole`, `AuthorizedRequest`, `PolicyCertified`) or define an extension mechanism.
- [x] Align policy lookup and exchange evaluation pseudo-code with the atom definitions (fixpoint, targeting, helper semantics).
- [x] Add an Atom Registry appendix for quick reference (`13-atom-registry.md`).

## 4) Integrity Model vs Modification Authorization

- [x] Resolve the “integrity has no disjunction” vs “field integrity is union of writers” conflict:
  - [x] Separate value integrity from write-authorization sets (`writeAuthorizedBy`).
  - [x] Update `08-label-transitions.md` Section 8.15 and the related notes in Section 3.

## 5) Transition Semantics Clarity

- [x] `exactCopyOf` mismatch handling: make `08-label-transitions.md` consistent (reject vs treat-as-transformation).
- [x] Flow/PC confidentiality: make the “routing decision taints outputs” rule actionable by tying it to the propagation story.
- [x] Collections: reconcile “membership confidentiality” with the core `Label` representation (map to container-path labels vs per-item labels).
- [x] Spaces + personal spaces: clarify how “personal” fits the “data belongs to one space” story, and how examples should be read.

## 6) Trust Boundary Notes

- [x] Add explicit “trusted runtime vs pattern code” notes where `refer()`, digests, and evidence structures appear in examples.

## 7) Remaining / Nice-to-Have

- [x] Add a short “Notation & conventions” section (hash notation, `H(...)` vs `refer(...)`, schema-time vs label-time).
- [x] Finish naming consistency passes across remaining chapters (e.g., camelCase field names in UI/intent examples).
