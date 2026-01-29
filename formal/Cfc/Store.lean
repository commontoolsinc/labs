import Std

import Cfc.Access

namespace Cfc

/-!
Store label monotonicity (spec 8.12).

The CFC "store" is a persistent cell whose label must not get weaker over time.
The security intuition is standard:

- If you ever write secret data into a cell, you must not later downgrade the cell
  and allow a less-authorized principal to read it.
- Conversely, it is always safe to *tighten* a cell's label.

The spec phrase is:
  "Stores have labels that must be monotonically non-decreasing over their lifetime."

This file formalizes the two ingredients behind that claim:

1) A "more restrictive" relation on confidentiality CNF labels.
   - Adding clauses makes a CNF more restrictive (harder to satisfy).
   - Removing alternatives inside a clause makes it more restrictive.
   - Special case: `expires t` atoms are ordered by time:
       `expires t2` is more restrictive than `expires t1` when `t2 <= t1`
     because fewer principals (times) satisfy it.

2) A "weaker claims" relation on integrity labels.
   - Integrity is not an access restriction but an evidence/claim set.
   - For persistent storage, it is always safe to *drop* integrity claims.
     (The store can become less trusted; it must not become more trusted "for free".)

The resulting predicate `canUpdateStoreLabel` matches the spec's `canUpdateStoreLabel`:
- confidentiality can only become more restrictive;
- integrity can only lose atoms.

We also provide executable (`Bool`) checkers mirroring the spec's pseudocode style,
and prove that these checkers are sound with respect to access semantics.
-/

namespace StoreLabel

/-!
## 1) Atom-level restrictiveness

At the clause level, "more restrictive" means "fewer ways to satisfy".
That suggests comparing alternatives (atoms) by implication:

  if satisfying `a_new` always implies satisfying `a_old`,
  then `a_new` is at least as restrictive as `a_old`.

For most atoms, the only implication we allow is equality.
The one special atom is `expires t`, whose semantics depends on time.

In the access semantics (`Cfc.Access`):
  p.satisfies (expires t)  iff  p.now <= t
So `expires t2` implies `expires t1` exactly when `t2 <= t1`.
-/

/-- `AtomLe aNew aOld` means: satisfying `aNew` implies satisfying `aOld`. -/
def AtomLe (aNew aOld : Atom) : Prop :=
  match aNew, aOld with
  | .expires tNew, .expires tOld => tNew ≤ tOld
  | _, _ => aNew = aOld

@[simp] theorem AtomLe_refl (a : Atom) : AtomLe a a := by
  cases a <;> simp [AtomLe]

/--
Soundness of `AtomLe` with respect to `Principal.satisfies`.

This is the key lemma that makes the later CNF lemmas go through.
-/
theorem Principal.satisfies_of_AtomLe {p : Principal} {aNew aOld : Atom}
    (h : AtomLe aNew aOld) (hSat : p.satisfies aNew) : p.satisfies aOld := by
  -- We only need to distinguish the `expires` constructor from everything else.
  -- For non-`expires` atoms, `AtomLe` is equality, so the result is just rewriting.
  cases aNew with
  | expires tNew =>
    cases aOld with
    | expires tOld =>
      -- `now <= tNew` and `tNew <= tOld` implies `now <= tOld`.
      simpa [AtomLe, Principal.satisfies] using Nat.le_trans hSat h
    | _ =>
      -- Impossible: `expires tNew = <non-expires>` cannot hold.
      cases h
  | _ =>
    cases aOld with
    | expires tOld =>
      -- Impossible: `<non-expires> = expires tOld` cannot hold.
      cases h
    | _ =>
      -- Equality case: rewrite.
      -- `cases h` can either:
      -- - rewrite `aOld` to `aNew` (when the equality is actually consistent), leaving us
      --   with the original assumption `hSat`, or
      -- - close the goal immediately (when the equality is impossible because constructors differ).
      --
      -- The `<;>` ensures we only run `simpa` on goals that still exist after `cases h`.
      cases h <;> simpa using hSat

/-!
Executable version, for "checked" runtime-like code.

We keep the executable checker as close as possible to `AtomLe`.
-/
def atomLeB (aNew aOld : Atom) : Bool :=
  match aNew, aOld with
  | .expires tNew, .expires tOld => decide (tNew ≤ tOld)
  | _, _ => decide (aNew = aOld)

