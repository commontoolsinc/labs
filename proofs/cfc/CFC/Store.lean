/-
  CFC/Store.lean
  Store label monotonicity proofs.

  From Section 8.12 of the CFC specification, stores (persistent cells)
  have labels that must be monotonically non-decreasing over their lifetime.

  Key properties:
  - Store labels can only become stricter (more clauses, earlier Expires)
  - Labels never become looser
  - Writing requires label compatibility
  - Schema evolution preserves monotonicity
-/

import CFC.Label
import CFC.Lattice

namespace CFC

/-!
## Store Model
-/

/-- A store (persistent cell) with a label -/
structure Store (α : Type) where
  value : α
  label : Label
  schemaVersion : String
  createdAt : Timestamp
  deriving Repr

/-- Store label update history -/
structure LabelUpdate where
  oldLabel : Label
  newLabel : Label
  updatedAt : Timestamp
  reason : String
  deriving Repr

/-!
## Label Restrictiveness Ordering

A label is "more restrictive" if it has:
- More confidentiality clauses (more requirements)
- Fewer alternatives per clause (fewer ways to satisfy)
- Earlier expiration times
- Fewer integrity atoms (weaker claims)
-/

/-- Check if one clause is at least as restrictive as another -/
def Clause.atLeastAsRestrictive (c₁ c₂ : Clause) : Bool :=
  -- c₁ is more restrictive if its alternatives are a subset of c₂'s
  c₁.all (fun a => a ∈ c₂)

/-- Check if confidentiality c₁ is at least as restrictive as c₂ -/
def ConfidentialityLabel.atLeastAsRestrictive
    (c₁ c₂ : ConfidentialityLabel) : Bool :=
  -- Every clause in c₂ must have a corresponding clause in c₁
  -- with at most as many alternatives
  c₂.all (fun clause₂ =>
    c₁.any (fun clause₁ => clause₁.atLeastAsRestrictive clause₂))

/-- Check if label l₁ is at least as restrictive as l₂ -/
def Label.atLeastAsRestrictive (l₁ l₂ : Label) : Bool :=
  l₁.confidentiality.atLeastAsRestrictive l₂.confidentiality &&
  -- For integrity, more restrictive means fewer atoms
  l₂.integrity.all (fun a => a ∈ l₁.integrity)

/-!
## Monotonicity Constraints
-/

/-- Check if a label update is valid (monotonically non-decreasing) -/
def isValidLabelUpdate (current proposed : Label) : Bool :=
  proposed.atLeastAsRestrictive current

/-- Valid updates preserve restrictiveness -/
theorem valid_update_preserves_restrictiveness
    (current proposed : Label)
    (h : isValidLabelUpdate current proposed) :
    ∀ p, p.canAccess proposed → p.canAccess current := by
  intro p hp
  simp [isValidLabelUpdate, Label.atLeastAsRestrictive] at h
  simp [Principal.canAccess] at *
  intro c hc
  -- Find the corresponding clause in proposed
  have ⟨h_conf, h_int⟩ := h
  simp [ConfidentialityLabel.atLeastAsRestrictive] at h_conf
  -- Every clause in current has a more restrictive version in proposed
  sorry -- Requires detailed clause matching

/-- Adding a clause is always a valid update -/
theorem addClause_valid_update (l : Label) (c : Clause) :
    isValidLabelUpdate l (l.addClause c) := by
  simp [isValidLabelUpdate, Label.atLeastAsRestrictive, Label.addClause]
  simp [ConfidentialityLabel.atLeastAsRestrictive]
  constructor
  · -- Confidentiality: every old clause is still present
    intro clause hclause
    use clause
    constructor
    · exact List.mem_append.mpr (Or.inl hclause)
    · simp [Clause.atLeastAsRestrictive]
  · -- Integrity: unchanged
    intro a ha
    exact ha

/-- Removing an alternative is always a valid update -/
theorem removeAlternative_valid_update
    (l : Label)
    (clauseIndex : Nat)
    (atomToRemove : Atom)
    (h : clauseIndex < l.confidentiality.length) :
    let oldClause := l.confidentiality[clauseIndex]!
    let newClause := oldClause.filter (· ≠ atomToRemove)
    newClause.length > 0 →  -- Must keep at least one alternative
    isValidLabelUpdate l
      { l with confidentiality :=
          l.confidentiality.take clauseIndex ++
          [newClause] ++
          l.confidentiality.drop (clauseIndex + 1) } := by
  intro hnonempty
  simp [isValidLabelUpdate, Label.atLeastAsRestrictive]
  constructor
  · -- Fewer alternatives = more restrictive
    simp [ConfidentialityLabel.atLeastAsRestrictive]
    intro clause hclause
    sorry -- Requires showing new clause is subset of old
  · -- Integrity unchanged
    intro a ha
    exact ha

/-- Shrinking expiration is always a valid update -/
theorem earlier_expiration_valid_update
    (l : Label)
    (newExp : Timestamp)
    (clauseIndex : Nat)
    (h : clauseIndex < l.confidentiality.length)
    (hexp : ∃ oldExp, .expires oldExp ∈ l.confidentiality[clauseIndex]! ∧ newExp ≤ oldExp) :
    isValidLabelUpdate l
      { l with confidentiality :=
          l.confidentiality.take clauseIndex ++
          [l.confidentiality[clauseIndex]!.map (fun a =>
            match a with
            | .expires _ => .expires newExp
            | other => other)] ++
          l.confidentiality.drop (clauseIndex + 1) } := by
  simp [isValidLabelUpdate, Label.atLeastAsRestrictive]
  sorry -- Earlier expiration is more restrictive

