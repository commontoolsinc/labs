/-
  CFC/Atom.lean
  Parameterized atoms as defined in Section 4.1 of the CFC spec.

  Atoms are the building blocks of labels. They represent principals,
  resources, temporal constraints, and other security-relevant properties.
-/

import CFC.Basic

namespace CFC

/-- Role in a space (Section 3.6.2) -/
inductive SpaceRole where
  | owner
  | writer
  | reader
  deriving DecidableEq, Repr

/-- Role hierarchy: owner ⊃ writer ⊃ reader -/
def SpaceRole.implies (r₁ r₂ : SpaceRole) : Bool :=
  match r₁, r₂ with
  | .owner, _ => true
  | .writer, .writer => true
  | .writer, .reader => true
  | .reader, .reader => true
  | _, _ => false

theorem SpaceRole.implies_refl (r : SpaceRole) : r.implies r = true := by
  cases r <;> rfl

theorem SpaceRole.implies_trans (r₁ r₂ r₃ : SpaceRole) :
    r₁.implies r₂ = true → r₂.implies r₃ = true → r₁.implies r₃ = true := by
  intro h12 h23
  cases r₁ <;> cases r₂ <;> cases r₃ <;> simp [implies] at * <;> trivial

/-- Space identifier -/
structure SpaceID where
  value : String
  deriving DecidableEq, Repr

/-- Parameterized atoms (Section 4.1.2)

    This is a simplified representation focusing on the atoms
    needed for the core proofs. The full spec has many more atom types.
-/
inductive Atom where
  /-- User principal -/
  | user (subject : DID)
  /-- Service principal -/
  | service (subject : DID)
  /-- Space principal -/
  | space (id : SpaceID)
  /-- Personal space (equivalent to per-user space) -/
  | personalSpace (owner : DID)
  /-- Context/Policy principal (with hash binding) -/
  | context (name : String) (subject : DID) (hash : Option ContentHash)
  /-- Resource classification -/
  | resource (class_ : String) (subject : DID)
  /-- Temporal constraint: expires at timestamp -/
  | expires (timestamp : Timestamp)
  /-- Code hash integrity -/
  | codeHash (hash : ContentHash)
  /-- Authored by (provenance) -/
  | authoredBy (sender : DID) (messageId : Option String)
  /-- Endorsed by (user action) -/
  | endorsedBy (endorser : DID) (action : Option String)
  /-- Has role in space -/
  | hasRole (principal : DID) (space : SpaceID) (role : SpaceRole)
  /-- Multi-party result -/
  | multiPartyResult (participants : List DID)
  /-- Policy certified -/
  | policyCertified (policyId : String)
  /-- Transformed by (computation provenance) -/
  | transformedBy (codeHash : ContentHash)
  deriving DecidableEq, Repr

/-- Atom equality is decidable -/
instance : DecidableEq Atom := inferInstance

/-- Check if an atom represents a temporal constraint -/
def Atom.isTemporal : Atom → Bool
  | .expires _ => true
  | _ => false

/-- Check if an atom is a policy/context principal -/
def Atom.isPolicyPrincipal : Atom → Bool
  | .context _ _ _ => true
  | _ => false

/-- Get the subject DID from an atom (if applicable) -/
def Atom.subject? : Atom → Option DID
  | .user s => some s
  | .service s => some s
  | .personalSpace o => some o
  | .context _ s _ => some s
  | .resource _ s => some s
  | .authoredBy s _ => some s
  | .endorsedBy e _ => some e
  | .hasRole p _ _ => some p
  | _ => none

/-- Atoms can be compared structurally -/
def Atom.structuralEq (a b : Atom) : Bool := a == b

/-- Two atoms are comparable in the lattice if they have the same type
    or one is a policy principal that declares ordering with another.
    For most atoms, ordering is flat. -/
def Atom.comparable (a b : Atom) : Bool :=
  match a, b with
  | .user _, .user _ => true
  | .space _, .space _ => true
  | .context _ _ _, .context _ _ _ => true
  | .expires _, .expires _ => true
  | _, _ => a == b

/-- For Expires atoms, earlier timestamp is more restrictive -/
def Atom.expiresOrder (a b : Atom) : Bool :=
  match a, b with
  | .expires t₁, .expires t₂ => t₁ ≤ t₂
  | _, _ => false

end CFC