theorem AtomLe_of_atomLeB {aNew aOld : Atom} (h : atomLeB aNew aOld = true) : AtomLe aNew aOld := by
  -- We'll case-split on the atom constructors. This looks like a lot of cases, but the proof
  -- body is the same everywhere: unfold the executable checker and the spec-level relation,
  -- then convert `decide (...) = true` into the corresponding proposition.
  --
  -- In "mismatched constructor" cases, `simp` will reduce the boolean equality to `False`,
  -- which immediately closes the goal (these situations cannot happen at runtime anyway).
  cases aNew <;> cases aOld <;> simp [atomLeB, AtomLe] at h ⊢
  all_goals
    -- After `simp`, the hypothesis `h` has already been converted from
    -- `decide (...) = true` into the underlying proposition itself.
    -- So the goal is solved by `exact h`.
    exact h

/-!
## 2) Clause-level restrictiveness

A clause is a disjunction of atoms (OR).
To make a clause more restrictive, we must reduce the set of alternatives.

In the spec pseudocode, this is:

  proposedAlts.every(alt => currentAlts.some(c => atomEquals(c, alt)))

We generalize `atomEquals` to `AtomLe` to support the `expires` ordering.

`ClauseLe cur prop` means:
  every alternative in `prop` is subsumed by some alternative in `cur`

So `prop` is at least as restrictive as `cur`.
-/

/-- `ClauseLe cur prop` means: the clause `prop` is at least as restrictive as `cur`. -/
def ClauseLe (cur prop : Clause) : Prop :=
  ∀ aNew, aNew ∈ prop → ∃ aOld, aOld ∈ cur ∧ AtomLe aNew aOld

theorem ClauseLe_refl (c : Clause) : ClauseLe c c := by
  intro a ha
  refine ⟨a, ha, ?_⟩
  exact AtomLe_refl a

def clauseLeB (cur prop : Clause) : Bool :=
  prop.all (fun aNew => cur.any (fun aOld => atomLeB aNew aOld))

theorem ClauseLe_of_clauseLeB {cur prop : Clause} (h : clauseLeB cur prop = true) : ClauseLe cur prop := by
  classical
  intro aNew haNew
  have : (cur.any (fun aOld => atomLeB aNew aOld)) = true := by
    -- `List.all_eq_true` gives the property for every element of `prop`.
    have hall : prop.all (fun aNew => cur.any (fun aOld => atomLeB aNew aOld)) = true := h
    have := List.all_eq_true.1 hall aNew haNew
    simpa [clauseLeB] using this
  -- `List.any_eq_true` gives the witness in `cur`.
  rcases List.any_eq_true.1 this with ⟨aOld, haOld, hLeB⟩
  exact ⟨aOld, haOld, AtomLe_of_atomLeB hLeB⟩

/--
If `prop` is at least as restrictive as `cur`, then any principal who can satisfy `prop`
can satisfy `cur`.
-/
theorem clauseSat_mono {p : Principal} {cur prop : Clause}
    (hLe : ClauseLe cur prop) (hSat : clauseSat p prop) : clauseSat p cur := by
  rcases hSat with ⟨aNew, haNew, hPSat⟩
  rcases hLe aNew haNew with ⟨aOld, haOld, hAtomLe⟩
  refine ⟨aOld, haOld, ?_⟩
  exact Principal.satisfies_of_AtomLe (p := p) hAtomLe hPSat

/-!
## 3) CNF-level restrictiveness

A confidentiality label is a CNF: a list of clauses (AND).

The spec's monotonicity check says:
  every current clause must have a corresponding proposed clause that is at least as restrictive
  (and proposed may have additional clauses).

We model this as `ConfLe cur prop`:
  for every clause `c` in `cur`, there exists a clause `c'` in `prop` such that `ClauseLe c c'`.

This makes `prop` at least as restrictive as `cur`, i.e.:
  canAccessConf p prop -> canAccessConf p cur
-/

/-- `ConfLe cur prop` means: `prop` is at least as restrictive as `cur`. -/
def ConfLe (cur prop : ConfLabel) : Prop :=
  ∀ cCur, cCur ∈ cur → ∃ cProp, cProp ∈ prop ∧ ClauseLe cCur cProp

def confLeB (cur prop : ConfLabel) : Bool :=
  cur.all (fun cCur => prop.any (fun cProp => clauseLeB cCur cProp))

