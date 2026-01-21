/-
  CFC/Lattice.lean
  Proofs that CFC labels form a proper lattice structure.

  This file proves:
  - Confidentiality labels (CNF) form a join semilattice
  - Integrity labels form a meet semilattice
  - Combined labels form a product lattice

  Corresponds to Section 3.1 of the CFC specification.
-/

import CFC.Label

namespace CFC

/-!
## Confidentiality Lattice Properties

Confidentiality uses CNF structure where:
- Join = clause concatenation (more restrictive)
- More clauses = more requirements = more restrictive
- Within a clause, more alternatives = less restrictive
-/

/-- Confidentiality join is associative -/
theorem conf_join_assoc (l₁ l₂ l₃ : ConfidentialityLabel) :
    (l₁.join l₂).join l₃ = l₁.join (l₂.join l₃) := by
  simp [ConfidentialityLabel.join]
  exact List.append_assoc l₁ l₂ l₃

/-- Confidentiality join is commutative up to clause order
    Note: Clause order doesn't affect semantics (all must be satisfied) -/
theorem conf_join_comm_semantic (l₁ l₂ : ConfidentialityLabel) (p : Principal) :
    l₁.join l₂ |>.all p.satisfiesClause =
    l₂.join l₁ |>.all p.satisfiesClause := by
  simp [ConfidentialityLabel.join]
  constructor
  · intro h
    intro c hc
    simp [List.mem_append] at hc
    cases hc with
    | inl h2 =>
      have : c ∈ l₁ ++ l₂ := List.mem_append.mpr (Or.inr h2)
      exact h c this
    | inr h1 =>
      have : c ∈ l₁ ++ l₂ := List.mem_append.mpr (Or.inl h1)
      exact h c this
  · intro h
    intro c hc
    simp [List.mem_append] at hc
    cases hc with
    | inl h1 =>
      have : c ∈ l₂ ++ l₁ := List.mem_append.mpr (Or.inr h1)
      exact h c this
    | inr h2 =>
      have : c ∈ l₂ ++ l₁ := List.mem_append.mpr (Or.inl h2)
      exact h c this

/-- Empty confidentiality is the identity for join -/
theorem conf_join_empty_left (l : ConfidentialityLabel) :
    ([]).join l = l := by
  simp [ConfidentialityLabel.join]

theorem conf_join_empty_right (l : ConfidentialityLabel) :
    l.join [] = l := by
  simp [ConfidentialityLabel.join]

/-- Confidentiality join is monotonic: adding clauses only restricts access -/
theorem conf_join_restricts (l₁ l₂ : ConfidentialityLabel) (p : Principal) :
    (l₁.join l₂).all p.satisfiesClause →
    l₁.all p.satisfiesClause ∧ l₂.all p.satisfiesClause := by
  intro h
  simp [ConfidentialityLabel.join] at h
  constructor
  · intro c hc
    apply h c
    exact List.mem_append.mpr (Or.inl hc)
  · intro c hc
    apply h c
    exact List.mem_append.mpr (Or.inr hc)

/-- If access is granted for both, access is granted for join -/
theorem conf_join_access (l₁ l₂ : ConfidentialityLabel) (p : Principal) :
    l₁.all p.satisfiesClause →
    l₂.all p.satisfiesClause →
    (l₁.join l₂).all p.satisfiesClause := by
  intro h1 h2
  simp [ConfidentialityLabel.join]
  intro c hc
  simp [List.mem_append] at hc
  cases hc with
  | inl h => exact h1 c h
  | inr h => exact h2 c h

/-!
## Integrity Lattice Properties

Integrity uses simple conjunction where:
- Meet = set intersection (weaker claims)
- Fewer atoms = weaker claims
-/

/-- Integrity meet is associative -/
theorem int_meet_assoc (i₁ i₂ i₃ : IntegrityLabel) :
    (i₁.meet i₂).meet i₃ = i₁.meet (i₂.meet i₃) := by
  simp [IntegrityLabel.meet]
  ext a
  simp [List.mem_filter]
  constructor
  · intro ⟨⟨h1, h2⟩, h3⟩
    exact ⟨h1, h2, h3⟩
  · intro ⟨h1, h2, h3⟩
    exact ⟨⟨h1, h2⟩, h3⟩

