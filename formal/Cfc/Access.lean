import Std

import Cfc.Label

namespace Cfc

structure Principal where
  now : Nat
  atoms : List Atom
  deriving Repr

namespace Principal

def satisfies (p : Principal) (a : Atom) : Prop :=
  match a with
  | .expires t => p.now ≤ t
  | _ => a ∈ p.atoms

theorem satisfies_mono_atoms {p₁ p₂ : Principal} {a : Atom}
    (hNow : p₁.now = p₂.now) (hAtoms : p₁.atoms ⊆ p₂.atoms)
    (h : p₁.satisfies a) : p₂.satisfies a := by
  cases a with
  | expires t =>
    simpa [Principal.satisfies, hNow] using h
  | user did =>
    exact hAtoms h
  | policy name subject hash =>
    exact hAtoms h
  | integrityTok name =>
    exact hAtoms h
  | other name =>
    exact hAtoms h

end Principal

def clauseSat (p : Principal) (c : Clause) : Prop :=
  ∃ a, a ∈ c ∧ p.satisfies a

def canAccessConf (p : Principal) (C : ConfLabel) : Prop :=
  ∀ c, c ∈ C → clauseSat p c

def canAccess (p : Principal) (ℓ : Label) : Prop :=
  canAccessConf p ℓ.conf

theorem canAccessConf_of_subset {p : Principal} {C₁ C₂ : ConfLabel}
    (hC : C₁ ⊆ C₂) (h : canAccessConf p C₂) : canAccessConf p C₁ := by
  intro c hc
  exact h c (hC hc)

theorem canAccessConf_append_iff (p : Principal) (C₁ C₂ : ConfLabel) :
    canAccessConf p (C₁ ++ C₂) ↔ canAccessConf p C₁ ∧ canAccessConf p C₂ := by
  constructor
  · intro h
    refine ⟨?_, ?_⟩
    ·
      exact canAccessConf_of_subset (by
        intro c hc
        exact List.mem_append.2 (Or.inl hc)
      ) h
    ·
      exact canAccessConf_of_subset (by
        intro c hc
        exact List.mem_append.2 (Or.inr hc)
      ) h
  · rintro ⟨h₁, h₂⟩ c hc
    have : c ∈ C₁ ∨ c ∈ C₂ := by
      simpa [List.mem_append] using hc
    cases this with
    | inl hc1 => exact h₁ c hc1
    | inr hc2 => exact h₂ c hc2

theorem canAccess_join_iff (p : Principal) (ℓ₁ ℓ₂ : Label) :
    canAccess p (ℓ₁ + ℓ₂) ↔ canAccess p ℓ₁ ∧ canAccess p ℓ₂ := by
  simpa [canAccess, Label.join] using canAccessConf_append_iff p ℓ₁.conf ℓ₂.conf

end Cfc

