import Std

import Cfc.Access

namespace Cfc

structure LVal where
  val : Bool
  lbl : Label
  deriving Repr

abbrev Env := String → LVal

def taintConf (pc : ConfLabel) (ℓ : Label) : Label :=
  { ℓ with conf := ℓ.conf ++ pc }

def taint (pc : ConfLabel) (v : LVal) : LVal :=
  { v with lbl := taintConf pc v.lbl }

inductive Expr where
  | lit (b : Bool)
  | var (x : String)
  | not (e : Expr)
  | and (e₁ e₂ : Expr)
  | ite (c t e : Expr)
  deriving Repr

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

def eval0 (env : Env) (e : Expr) : LVal :=
  eval env [] e

noncomputable def observe (p : Principal) (v : LVal) : Option Bool := by
  classical
  exact if h : canAccess p v.lbl then some v.val else none

abbrev LowEq (p : Principal) (v₁ v₂ : LVal) : Prop :=
  observe p v₁ = observe p v₂

abbrev LowEqEnv (p : Principal) (ρ₁ ρ₂ : Env) : Prop :=
  ∀ x, LowEq p (ρ₁ x) (ρ₂ x)

namespace observe

theorem eq_some_iff {p : Principal} {v : LVal} {b : Bool} :
    observe p v = some b ↔ canAccess p v.lbl ∧ v.val = b := by
  classical
  by_cases h : canAccess p v.lbl <;> simp [observe, h]

theorem eq_none_iff {p : Principal} {v : LVal} :
    observe p v = none ↔ ¬ canAccess p v.lbl := by
  classical
  by_cases h : canAccess p v.lbl <;> simp [observe, h]

end observe

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
