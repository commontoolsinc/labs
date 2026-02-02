import Std

import Cfc.Label

namespace Cfc

/-
This file defines the "who can read what?" notion used throughout the repo.

We keep it intentionally simple:
- A `Principal` is an abstract viewer, with:
  - `now : Nat` (for expiration checks)
  - `atoms : List Atom` (the facts/roles/authorities they hold)
- A principal can "satisfy" most atoms just by possessing them (`a ∈ p.atoms`).
- The special case is `Atom.expires t`, which is satisfied when `p.now ≤ t`.

Confidentiality labels are CNF (see `Cfc.Label`), so `canAccessConf` says:
"for every clause in the CNF, the principal can satisfy the clause".

This is the standard AND-of-ORs reading:
- each clause is an OR (pick some atom in it that you satisfy),
- the label is an AND (you must satisfy every clause).
-/

structure Principal where
  now : Nat
  atoms : List Atom
  deriving Repr

namespace Principal

def satisfies (p : Principal) (a : Atom) : Prop :=
  match a with
  | .expires t => p.now ≤ t
  | _ => a ∈ p.atoms

/-
Monotonicity of satisfaction under "adding more atoms":

If two principals have the same time (`now`) and `p₂` has *at least* the atoms of `p₁`,
then anything satisfied by `p₁` is also satisfied by `p₂`.

This is used all over the place when we show that certain rewrites/exchanges cannot
make something *less* accessible.

Proof sketch:
- Case split on the atom `a`.
- If it's `expires t`, satisfaction depends only on `now`, so `hNow` suffices.
- Otherwise it's a membership fact, and we use `hAtoms : p₁.atoms ⊆ p₂.atoms`.

Lean details:
- `cases a` does the case split on constructors of `Atom`.
- `simp [Principal.satisfies]` unfolds satisfaction and simplifies the goal.
- The `first | ... | ...` block tries the membership case first, then the expiration case.
-/
theorem satisfies_mono_atoms {p₁ p₂ : Principal} {a : Atom}
    (hNow : p₁.now = p₂.now) (hAtoms : p₁.atoms ⊆ p₂.atoms)
    (h : p₁.satisfies a) : p₂.satisfies a := by
  cases a <;> simp [Principal.satisfies] at h ⊢
  all_goals
    first
    | exact hAtoms h
    | simpa [hNow] using h

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
