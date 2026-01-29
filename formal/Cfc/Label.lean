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

How to read the types:

- `Clause := List Atom`
    A clause is a *disjunction* ("OR") of atoms.
    If a principal satisfies *any* atom in the clause, they satisfy the clause.

- `ConfLabel := List Clause`
    A confidentiality label is a *conjunction* ("AND") of clauses (CNF).
    A principal can read iff they satisfy *every* clause.

- `IntegLabel := List Atom`
    An integrity label is a conjunction of integrity atoms: each atom is a claim/evidence
    about provenance, authority, or invariants.

Why lists, not sets?

We use `List` instead of `Finset`/mathlib to keep the model small and self-contained.
This means:
- duplicates are possible (we generally ignore this and reason extensionally with membership),
- operations like "intersection" are implemented with `List.filter`,
- proofs are often simple `simp` rewrites over list membership.
-/

abbrev Clause := List Atom
abbrev ConfLabel := List Clause
abbrev IntegLabel := List Atom

structure Label where
  conf : ConfLabel
  integ : IntegLabel
  deriving Repr, DecidableEq

namespace Label

/-
`bot` is the "least restrictive" label in this model:
- confidentiality is empty CNF, meaning "no restrictions" (vacuously satisfied),
- integrity is empty, meaning "no claims".

This corresponds to "public + no integrity evidence".
-/
def bot : Label := { conf := [], integ := [] }

/-
Integrity join (spec 8.6.2) is *intersection*:
when combining values, we only keep integrity claims that were true of *both* inputs.

Because we represent integrity as lists, we implement intersection as:
  keep the atoms in `I₁` that are also in `I₂`.

`decide (a ∈ I₂)` is a Boolean decision procedure for membership (available because `Atom`
has `DecidableEq`).

Note: this intersection is not symmetric at the list level (it preserves the order from `I₁`),
but it is symmetric as a set-of-atoms, which is what we care about in most proofs.
-/
def joinIntegrity (I₁ I₂ : IntegLabel) : IntegLabel :=
  I₁.filter (fun a => decide (a ∈ I₂))

/-
Membership characterization for `joinIntegrity`:

  a ∈ joinIntegrity I₁ I₂   iff   (a ∈ I₁) AND (a ∈ I₂)

Proof idea:
- `List.filter` membership is `a ∈ I₁ ∧ predicate a = true`.
- Our predicate is `decide (a ∈ I₂)`, which is true exactly when `a ∈ I₂`.

`classical` makes it easier for `simp` to rewrite membership/decide facts.
-/
theorem mem_joinIntegrity (a : Atom) (I₁ I₂ : IntegLabel) :
    a ∈ joinIntegrity I₁ I₂ ↔ a ∈ I₁ ∧ a ∈ I₂ := by
  classical
  simp [joinIntegrity]

/-- Endorsement integrity is additive at creation (spec 3.3): add extra facts to the value. -/
def endorseIntegrity (I : IntegLabel) (extra : IntegLabel) : IntegLabel :=
  I ++ extra

/-
Membership characterization for endorsement integrity:

Appending lists corresponds to logical OR for membership:
  a is in (I ++ extra) iff (a in I) OR (a in extra).
-/
theorem mem_endorseIntegrity (a : Atom) (I extra : IntegLabel) :
    a ∈ endorseIntegrity I extra ↔ a ∈ I ∨ a ∈ extra := by
  simp [endorseIntegrity, List.mem_append]

/-- Add endorsement integrity to a label. Confidentiality is unchanged. -/
def endorse (ℓ : Label) (extra : IntegLabel) : Label :=
  { ℓ with integ := endorseIntegrity ℓ.integ extra }

/-
These two simp lemmas expose the fields of `endorse`.
They let later proofs rewrite `endorse` away without manual unfolding.
-/
@[simp] theorem conf_endorse (ℓ : Label) (extra : IntegLabel) :
    (endorse ℓ extra).conf = ℓ.conf := rfl

@[simp] theorem integ_endorse (ℓ : Label) (extra : IntegLabel) :
    (endorse ℓ extra).integ = ℓ.integ ++ extra := rfl

/-
Label join (spec 8.6):
- confidentiality joins by CNF conjunction, which is list concatenation
- integrity joins by intersection (`joinIntegrity`)

We also register `join` as the `HAdd` instance so we can write `ℓ₁ + ℓ₂`.
-/
def join (ℓ₁ ℓ₂ : Label) : Label :=
  { conf := ℓ₁.conf ++ ℓ₂.conf
    integ := joinIntegrity ℓ₁.integ ℓ₂.integ }

instance : HAdd Label Label Label where
  hAdd := join

/-
Field projections for join, marked `[simp]` so they are used automatically.
-/
@[simp] theorem conf_join (ℓ₁ ℓ₂ : Label) : (ℓ₁ + ℓ₂).conf = ℓ₁.conf ++ ℓ₂.conf := rfl
@[simp] theorem integ_join (ℓ₁ ℓ₂ : Label) : (ℓ₁ + ℓ₂).integ = joinIntegrity ℓ₁.integ ℓ₂.integ := rfl

/-
Confidentiality join is associative because list append is associative.

We prove only the `conf` field here; for integrity we generally reason with membership
characterizations rather than algebraic laws.
-/
theorem join_assoc_conf (ℓ₁ ℓ₂ ℓ₃ : Label) :
    ((ℓ₁ + ℓ₂) + ℓ₃).conf = (ℓ₁ + (ℓ₂ + ℓ₃)).conf := by
  simp [List.append_assoc]

end Label

end Cfc
