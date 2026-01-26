import Std

import Cfc.LabelTransitions

namespace Cfc

namespace Proofs
namespace LabelTransitions

open Cfc

theorem mem_scopeIntegrity (path : List String) (a : Atom) (I : IntegLabel) :
    Atom.scoped path a ∈ LabelTransition.scopeIntegrity path I ↔ a ∈ I := by
  classical
  simp [LabelTransition.scopeIntegrity]

theorem exactCopyOf_eq_some_iff {Ref : Type} [DecidableEq Ref]
    (pc : ConfLabel) (inputRef outputRef : Ref) (input out : Label) :
    LabelTransition.exactCopyOf pc inputRef outputRef input = some out ↔
      inputRef = outputRef ∧ out = LabelTransition.passThrough pc input := by
  classical
  by_cases h : inputRef = outputRef
  · subst h
    simp [LabelTransition.exactCopyOf, eq_comm]
  · simp [LabelTransition.exactCopyOf, h]

theorem exactCopyOf_eq_none_iff {Ref : Type} [DecidableEq Ref]
    (pc : ConfLabel) (inputRef outputRef : Ref) (input : Label) :
    LabelTransition.exactCopyOf pc inputRef outputRef input = none ↔ inputRef ≠ outputRef := by
  classical
  by_cases h : inputRef = outputRef
  · subst h
    simp [LabelTransition.exactCopyOf]
  · simp [LabelTransition.exactCopyOf, h]

@[simp] theorem combinedFrom_nil (pc : ConfLabel) :
    LabelTransition.combinedFrom pc [] = LabelTransition.taintPc pc Label.bot := rfl

@[simp] theorem combinedFrom_singleton (pc : ConfLabel) (ℓ : Label) :
    LabelTransition.combinedFrom pc [ℓ] = LabelTransition.taintPc pc ℓ := by
  simp [LabelTransition.combinedFrom]

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
