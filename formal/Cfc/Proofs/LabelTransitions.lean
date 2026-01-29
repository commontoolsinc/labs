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

/-!
Transformation integrity lemmas.

These correspond to spec 8.7 and the default transition in 8.9.2.
-/

/-
Flow-path confidentiality (`pc`) always appears in the output of `transformedFrom`.

This is the same shape as `pc_subset_combinedFrom_conf`: `transformedFrom` ends with `taintPc pc`,
so membership is injected by `List.mem_append`.
-/
theorem pc_subset_transformedFrom_conf (pc : ConfLabel) (codeHash : String) (inputRefs : List Nat) (inputs : List Label) :
    pc ⊆ (LabelTransition.transformedFrom pc codeHash inputRefs inputs).conf := by
  intro c hc
  -- `taintPc` prefixes `pc`, so anything in `pc` is in the output confidentiality.
  exact List.mem_append.2 (Or.inl (by simpa [LabelTransition.transformedFrom, LabelTransition.taintPc] using hc))

/-
`transformedFrom` always adds the `Atom.transformedBy ...` integrity atom.

This is just list membership of the singleton list `[a]`.
-/
theorem mem_transformedFrom_transformedBy (pc : ConfLabel) (codeHash : String) (inputRefs : List Nat) (inputs : List Label) :
    Atom.transformedBy codeHash inputRefs ∈ (LabelTransition.transformedFrom pc codeHash inputRefs inputs).integ := by
  simp [LabelTransition.transformedFrom]

/-!
Endorsed transformation lemmas (spec 8.7.2).

The key properties are:
- the registry check is sound: when it says "true", there really is a rule that allows the claim
- preserved integrity atoms come only from (a) the schema-declared list and (b) the common integrity of the inputs
-/

/-
Soundness of the boolean registry check.

If the runtime verification returns `true`, then we can extract a concrete registry rule `r`
such that:
1) `r` is actually in the registry list
2) `r.codeHash` matches the requested `codeHash`
3) every claimed-preserve atom is allowed by `r.preserves`

This is exactly what `reg.any (...) = true` means, unpacked.
-/
theorem verifyEndorsedTransform_of_eq_true
    (reg : List LabelTransition.TransformRule) (codeHash : String) (claimedPreserve : List Atom)
    (h : LabelTransition.verifyEndorsedTransform reg codeHash claimedPreserve = true) :
    ∃ r, r ∈ reg ∧ r.codeHash = codeHash ∧ ∀ a, a ∈ claimedPreserve → a ∈ r.preserves := by
  classical
  -- Unfold the definition and use the standard characterization of `List.any`.
  have hAny :
      reg.any (fun r =>
        decide (r.codeHash = codeHash) &&
        claimedPreserve.all (fun a => decide (a ∈ r.preserves))) = true := by
    simpa [LabelTransition.verifyEndorsedTransform] using h
  rcases (List.any_eq_true).1 hAny with ⟨r, hrMem, hrPred⟩
  -- Split the `&&` predicate into its two components.
  have hAnd :
      decide (r.codeHash = codeHash) = true ∧
      claimedPreserve.all (fun a => decide (a ∈ r.preserves)) = true := by
    exact (Eq.mp (Bool.and_eq_true _ _) hrPred)
  have hEq : r.codeHash = codeHash := of_decide_eq_true hAnd.1
  -- And unpack the inner `all` check.
  have hAll :
      ∀ a, a ∈ claimedPreserve → decide (a ∈ r.preserves) = true := by
    simpa [List.all_eq_true] using hAnd.2
  refine ⟨r, hrMem, hEq, ?_⟩
  intro a ha
  exact of_decide_eq_true (hAll a ha)

/-
Lemma about `commonIntegrity`:

If an atom `a` appears in `commonIntegrity inputs`, then it appears in the integrity label of
*every* input.

