import Std

import Cfc.Atom

namespace Cfc

/-!
Core label model (minimal, but aligned with the CFC spec):

- Confidentiality: CNF, represented as a list of clauses.
  - Clause = OR of atoms (list of alternatives).
  - ConfLabel = AND of clauses (list; join is concatenation).

- Integrity: conjunction of atoms (list; join is intersection).

This is intentionally lightweight: we avoid `Finset`/mathlib and keep everything in `Std`.
-/

abbrev Clause := List Atom
abbrev ConfLabel := List Clause
abbrev IntegLabel := List Atom

structure Label where
  conf : ConfLabel
  integ : IntegLabel
  deriving Repr

namespace Label

def bot : Label := { conf := [], integ := [] }

def joinIntegrity (I₁ I₂ : IntegLabel) : IntegLabel :=
  I₁.filter (fun a => decide (a ∈ I₂))

theorem mem_joinIntegrity (a : Atom) (I₁ I₂ : IntegLabel) :
    a ∈ joinIntegrity I₁ I₂ ↔ a ∈ I₁ ∧ a ∈ I₂ := by
  classical
  simp [joinIntegrity]

/-- Endorsement integrity is additive at creation (spec 3.3): add extra facts to the value. -/
def endorseIntegrity (I : IntegLabel) (extra : IntegLabel) : IntegLabel :=
  I ++ extra

theorem mem_endorseIntegrity (a : Atom) (I extra : IntegLabel) :
    a ∈ endorseIntegrity I extra ↔ a ∈ I ∨ a ∈ extra := by
  simp [endorseIntegrity, List.mem_append]

/-- Add endorsement integrity to a label. Confidentiality is unchanged. -/
def endorse (ℓ : Label) (extra : IntegLabel) : Label :=
  { ℓ with integ := endorseIntegrity ℓ.integ extra }

@[simp] theorem conf_endorse (ℓ : Label) (extra : IntegLabel) :
    (endorse ℓ extra).conf = ℓ.conf := rfl

@[simp] theorem integ_endorse (ℓ : Label) (extra : IntegLabel) :
    (endorse ℓ extra).integ = ℓ.integ ++ extra := rfl

def join (ℓ₁ ℓ₂ : Label) : Label :=
  { conf := ℓ₁.conf ++ ℓ₂.conf
    integ := joinIntegrity ℓ₁.integ ℓ₂.integ }

instance : HAdd Label Label Label where
  hAdd := join

@[simp] theorem conf_join (ℓ₁ ℓ₂ : Label) : (ℓ₁ + ℓ₂).conf = ℓ₁.conf ++ ℓ₂.conf := rfl
@[simp] theorem integ_join (ℓ₁ ℓ₂ : Label) : (ℓ₁ + ℓ₂).integ = joinIntegrity ℓ₁.integ ℓ₂.integ := rfl

theorem join_assoc_conf (ℓ₁ ℓ₂ ℓ₃ : Label) :
    ((ℓ₁ + ℓ₂) + ℓ₃).conf = (ℓ₁ + (ℓ₂ + ℓ₃)).conf := by
  simp [List.append_assoc]

end Label

end Cfc
