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

There is also a source-carrying variant `scopeIntegrityFrom` defined as
`List.map (Atom.scopedFrom source path ·)`, which is used for safe recomposition proofs.

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
Membership lemma for the source-carrying scoping function:

  scopedFrom source path a ∈ scopeIntegrityFrom source path I   <->   a ∈ I

Same proof as the un-sourced version: it's just `List.map`.
-/
theorem mem_scopeIntegrityFrom (source : Nat) (path : List String) (a : Atom) (I : IntegLabel) :
    Atom.scopedFrom source path a ∈ LabelTransition.scopeIntegrityFrom source path I ↔ a ∈ I := by
  classical
  simp [LabelTransition.scopeIntegrityFrom]

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

/-
If `verifyRecomposeProjections` succeeds (`= true`), then each part really contains the required
scoped integrity atom.

This is the direct `List.all` soundness lemma.
-/
theorem verifyRecomposeProjections_of_mem {source : Nat} {base : Atom} {parts : List (List String × Label)}
    (h : LabelTransition.verifyRecomposeProjections source base parts = true) :
    ∀ pl, pl ∈ parts → Atom.scopedFrom source pl.1 base ∈ pl.2.integ := by
  classical
  intro pl hpl
  have hAll : parts.all (fun pl => decide (Atom.scopedFrom source pl.1 base ∈ pl.2.integ)) = true := by
    simpa [LabelTransition.verifyRecomposeProjections] using h
  -- Use the standard `List.all_eq_true` characterization.
  have hPred : ∀ pl, pl ∈ parts → decide (Atom.scopedFrom source pl.1 base ∈ pl.2.integ) = true := by
    simpa [List.all_eq_true] using hAll
  have : decide (Atom.scopedFrom source pl.1 base ∈ pl.2.integ) = true := hPred pl hpl
  exact of_decide_eq_true this

/-
If recomposition returns `some out`, then the output integrity contains the "whole object"
atom `scopedFrom source [] base`.

This is the key "safe recomposition restores integrity" fact.
-/
theorem mem_recomposeFromProjections_whole_of_eq_some
    (pc : ConfLabel) (source : Nat) (base : Atom) (parts : List (List String × Label)) (out : Label)
    (h : LabelTransition.recomposeFromProjections pc source base parts = some out) :
    Atom.scopedFrom source [] base ∈ out.integ := by
  classical
  cases hv : LabelTransition.verifyRecomposeProjections source base parts with
  | false =>
    -- If verification is false, recomposition returns `none`, contradiction.
    have h' := h
    -- With `hv = false`, `recomposeFromProjections ... = none`, so `h` becomes `none = some out`.
    simp [LabelTransition.recomposeFromProjections, hv] at h'
    -- `simp` reduces `none = some out` to `False` and closes the goal by contradiction.
  | true =>
    -- Successful branch: `out` is definitionally the constructed label.
    have : some { (LabelTransition.combinedFrom pc (parts.map Prod.snd)) with
        integ := (LabelTransition.combinedFrom pc (parts.map Prod.snd)).integ ++
          [Atom.scopedFrom source [] base] } = some out := by
      simpa [LabelTransition.recomposeFromProjections, hv] using h
    have hout :
        { (LabelTransition.combinedFrom pc (parts.map Prod.snd)) with
          integ := (LabelTransition.combinedFrom pc (parts.map Prod.snd)).integ ++
            [Atom.scopedFrom source [] base] } = out := by
      exact Option.some.inj this
    -- Conclude by rewriting and using list membership of append.
    subst hout
    simp

end LabelTransitions
end Proofs

end Cfc
