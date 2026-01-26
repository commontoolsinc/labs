import Std

import Cfc.LabelTransitions

namespace Cfc

namespace Proofs
namespace LabelTransitions

open Cfc

/-
This file proves small "preservation" lemmas about the Chapter 8 transition functions
defined in `Cfc.LabelTransitions`.

These are not deep security theorems by themselves; instead they are the *building blocks*
that let later scenario proofs talk about transitions compositionally.

Style note for new Lean readers:
- Most proofs here are `simp` proofs. `simp` is Lean's term rewriter/simplifier.
  It repeatedly applies definitional unfoldings and lemmas tagged `[simp]`.
- When you see `rfl`, read it as "true by definition".
- `classical` enables classical logic and, more importantly here, gives Lean extra
  decision procedures for equalities/membership that make `simp` much more effective.
-/

/-
`scopeIntegrity` is defined as `List.map (Atom.scoped path ·)`.

So this lemma is the direct correspondence you'd expect:

  `scoped path a` is in `map (scoped path ·) I`  iff  `a` is in `I`.

In prose: scoping is a 1-to-1 wrapper around integrity atoms; it doesn't drop or add atoms,
it just changes their shape.
-/
theorem mem_scopeIntegrity (path : List String) (a : Atom) (I : IntegLabel) :
    Atom.scoped path a ∈ LabelTransition.scopeIntegrity path I ↔ a ∈ I := by
  classical
  simp [LabelTransition.scopeIntegrity]

/-
`exactCopyOf` returns `some ...` exactly in the success case of its runtime check.

The statement is a standard "characterization lemma":

  exactCopyOf pc inputRef outputRef input = some out
    iff (inputRef = outputRef) AND (out is the expected output label).

Proof idea:
- Do case analysis on whether `inputRef = outputRef`.
- In the equality case, `exactCopyOf` reduces to `some (passThrough pc input)`.
- In the inequality case, it reduces to `none`, so it cannot equal `some out`.

The only slightly fiddly part is that `simp` sometimes produces the equality
`passThrough pc input = out` while we want `out = passThrough pc input`.
We add `eq_comm` to let `simp` rewrite in either direction.
-/
theorem exactCopyOf_eq_some_iff {Ref : Type} [DecidableEq Ref]
    (pc : ConfLabel) (inputRef outputRef : Ref) (input out : Label) :
    LabelTransition.exactCopyOf pc inputRef outputRef input = some out ↔
      inputRef = outputRef ∧ out = LabelTransition.passThrough pc input := by
  classical
  by_cases h : inputRef = outputRef
  · subst h
    simp [LabelTransition.exactCopyOf, eq_comm]
  · simp [LabelTransition.exactCopyOf, h]

/-
Similarly, `exactCopyOf = none` precisely when the reference check fails.

Again the proof is by a case split on `inputRef = outputRef`, and then `simp`.
-/
theorem exactCopyOf_eq_none_iff {Ref : Type} [DecidableEq Ref]
    (pc : ConfLabel) (inputRef outputRef : Ref) (input : Label) :
    LabelTransition.exactCopyOf pc inputRef outputRef input = none ↔ inputRef ≠ outputRef := by
  classical
  by_cases h : inputRef = outputRef
  · subst h
    simp [LabelTransition.exactCopyOf]
  · simp [LabelTransition.exactCopyOf, h]

/-
`combinedFrom` is defined by pattern-matching on the input list.
So the empty-list case is definitional (`rfl`).
-/
@[simp] theorem combinedFrom_nil (pc : ConfLabel) :
    LabelTransition.combinedFrom pc [] = LabelTransition.taintPc pc Label.bot := rfl

/-
For a singleton list, the fold does nothing: you just get the one label, tainted by `pc`.
-/
@[simp] theorem combinedFrom_singleton (pc : ConfLabel) (ℓ : Label) :
    LabelTransition.combinedFrom pc [ℓ] = LabelTransition.taintPc pc ℓ := by
  simp [LabelTransition.combinedFrom]

/-
PC-taint preservation lemma:

No matter what inputs you combine, the resulting confidentiality contains *all clauses* from `pc`.

This is the "flow-path confidentiality always propagates" property:
it is exactly what 8.9 requires, and later safety proofs rely on it.

Proof idea:
- If the list is empty, unfold `combinedFrom`, which is `taintPc pc Label.bot`,
  and then membership in `pc ++ []` is immediate.
- If nonempty, unfold `combinedFrom` just enough to see the outer `taintPc pc ...`,
  and then use `List.mem_append.2 (Or.inl ...)` to inject membership from the left side.
-/
theorem pc_subset_combinedFrom_conf (pc : ConfLabel) (inputs : List Label) :
    pc ⊆ (LabelTransition.combinedFrom pc inputs).conf := by
  intro c hc
  cases inputs with
  | nil =>
    simpa [LabelTransition.combinedFrom, LabelTransition.taintPc, Label.bot] using hc
  | cons ℓ rest =>
    -- `taintPc` prefixes `pc`.
    exact List.mem_append.2 (Or.inl (by simpa [LabelTransition.combinedFrom, LabelTransition.taintPc] using hc))

end LabelTransitions
end Proofs

end Cfc