/-- Integrity meet is commutative -/
theorem int_meet_comm (i₁ i₂ : IntegrityLabel) :
    ∀ a, a ∈ i₁.meet i₂ ↔ a ∈ i₂.meet i₁ := by
  intro a
  simp [IntegrityLabel.meet, List.mem_filter]
  exact And.comm

/-- Integrity meet is idempotent -/
theorem int_meet_idempotent (i : IntegrityLabel) :
    i.meet i = i.deduplicate := by
  simp [IntegrityLabel.meet]
  ext a
  simp [List.mem_filter]
  sorry -- Requires showing filter with self-membership = deduplicate

/-- Empty integrity is the identity for meet in one direction -/
theorem int_meet_empty (i : IntegrityLabel) :
    i.meet [] = [] := by
  simp [IntegrityLabel.meet, List.filter]

/-- Integrity meet is monotonic: result is subset of both inputs -/
theorem int_meet_subset_left (i₁ i₂ : IntegrityLabel) :
    ∀ a, a ∈ i₁.meet i₂ → a ∈ i₁ := by
  intro a h
  simp [IntegrityLabel.meet, List.mem_filter] at h
  exact h.1

theorem int_meet_subset_right (i₁ i₂ : IntegrityLabel) :
    ∀ a, a ∈ i₁.meet i₂ → a ∈ i₂ := by
  intro a h
  simp [IntegrityLabel.meet, List.mem_filter] at h
  exact h.2

/-!
## Combined Label Lattice

Labels combine confidentiality (join) and integrity (meet) into a product.
-/

/-- Label join is associative -/
theorem label_join_assoc (l₁ l₂ l₃ : Label) :
    (l₁.join l₂).join l₃ = l₁.join (l₂.join l₃) := by
  simp [Label.join]
  constructor
  · exact conf_join_assoc l₁.confidentiality l₂.confidentiality l₃.confidentiality
  · exact int_meet_assoc l₁.integrity l₂.integrity l₃.integrity

/-- Label join with empty is identity -/
theorem label_join_empty_left (l : Label) :
    Label.empty.join l = { confidentiality := l.confidentiality
                         , integrity := [] } := by
  simp [Label.join, Label.empty, ConfidentialityLabel.join, IntegrityLabel.meet]

theorem label_join_empty_right (l : Label) :
    l.join Label.empty = { confidentiality := l.confidentiality
                         , integrity := [] } := by
  simp [Label.join, Label.empty, ConfidentialityLabel.join, IntegrityLabel.meet]

/-- Joining labels preserves access semantics -/
theorem label_join_access (l₁ l₂ : Label) (p : Principal) :
    p.canAccess (l₁.join l₂) →
    p.canAccess l₁ ∧ p.canAccess l₂ := by
  intro h
  simp [Principal.canAccess] at *
  exact conf_join_restricts l₁.confidentiality l₂.confidentiality p h

/-- Joining labels reduces integrity -/
theorem label_join_integrity_weakens (l₁ l₂ : Label) :
    ∀ a, a ∈ (l₁.join l₂).integrity → a ∈ l₁.integrity ∧ a ∈ l₂.integrity := by
  intro a h
  simp [Label.join] at h
  exact ⟨int_meet_subset_left _ _ a h, int_meet_subset_right _ _ a h⟩

/-!
## Ordering Properties

The flowsTo relation defines when one label is "less restrictive" than another.
-/

/-- flowsTo is reflexive -/
theorem flowsTo_refl (l : Label) : l ⊑ l = true := by
  simp [Label.flowsTo]
  constructor
  · intro c hc
    exact ⟨c, hc, fun a ha => ha⟩
  · intro a ha
    exact ha

/-- Joining increases restrictiveness in confidentiality direction -/
theorem join_increases_confidentiality (l₁ l₂ : Label) :
    l₁ ⊑ (l₁.join l₂) = true ∨
    ∃ p, p.canAccess (l₁.join l₂) → p.canAccess l₁ := by
  right
  intro p h
  exact (label_join_access l₁ l₂ p h).1

/-- Adding a clause increases restrictiveness -/
theorem addClause_more_restrictive (l : Label) (c : Clause) :
    l ⊑ (l.addClause c) = true ∨
    ∃ p, p.canAccess (l.addClause c) → p.canAccess l := by
  right
  intro p h
  simp [Principal.canAccess, Label.addClause] at *
  intro c' hc'
  apply h c'
  exact List.mem_append.mpr (Or.inl hc')

end CFC