theorem ConfLe_of_confLeB {cur prop : ConfLabel} (h : confLeB cur prop = true) : ConfLe cur prop := by
  classical
  intro cCur hcCur
  have : (prop.any (fun cProp => clauseLeB cCur cProp)) = true := by
    have hall : cur.all (fun cCur => prop.any (fun cProp => clauseLeB cCur cProp)) = true := h
    have := List.all_eq_true.1 hall cCur hcCur
    simpa [confLeB] using this
  rcases List.any_eq_true.1 this with ⟨cProp, hcProp, hClause⟩
  exact ⟨cProp, hcProp, ClauseLe_of_clauseLeB hClause⟩

theorem canAccessConf_mono_of_ConfLe {p : Principal} {cur prop : ConfLabel}
    (hLe : ConfLe cur prop) (hAcc : canAccessConf p prop) : canAccessConf p cur := by
  intro cCur hcCur
  rcases hLe cCur hcCur with ⟨cProp, hcProp, hClauseLe⟩
  have hSatProp : clauseSat p cProp := hAcc cProp hcProp
  exact clauseSat_mono (p := p) hClauseLe hSatProp

/-!
## 4) Integrity monotonicity for stores

For stores, we allow integrity to lose atoms but not gain new claims.
So "store-integrity monotonicity" is just subset.
-/

def IntegLe (new old : IntegLabel) : Prop :=
  new ⊆ old

def integLeB (new old : IntegLabel) : Bool :=
  new.all (fun a => decide (a ∈ old))

theorem IntegLe_of_integLeB {new old : IntegLabel} (h : integLeB new old = true) : IntegLe new old := by
  classical
  intro a ha
  have : decide (a ∈ old) = true := by
    have hall : new.all (fun a => decide (a ∈ old)) = true := h
    have := List.all_eq_true.1 hall a ha
    simpa [integLeB] using this
  simpa using of_decide_eq_true this

/-!
## 5) The store-label update predicate

Putting confidentiality + integrity together gives the spec's update rule:

  canUpdateStoreLabel current proposed

Meaning:
- proposed confidentiality is at least as restrictive as current confidentiality, and
- proposed integrity is a subset of current integrity.
-/

def canUpdateStoreLabel (current proposed : Label) : Prop :=
  ConfLe current.conf proposed.conf ∧ IntegLe proposed.integ current.integ

def canUpdateStoreLabelB (current proposed : Label) : Bool :=
  confLeB current.conf proposed.conf && integLeB proposed.integ current.integ

theorem canUpdateStoreLabel_of_canUpdateStoreLabelB {current proposed : Label}
    (h : canUpdateStoreLabelB current proposed = true) : canUpdateStoreLabel current proposed := by
  -- Avoid relying on lemma names about `&&`; just case-split on the two booleans.
  have hSplit : confLeB current.conf proposed.conf = true ∧
      integLeB proposed.integ current.integ = true := by
    cases hConf : confLeB current.conf proposed.conf <;>
    cases hInteg : integLeB proposed.integ current.integ <;>
    simp [canUpdateStoreLabelB, hConf, hInteg] at h
    exact ⟨rfl, rfl⟩
  exact ⟨ConfLe_of_confLeB hSplit.1, IntegLe_of_integLeB hSplit.2⟩

theorem canAccess_mono_of_canUpdateStoreLabel {p : Principal} {current proposed : Label}
    (hUp : canUpdateStoreLabel current proposed) (hAcc : canAccess p proposed) : canAccess p current := by
  -- only confidentiality matters for `canAccess`
  exact canAccessConf_mono_of_ConfLe (p := p) hUp.1 hAcc

/-!
## 6) A tiny store model (optional, but useful for examples)

We keep a store/cell as just a labeled value.

This is not a full reactive store semantics; it's enough to state the monotonicity properties
in the style of the spec (8.12.4: writers/readers).
-/

structure StoreCell (α : Type) where
  value : α
  label : Label
  deriving Repr

/-- Writing is allowed if the store label is at least as restrictive as the data's confidentiality. -/
def canWrite {α : Type} (data : Label) (store : StoreCell α) : Prop :=
  ConfLe data.conf store.label.conf

/-!
Convenient upgrade: when we want to store a value with label `data` into a store with label `store`,
we can conservatively upgrade the store label by joining it with `data`.

This is monotone by construction: confidentiality only gains clauses; integrity only loses atoms.
-/
def upgradeLabel (storeLbl dataLbl : Label) : Label :=
  storeLbl + dataLbl

end StoreLabel

end Cfc
