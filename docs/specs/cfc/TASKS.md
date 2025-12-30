# CFC Spec Fix-Up Task List

This file tracks the doc work needed to make `docs/specs/cfc/*.md` internally consistent and implementation-ready.

## 1) Editorial + Cross-Reference Hygiene

- [ ] Fix broken section references:
  - [ ] Replace `Section 2.8.6/2.8.7` with `Section 3.8.6/3.8.7` in `10-safety-invariants.md`.
  - [ ] Add missing `Section 5.6` (provenance integrity) in `05-policy-architecture.md` and ensure references resolve.
- [ ] Fix duplicate section numbering in `06-events-and-intents.md` and update any references.
- [ ] Run a cross-file scan for `Section X.Y` references and correct mismatches.

## 2) Commit / Consumption Semantics (Single Canonical Model)

- [ ] Choose and specify a single commit-point state machine that matches the Gmail example and `07-write-actions.md`.
- [ ] Rewrite `06-events-and-intents.md` commit/consumption sections to eliminate contradictions (consume-on-commit vs consume-first).
- [ ] Ensure retries/idempotency story is consistent across Sections 1, 6, and 7.

## 3) Label / Atom Model Coherence

- [ ] Make the atom model consistent and extensible:
  - [ ] Ensure `Context`/`Policy` atoms include required policy content hashes (as specified later in Section 4).
  - [ ] Add missing commonly used atoms (e.g., `Expires`, `TTL`, `HasRole`, `AuthorizedRequest`, `PolicyCertified`) or define an extension mechanism.
- [ ] Align policy lookup and exchange evaluation pseudo-code with the atom definitions.

## 4) Integrity Model vs Modification Authorization

- [ ] Resolve the “integrity has no disjunction” vs “field integrity is union of writers” conflict:
  - [ ] Separate value integrity from write-authorization sets (or explicitly extend integrity semantics).
  - [ ] Update `08-label-transitions.md` Section 8.15 and the related notes in Section 3.

## 5) Transition Semantics Clarity

- [ ] `exactCopyOf` mismatch handling: make `08-label-transitions.md` consistent (reject vs treat-as-transformation).
- [ ] Flow/PC confidentiality: make the “routing decision taints outputs” rule actionable by tying it to the propagation story.
- [ ] Collections: reconcile “membership confidentiality” with the core `Label` representation (map to container-path labels vs per-item labels).
- [ ] Spaces + personal spaces: clarify how “personal” fits the “data belongs to one space” story, and how examples should be read.

## 6) Trust Boundary Notes

- [ ] Add explicit “trusted runtime vs pattern code” notes where `refer()`, digests, and evidence structures appear in examples.