We prove this by induction over the fold that computes the repeated intersection.
-/
theorem mem_commonIntegrity_of_mem (a : Atom) (inputs : List Label)
    (h : a ∈ LabelTransition.commonIntegrity inputs) :
    ∀ ℓ, ℓ ∈ inputs → a ∈ ℓ.integ := by
  classical
  -- Helper: membership in a fold of intersections implies membership in the accumulator
  -- and in every list we intersected with.
  have fold_helper :
      ∀ (acc : IntegLabel) (rest : List Label),
        a ∈ rest.foldl (fun acc x => Label.joinIntegrity acc x.integ) acc →
          a ∈ acc ∧ ∀ x, x ∈ rest → a ∈ x.integ := by
    intro acc rest
    induction rest generalizing acc with
    | nil =>
        intro hmem
        refine ⟨hmem, ?_⟩
        intro x hx
        cases hx
    | cons x xs ih =>
        intro hmem
        -- One `foldl` step: intersect with `x.integ`, then continue.
        have hmem' :
            a ∈ xs.foldl (fun acc y => Label.joinIntegrity acc y.integ) (Label.joinIntegrity acc x.integ) := by
          simpa [List.foldl] using hmem
        have ⟨hAcc', hAll⟩ := ih (acc := Label.joinIntegrity acc x.integ) hmem'
        have hBoth : a ∈ acc ∧ a ∈ x.integ :=
          (Label.mem_joinIntegrity a acc x.integ).1 hAcc'
        refine ⟨hBoth.1, ?_⟩
        intro y hy
        cases hy with
        | head =>
            -- In the `head` case, `y` is definitional equal to `x`.
            simpa using hBoth.2
        | tail _ hyTail =>
            exact hAll y hyTail
  cases inputs with
  | nil =>
      -- `commonIntegrity [] = []`, so the membership premise is impossible.
      cases h
  | cons ℓ0 rest =>
      have hFold :
          a ∈ rest.foldl (fun acc x => Label.joinIntegrity acc x.integ) ℓ0.integ := by
        simpa [LabelTransition.commonIntegrity] using h
      have ⟨h0, hRest⟩ := fold_helper (acc := ℓ0.integ) (rest := rest) hFold
      intro ℓ hℓ
      cases hℓ with
      | head =>
          -- `ℓ` is the head element `ℓ0`.
          simpa using h0
      | tail _ hTail =>
          exact hRest ℓ hTail

/-
Membership characterization for `preservedFromInputs`.

This is a standard `List.filter` lemma: membership in the filtered list means membership in the
original list *and* that the predicate evaluates to `true`.
-/
theorem mem_preservedFromInputs (a : Atom) (claimedPreserve : List Atom) (inputs : List Label) :
    a ∈ LabelTransition.preservedFromInputs claimedPreserve inputs ↔
      a ∈ claimedPreserve ∧ a ∈ LabelTransition.commonIntegrity inputs := by
  classical
  simp [LabelTransition.preservedFromInputs]

/-
If `a` is preserved by `preservedFromInputs`, then:
- `a` was requested by the schema (`a ∈ claimedPreserve`), and
- `a` is present in every input's integrity label.
-/
theorem mem_preservedFromInputs_of_mem (a : Atom) (claimedPreserve : List Atom) (inputs : List Label)
    (h : a ∈ LabelTransition.preservedFromInputs claimedPreserve inputs) :
    a ∈ claimedPreserve ∧ ∀ ℓ, ℓ ∈ inputs → a ∈ ℓ.integ := by
  classical
  have h' : a ∈ claimedPreserve ∧ a ∈ LabelTransition.commonIntegrity inputs :=
    (mem_preservedFromInputs a claimedPreserve inputs).1 h
  refine ⟨h'.1, ?_⟩
  exact mem_commonIntegrity_of_mem a inputs h'.2

/-
If the endorsed transformation transition returns `some out`, then the output integrity contains:
- the `TransformedBy` provenance atom, and
- only preserved atoms justified by the `commonIntegrity` of the inputs.