/-!
## Write Compatibility
-/

/-- Data can be written to a store if its label is covered by the store's label -/
def canWriteToStore (dataLabel storeLabel : Label) : Bool :=
  storeLabel.atLeastAsRestrictive dataLabel

/-- Writing data with compatible label preserves store invariants -/
theorem write_preserves_invariants
    (store : Store α)
    (newValue : α)
    (dataLabel : Label)
    (h : canWriteToStore dataLabel store.label) :
    -- The store label remains valid for the new data
    ∀ p, p.canAccess store.label → p.canAccess dataLabel := by
  intro p hp
  simp [canWriteToStore] at h
  exact valid_update_preserves_restrictiveness dataLabel store.label h p hp

/-- Writing more sensitive data requires upgrading store label -/
theorem sensitive_write_requires_upgrade
    (store : Store α)
    (dataLabel : Label)
    (h : !canWriteToStore dataLabel store.label) :
    -- Must upgrade store label first
    ∃ newStoreLabel,
      canWriteToStore dataLabel newStoreLabel ∧
      isValidLabelUpdate store.label newStoreLabel := by
  -- The new store label is the join of current and data labels
  use store.label.join dataLabel
  constructor
  · -- Data label is covered by join
    simp [canWriteToStore, Label.atLeastAsRestrictive]
    simp [Label.join, ConfidentialityLabel.join]
    simp [ConfidentialityLabel.atLeastAsRestrictive]
    constructor
    · intro clause hclause
      use clause
      constructor
      · exact List.mem_append.mpr (Or.inr hclause)
      · simp [Clause.atLeastAsRestrictive]
    · -- Integrity is meet, so data integrity atoms are in result
      simp [IntegrityLabel.meet]
      intro a ha
      simp [List.mem_filter]
      sorry -- Requires showing a is in both
  · -- Join is a valid upgrade (more restrictive)
    simp [isValidLabelUpdate, Label.atLeastAsRestrictive]
    simp [Label.join, ConfidentialityLabel.join]
    simp [ConfidentialityLabel.atLeastAsRestrictive]
    constructor
    · intro clause hclause
      use clause
      constructor
      · exact List.mem_append.mpr (Or.inl hclause)
      · simp [Clause.atLeastAsRestrictive]
    · simp [IntegrityLabel.meet, List.mem_filter]
      intro a ha
      exact ⟨ha, sorry⟩  -- Need to show a is in store.label.integrity

/-!
## Schema Evolution
-/

/-- Schema evolution must preserve label monotonicity -/
structure SchemaEvolution where
  oldVersion : String
  newVersion : String
  oldLabels : List (String × Label)  -- path -> label
  newLabels : List (String × Label)
  deriving Repr

/-- Check if schema evolution is valid -/
def SchemaEvolution.isValid (evolution : SchemaEvolution) : Bool :=
  -- Every existing path must have at-least-as-restrictive label
  evolution.oldLabels.all (fun (path, oldLabel) =>
    match evolution.newLabels.find? (fun (p, _) => p == path) with
    | some (_, newLabel) => newLabel.atLeastAsRestrictive oldLabel
    | none => true  -- Path removed is ok (data at that path remains with old label)
  )

/-- Valid schema evolution preserves access control -/
theorem schema_evolution_preserves_access
    (evolution : SchemaEvolution)
    (h : evolution.isValid)
    (path : String)
    (oldLabel : Label)
    (holdPath : (path, oldLabel) ∈ evolution.oldLabels) :
    match evolution.newLabels.find? (fun (p, _) => p == path) with
    | some (_, newLabel) => ∀ p, p.canAccess newLabel → p.canAccess oldLabel
    | none => True := by
  simp [SchemaEvolution.isValid] at h
  split
  · intro newLabel hnew p hp
    have : newLabel.atLeastAsRestrictive oldLabel := by
      sorry -- From h and the path lookup
    exact valid_update_preserves_restrictiveness oldLabel newLabel this p hp
  · trivial

/-!
## Expiration Cascade
-/

/-- When a cell expires, the expiration cascades to dependents -/
structure ExpirationCascade where
  expiredCell : Reference
  dependents : List Reference
  expiredAt : Timestamp
  deriving Repr

/-- All dependents must be marked expired -/
def ExpirationCascade.allDependentsExpired
    (cascade : ExpirationCascade)
    (getLabel : Reference → Label) : Bool :=
  cascade.dependents.all (fun dep =>
    getLabel dep |>.confidentiality.any (fun clause =>
      clause.any (fun a =>
        match a with
        | .expires t => t ≤ cascade.expiredAt
        | _ => false)))

/-- Expiration cascade preserves safety -/
theorem expiration_cascade_safe
    (cascade : ExpirationCascade)
    (getLabel : Reference → Label)
    (h : cascade.allDependentsExpired getLabel)
    (p : Principal)
    (hnow : p.now > cascade.expiredAt) :
    -- No principal can access expired data
    ∀ dep ∈ cascade.dependents,
      (getLabel dep).confidentiality.any (fun clause =>
        clause.any (fun a =>
          match a with
          | .expires t => t < p.now
          | _ => false)) := by
  intro dep hdep
  simp [ExpirationCascade.allDependentsExpired] at h
  have := h dep hdep
  -- The dependent has an expires atom ≤ cascade.expiredAt < p.now
  sorry -- Requires showing the expires atom exists and is expired

end CFC
