import Std

import Cfc.Access

namespace Cfc

/-
This file defines a tiny labeled expression language and its semantics.

Purpose:
- Provide a small, self-contained setting in which we can prove a classic IFC theorem
  (non-interference), without modeling the full runtime.

Key modeling choices:

- Values are just booleans (`Bool`). We care about labels, not data richness.
- Every value is paired with a `Label` (confidentiality + integrity).
- We model flow-sensitive confidentiality via an explicit "program counter" label `pc : ConfLabel`.

The `pc` label represents information revealed by control flow (branch conditions, etc.).
The rule is: when you branch on a condition, you must join the condition's confidentiality
into `pc` for the branch, because simply taking the branch leaks information about the condition.

This matches the spec's flow-path confidentiality (PC confidentiality) story, but in a toy language.
-/

structure LVal where
  val : Bool
  lbl : Label
  deriving Repr

/-
An environment maps variable names to labeled values.
This is the only notion of "state" in the pure language.
-/
abbrev Env := String → LVal

/-
Taint a label by flow-path confidentiality `pc`.

In this (older) file we define taint as:
  conf := conf ++ pc
which is equivalent to prefixing up to associativity/commutativity at the CNF level.

In the Chapter 8 transition code we used the "prefix" convention `pc ++ conf`.
Both represent CNF conjunction; we keep this one as-is to avoid rewriting existing proofs.
-/
def taintConf (pc : ConfLabel) (ℓ : Label) : Label :=
  { ℓ with conf := ℓ.conf ++ pc }

/-
Taint a labeled value by tainting its label.
-/
def taint (pc : ConfLabel) (v : LVal) : LVal :=
  { v with lbl := taintConf pc v.lbl }

/-
Syntax of the tiny language:
- literals, variables
- boolean negation, conjunction
- if-then-else

We intentionally keep the syntax small to make proofs short and readable.
-/
inductive Expr where
  | lit (b : Bool)
  | var (x : String)
  | not (e : Expr)
  | and (e₁ e₂ : Expr)
  | ite (c t e : Expr)
  deriving Repr

/-
Big-step evaluation with explicit `pc`.

Important: The *boolean value* computed by evaluation does not depend on labels or `pc`.
Only the *label* depends on `pc` and on subexpression labels.

Rules:
- `lit`: returns the literal with label `(pc, [])` (pc confidentiality, no integrity).
- `var`: returns the environment value tainted by `pc` (reading a variable under pc reveals pc).
- `not`: preserves the label.
- `and`: joins labels of both operands (data dependency on both).
- `ite`: evaluate condition under current pc, then update pc' := pc ++ cond.conf for the branch.

That `ite` rule is the essence of flow-path confidentiality: the branch taken reveals the condition.
-/
def eval (env : Env) (pc : ConfLabel) : Expr → LVal
  | .lit b =>
      { val := b
        lbl := { conf := pc, integ := [] } }
  | .var x =>
      taint pc (env x)
  | .not e =>
      let v := eval env pc e
      { val := (!v.val)
        lbl := v.lbl }
  | .and e₁ e₂ =>
      let v₁ := eval env pc e₁
      let v₂ := eval env pc e₂
      { val := v₁.val && v₂.val
        lbl := v₁.lbl + v₂.lbl }
  | .ite c t e =>
      let vc := eval env pc c
      let pc' := pc ++ vc.lbl.conf
      if vc.val then eval env pc' t else eval env pc' e

/-
Convenience: evaluate with empty pc.
-/
def eval0 (env : Env) (e : Expr) : LVal :=
  eval env [] e

/-
Observation function (standard in IFC):

`observe p v` returns:
- `some v.val` if principal `p` is allowed to access `v.lbl.conf`
- `none` otherwise

We mark it `noncomputable` because it uses classical reasoning (`if h : canAccess ... then ...`)
and we don't care about running it; we care about theorems about it.
-/
noncomputable def observe (p : Principal) (v : LVal) : Option Bool := by
  classical
  exact if h : canAccess p v.lbl then some v.val else none

/-
Low-equivalence:

Two labeled values are low-equivalent for principal `p` if `p` observes the same thing from them.
This is the standard way to state non-interference: changing secret inputs does not change
what a low principal can observe.
-/
abbrev LowEq (p : Principal) (v₁ v₂ : LVal) : Prop :=
  observe p v₁ = observe p v₂

/-
Low-equivalence lifted to environments: pointwise low-equivalence for every variable.
-/
abbrev LowEqEnv (p : Principal) (ρ₁ ρ₂ : Env) : Prop :=
  ∀ x, LowEq p (ρ₁ x) (ρ₂ x)

namespace observe

/-
These two lemmas are basic "case splits" for `observe`.

They are handy because they turn an equality about `Option` into logical facts about access.
-/
theorem eq_some_iff {p : Principal} {v : LVal} {b : Bool} :
    observe p v = some b ↔ canAccess p v.lbl ∧ v.val = b := by
  classical
  by_cases h : canAccess p v.lbl <;> simp [observe, h]

theorem eq_none_iff {p : Principal} {v : LVal} :
    observe p v = none ↔ ¬ canAccess p v.lbl := by
  classical
  by_cases h : canAccess p v.lbl <;> simp [observe, h]

end observe

/-
`eval_val_eq` is a key "sanity lemma":
the computed boolean value of an expression does not depend on the pc label.

This is important because our evaluator threads `pc` only for label tracking;
it should not affect the underlying computation.

Proof strategy:
- Structural induction on the expression `e`.
- Each constructor reduces to simpler subgoals.
- The `ite` case is the only interesting one:
  we show the condition evaluates to the same boolean under both pcs,
  then do cases on that boolean and apply the induction hypothesis to the chosen branch.
-/
theorem eval_val_eq (env : Env) (pc₁ pc₂ : ConfLabel) (e : Expr) :
    (eval env pc₁ e).val = (eval env pc₂ e).val := by
  induction e generalizing pc₁ pc₂ with
  | lit b =>
    simp [eval]
  | var x =>
    simp [eval, taint]
  | not e ih =>
    simpa [eval] using congrArg Bool.not (ih pc₁ pc₂)
  | and e₁ e₂ ih₁ ih₂ =>
    have h₁ := ih₁ pc₁ pc₂
    have h₂ := ih₂ pc₁ pc₂
    simp [eval, h₁, h₂]
  | ite c t e ihc iht ihe =>
    have hc : (eval env pc₁ c).val = (eval env pc₂ c).val := ihc pc₁ pc₂
    cases hct : (eval env pc₁ c).val with
    | false =>
      have hct2 : (eval env pc₂ c).val = false := by simpa [hct] using hc
      have hBranch :=
        ihe (pc₁ := pc₁ ++ (eval env pc₁ c).lbl.conf)
            (pc₂ := pc₂ ++ (eval env pc₂ c).lbl.conf)
      simp [eval, hct, hct2, hBranch]
    | true =>
      have hct2 : (eval env pc₂ c).val = true := by simpa [hct] using hc
      have hBranch :=
        iht (pc₁ := pc₁ ++ (eval env pc₁ c).lbl.conf)
            (pc₂ := pc₂ ++ (eval env pc₂ c).lbl.conf)
      simp [eval, hct, hct2, hBranch]

end Cfc