This lemma records the first (simplest) part: the provenance atom is always present.
-/
theorem mem_endorsedTransformedFromChecked_transformedBy_of_eq_some
    (reg : List LabelTransition.TransformRule) (pc : ConfLabel) (codeHash : String) (inputRefs : List Nat)
    (inputs : List Label) (claimedPreserve : List Atom) (out : Label)
    (h : LabelTransition.endorsedTransformedFromChecked reg pc codeHash inputRefs inputs claimedPreserve = some out) :
    Atom.transformedBy codeHash inputRefs ∈ out.integ := by
  classical
  -- If the option is `some`, the check must have evaluated to `true`.
  cases hv : LabelTransition.verifyEndorsedTransform reg codeHash claimedPreserve with
  | false =>
      -- Contradiction: the definition would return `none`.
      have h' := h
      simp [LabelTransition.endorsedTransformedFromChecked, hv] at h'
  | true =>
      -- In the success branch, `out` is definitionally the constructed label.
      let constructed : Label :=
        LabelTransition.taintPc pc
          { conf := inputs.foldl (fun acc ℓ => acc ++ ℓ.conf) []
            integ := [Atom.transformedBy codeHash inputRefs] ++
              LabelTransition.preservedFromInputs claimedPreserve inputs }
      have hSome : some constructed = some out := by
        simpa [LabelTransition.endorsedTransformedFromChecked, hv, constructed] using h
      have hout : constructed = out := Option.some.inj hSome
      subst hout
      simp [constructed]

/-
If `verifyRecomposeProjections` succeeds (`= true`), then each part really contains the required
scoped integrity atom, *and* the abstract reference check succeeded for that part.

This is the direct `List.all` soundness lemma.
-/
theorem verifyRecomposeProjections_of_mem {source : Nat} {base : Atom} {parts : List LabelTransition.ProjectionPart}
    (h : LabelTransition.verifyRecomposeProjections source base parts = true) :
    ∀ p, p ∈ parts → p.outputRef = p.expectedRef ∧ Atom.scopedFrom source p.path base ∈ p.label.integ := by
  classical
  intro p hp
  have hAll :
      parts.all (fun p =>
        decide (p.outputRef = p.expectedRef) &&
        decide (Atom.scopedFrom source p.path base ∈ p.label.integ)) = true := by
    simpa [LabelTransition.verifyRecomposeProjections] using h
  -- Use the standard `List.all_eq_true` characterization.
  have hPred :
      ∀ p, p ∈ parts →
        (decide (p.outputRef = p.expectedRef) &&
          decide (Atom.scopedFrom source p.path base ∈ p.label.integ)) = true := by
    simpa [List.all_eq_true] using hAll
  have hThis :
      (decide (p.outputRef = p.expectedRef) &&
        decide (Atom.scopedFrom source p.path base ∈ p.label.integ)) = true := hPred p hp
  have hAnd :
      decide (p.outputRef = p.expectedRef) = true ∧
      decide (Atom.scopedFrom source p.path base ∈ p.label.integ) = true := by
    -- `Bool.and_eq_true` is an equality of propositions:
    --   ((a && b) = true) = (a = true ∧ b = true)
    -- so we can transport `hThis` across it with `Eq.mp`.
    exact (Eq.mp (Bool.and_eq_true _ _) hThis)
  constructor
  · exact of_decide_eq_true hAnd.1
  · exact of_decide_eq_true hAnd.2

/-
If recomposition returns `some out`, then the output integrity contains the "whole object"
atom `scopedFrom source [] base`.

This is the key "safe recomposition restores integrity" fact.
-/
theorem mem_recomposeFromProjections_whole_of_eq_some
    (pc : ConfLabel) (source : Nat) (base : Atom) (parts : List LabelTransition.ProjectionPart) (out : Label)
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
    have : some { (LabelTransition.combinedFrom pc (parts.map (fun p => p.label))) with
        integ := (LabelTransition.combinedFrom pc (parts.map (fun p => p.label))).integ ++
          [Atom.scopedFrom source [] base] } = some out := by
      simpa [LabelTransition.recomposeFromProjections, hv] using h
    have hout :
        { (LabelTransition.combinedFrom pc (parts.map (fun p => p.label))) with
          integ := (LabelTransition.combinedFrom pc (parts.map (fun p => p.label))).integ ++
            [Atom.scopedFrom source [] base] } = out := by
      exact Option.some.inj this
    -- Conclude by rewriting and using list membership of append.
    subst hout
    simp

end LabelTransitions
end Proofs

end Cfc
