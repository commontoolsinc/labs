import Std

import Cfc.Language

namespace Cfc

namespace Proofs
namespace Noninterference

open Cfc

theorem observe_taint_eq (p : Principal) (pc : ConfLabel) {v₁ v₂ : LVal}
    (h : observe p v₁ = observe p v₂) :
    observe p (taint pc v₁) = observe p (taint pc v₂) := by
  classical
  by_cases hpc : canAccessConf p pc
  · -- pc is satisfiable for p, so `taint` preserves observation.
    have ht : ∀ v : LVal, observe p (taint pc v) = observe p v := by
      intro v
      by_cases hv : canAccess p v.lbl
      ·
        have hta : canAccess p (taint pc v).lbl :=
          (canAccessConf_append_iff p v.lbl.conf pc).2 ⟨hv, hpc⟩
        have hta' : canAccess p { conf := v.lbl.conf ++ pc, integ := v.lbl.integ } := by
          simpa [taint, taintConf] using hta
        simp [observe, hv, hta', taint, taintConf]
      · have hta : ¬ canAccess p (taint pc v).lbl := by
          intro hAcc
          have : canAccess p v.lbl := (canAccessConf_append_iff p v.lbl.conf pc).1 hAcc |>.1
          exact hv this
        have hta' : ¬ canAccess p { conf := v.lbl.conf ++ pc, integ := v.lbl.integ } := by
          simpa [taint, taintConf] using hta
        simp [observe, hv, hta', taint, taintConf]
    -- Reduce both sides to the untainted observations.
    calc
      observe p (taint pc v₁) = observe p v₁ := ht v₁
      _ = observe p v₂ := by simp [h]
      _ = observe p (taint pc v₂) := (ht v₂).symm
  · -- pc is not satisfiable: `taint` forces everything to be unobservable.
    have ht : ∀ v : LVal, observe p (taint pc v) = none := by
      intro v
      have hta : ¬ canAccess p (taint pc v).lbl := by
        intro hAcc
        have : canAccessConf p pc := (canAccessConf_append_iff p v.lbl.conf pc).1 hAcc |>.2
        exact hpc this
      have hta' : ¬ canAccess p { conf := v.lbl.conf ++ pc, integ := v.lbl.integ } := by
        simpa [taint, taintConf] using hta
      simp [observe, hta', taint, taintConf]
    simp [ht v₁, ht v₂]

theorem pc_subset_eval_conf (env : Env) (pc : ConfLabel) (e : Expr) :
    pc ⊆ (eval env pc e).lbl.conf := by
  induction e generalizing pc with
  | lit b =>
    intro c hc
    simpa [eval] using hc
  | var x =>
    intro c hc
    -- (env x).conf ++ pc contains every clause from pc.
    exact List.mem_append.2 (Or.inr hc)
  | not e ih =>
    simpa [eval] using ih (pc := pc)
  | and e₁ e₂ ih₁ ih₂ =>
    intro c hc
    -- Use the RHS operand: its conf contains pc, and confs are concatenated.
    have hsub : pc ⊆ (eval env pc e₂).lbl.conf := ih₂ (pc := pc)
    have : c ∈ (eval env pc e₂).lbl.conf := hsub hc
    have : c ∈ (eval env pc e₁).lbl.conf ++ (eval env pc e₂).lbl.conf :=
      List.mem_append.2 (Or.inr this)
    simpa [eval, Label.join] using this
  | ite c t e ihc iht ihe =>
    intro clause hmem
    -- pc ⊆ pc ++ condConf, and the chosen branch's conf contains its pc.
    have hpc : pc ⊆ pc ++ (eval env pc c).lbl.conf := by
      intro cl hcl
      exact List.mem_append.2 (Or.inl hcl)
    have : clause ∈ (pc ++ (eval env pc c).lbl.conf) := hpc hmem
    -- Use a direct split on the taken branch to avoid the above awkwardness.
    by_cases hcond : (eval env pc c).val
    ·
      -- then-branch
      have hsub : (pc ++ (eval env pc c).lbl.conf) ⊆ (eval env (pc ++ (eval env pc c).lbl.conf) t).lbl.conf :=
        iht (pc := pc ++ (eval env pc c).lbl.conf)
      have : clause ∈ (eval env (pc ++ (eval env pc c).lbl.conf) t).lbl.conf := hsub this
      simpa [eval, hcond] using this
    ·
      -- else-branch
      have hsub : (pc ++ (eval env pc c).lbl.conf) ⊆ (eval env (pc ++ (eval env pc c).lbl.conf) e).lbl.conf :=
        ihe (pc := pc ++ (eval env pc c).lbl.conf)
      have : clause ∈ (eval env (pc ++ (eval env pc c).lbl.conf) e).lbl.conf := hsub this
      simpa [eval, hcond] using this

theorem observe_eval_eq_none_of_not_canAccessConf_pc
    (p : Principal) (env : Env) (pc : ConfLabel) (e : Expr)
    (hpc : ¬ canAccessConf p pc) :
    observe p (eval env pc e) = none := by
  classical
  have hNo : ¬ canAccess p (eval env pc e).lbl := by
    intro hAcc
    have hSub := pc_subset_eval_conf env pc e
    have : canAccessConf p pc := canAccessConf_of_subset hSub hAcc
    exact hpc this
  simp [observe, hNo]

/-!
If the attacker principal can satisfy *both* PC labels, then PC choice does not affect
the attacker's observation of evaluation.
-/
theorem observe_eval_eq_of_accessible_pc
    (p : Principal) (env : Env) (pc₁ pc₂ : ConfLabel) (e : Expr)
    (hpc₁ : canAccessConf p pc₁) (hpc₂ : canAccessConf p pc₂) :
    observe p (eval env pc₁ e) = observe p (eval env pc₂ e) := by
  classical
  induction e generalizing pc₁ pc₂ with
  | lit b =>
    have h1' : canAccess p { conf := pc₁, integ := [] } := by
      simpa [canAccess] using hpc₁
    have h2' : canAccess p { conf := pc₂, integ := [] } := by
      simpa [canAccess] using hpc₂
    simp [eval, observe, h1', h2']
  | var x =>
    by_cases hx : canAccess p (env x).lbl
    ·
      have hta1 : canAccess p (taint pc₁ (env x)).lbl :=
        (canAccessConf_append_iff p (env x).lbl.conf pc₁).2 ⟨hx, hpc₁⟩
      have hta2 : canAccess p (taint pc₂ (env x)).lbl :=
        (canAccessConf_append_iff p (env x).lbl.conf pc₂).2 ⟨hx, hpc₂⟩
      have hta1' : canAccess p { conf := (env x).lbl.conf ++ pc₁, integ := (env x).lbl.integ } := by
        simpa [taint, taintConf] using hta1
      have hta2' : canAccess p { conf := (env x).lbl.conf ++ pc₂, integ := (env x).lbl.integ } := by
        simpa [taint, taintConf] using hta2
      simp [eval, observe, hta1', hta2', taint, taintConf]
    ·
      have hta1 : ¬ canAccess p (taint pc₁ (env x)).lbl := by
        intro hAcc
        have : canAccess p (env x).lbl := (canAccessConf_append_iff p (env x).lbl.conf pc₁).1 hAcc |>.1
        exact hx this
      have hta2 : ¬ canAccess p (taint pc₂ (env x)).lbl := by
        intro hAcc
        have : canAccess p (env x).lbl := (canAccessConf_append_iff p (env x).lbl.conf pc₂).1 hAcc |>.1
        exact hx this
      have hta1' : ¬ canAccess p { conf := (env x).lbl.conf ++ pc₁, integ := (env x).lbl.integ } := by
        simpa [taint, taintConf] using hta1
      have hta2' : ¬ canAccess p { conf := (env x).lbl.conf ++ pc₂, integ := (env x).lbl.integ } := by
        simpa [taint, taintConf] using hta2
      simp [eval, observe, hta1', hta2', taint, taintConf]
  | not e ih =>
    have h := ih (pc₁ := pc₁) (pc₂ := pc₂) hpc₁ hpc₂
    cases hObs : observe p (eval env pc₁ e) with
    | none =>
      have : observe p (eval env pc₂ e) = none := by simpa [h] using hObs
      have h1 : ¬ canAccess p (eval env pc₁ e).lbl := (observe.eq_none_iff).1 hObs
      have h2 : ¬ canAccess p (eval env pc₂ e).lbl := (observe.eq_none_iff).1 this
      simp [eval, observe, h1, h2]
    | some b =>
      have : observe p (eval env pc₂ e) = some b := by simpa [h] using hObs
      have h1 : canAccess p (eval env pc₁ e).lbl := (observe.eq_some_iff).1 hObs |>.1
      have h2 : canAccess p (eval env pc₂ e).lbl := (observe.eq_some_iff).1 this |>.1
      have hb1 : (eval env pc₁ e).val = b := (observe.eq_some_iff).1 hObs |>.2
      have hb2 : (eval env pc₂ e).val = b := (observe.eq_some_iff).1 this |>.2
      simp [eval, observe, h1, h2, hb1, hb2]
  | and e₁ e₂ ih₁ ih₂ =>
    have h₁ := ih₁ (pc₁ := pc₁) (pc₂ := pc₂) hpc₁ hpc₂
    have h₂ := ih₂ (pc₁ := pc₁) (pc₂ := pc₂) hpc₁ hpc₂
    -- Case split on operand observability under pc₁; use IH to transfer to pc₂.
    cases hObs1 : observe p (eval env pc₁ e₁) with
    | none =>
      have hObs1' : observe p (eval env pc₂ e₁) = none := by simpa [h₁] using hObs1
      have hNo1 : ¬ canAccess p (eval env pc₁ e₁).lbl := (observe.eq_none_iff).1 hObs1
      have hNo1' : ¬ canAccess p (eval env pc₂ e₁).lbl := (observe.eq_none_iff).1 hObs1'
      have hNoJoin1 : ¬ canAccess p ((eval env pc₁ e₁).lbl + (eval env pc₁ e₂).lbl) := by
        intro hJ
        have : canAccess p (eval env pc₁ e₁).lbl := (canAccess_join_iff p _ _).1 hJ |>.1
        exact hNo1 this
      have hNoJoin2 : ¬ canAccess p ((eval env pc₂ e₁).lbl + (eval env pc₂ e₂).lbl) := by
        intro hJ
        have : canAccess p (eval env pc₂ e₁).lbl := (canAccess_join_iff p _ _).1 hJ |>.1
        exact hNo1' this
      simp [eval, observe, hNoJoin1, hNoJoin2]
    | some b₁ =>
      have hObs1' : observe p (eval env pc₂ e₁) = some b₁ := by simpa [h₁] using hObs1
      have hAcc1 : canAccess p (eval env pc₁ e₁).lbl := (observe.eq_some_iff).1 hObs1 |>.1
      have hAcc1' : canAccess p (eval env pc₂ e₁).lbl := (observe.eq_some_iff).1 hObs1' |>.1
      have hb1 : (eval env pc₁ e₁).val = b₁ := (observe.eq_some_iff).1 hObs1 |>.2
      have hb1' : (eval env pc₂ e₁).val = b₁ := (observe.eq_some_iff).1 hObs1' |>.2
      cases hObs2 : observe p (eval env pc₁ e₂) with
      | none =>
        have hObs2' : observe p (eval env pc₂ e₂) = none := by simpa [h₂] using hObs2
        have hNo2 : ¬ canAccess p (eval env pc₁ e₂).lbl := (observe.eq_none_iff).1 hObs2
        have hNo2' : ¬ canAccess p (eval env pc₂ e₂).lbl := (observe.eq_none_iff).1 hObs2'
        have hNoJoin1 : ¬ canAccess p ((eval env pc₁ e₁).lbl + (eval env pc₁ e₂).lbl) := by
          intro hJ
          have : canAccess p (eval env pc₁ e₂).lbl := (canAccess_join_iff p _ _).1 hJ |>.2
          exact hNo2 this
        have hNoJoin2 : ¬ canAccess p ((eval env pc₂ e₁).lbl + (eval env pc₂ e₂).lbl) := by
          intro hJ
          have : canAccess p (eval env pc₂ e₂).lbl := (canAccess_join_iff p _ _).1 hJ |>.2
          exact hNo2' this
        simp [eval, observe, hNoJoin1, hNoJoin2]
      | some b₂ =>
        have hObs2' : observe p (eval env pc₂ e₂) = some b₂ := by simpa [h₂] using hObs2
        have hAcc2 : canAccess p (eval env pc₁ e₂).lbl := (observe.eq_some_iff).1 hObs2 |>.1
        have hAcc2' : canAccess p (eval env pc₂ e₂).lbl := (observe.eq_some_iff).1 hObs2' |>.1
        have hb2 : (eval env pc₁ e₂).val = b₂ := (observe.eq_some_iff).1 hObs2 |>.2
        have hb2' : (eval env pc₂ e₂).val = b₂ := (observe.eq_some_iff).1 hObs2' |>.2
        have hJoin1 : canAccess p ((eval env pc₁ e₁).lbl + (eval env pc₁ e₂).lbl) :=
          (canAccess_join_iff p _ _).2 ⟨hAcc1, hAcc2⟩
        have hJoin2 : canAccess p ((eval env pc₂ e₁).lbl + (eval env pc₂ e₂).lbl) :=
          (canAccess_join_iff p _ _).2 ⟨hAcc1', hAcc2'⟩
        simp [eval, observe, hJoin1, hJoin2, hb1, hb1', hb2, hb2']
  | ite c t e ihc iht ihe =>
    have hC := ihc (pc₁ := pc₁) (pc₂ := pc₂) hpc₁ hpc₂
    -- Case split on whether the condition is observable (for p) under pc₁.
    cases hObsC : observe p (eval env pc₁ c) with
    | none =>
      have hObsC' : observe p (eval env pc₂ c) = none := by simpa [hC] using hObsC
      have hNo1 : ¬ canAccess p (eval env pc₁ c).lbl := (observe.eq_none_iff).1 hObsC
      have hNo2 : ¬ canAccess p (eval env pc₂ c).lbl := (observe.eq_none_iff).1 hObsC'
      -- Then the branch PC is not satisfiable in either case, hence the whole ite is unobservable.
      have hNoPc1 : ¬ canAccessConf p (pc₁ ++ (eval env pc₁ c).lbl.conf) := by
        intro hAcc
        have : canAccessConf p (eval env pc₁ c).lbl.conf :=
          (canAccessConf_append_iff p pc₁ (eval env pc₁ c).lbl.conf).1 hAcc |>.2
        exact hNo1 this
      have hNoPc2 : ¬ canAccessConf p (pc₂ ++ (eval env pc₂ c).lbl.conf) := by
        intro hAcc
        have : canAccessConf p (eval env pc₂ c).lbl.conf :=
          (canAccessConf_append_iff p pc₂ (eval env pc₂ c).lbl.conf).1 hAcc |>.2
        exact hNo2 this
      have ht1 : observe p (eval env (pc₁ ++ (eval env pc₁ c).lbl.conf) t) = none :=
        observe_eval_eq_none_of_not_canAccessConf_pc p env _ t hNoPc1
      have he1 : observe p (eval env (pc₁ ++ (eval env pc₁ c).lbl.conf) e) = none :=
        observe_eval_eq_none_of_not_canAccessConf_pc p env _ e hNoPc1
      have ht2 : observe p (eval env (pc₂ ++ (eval env pc₂ c).lbl.conf) t) = none :=
        observe_eval_eq_none_of_not_canAccessConf_pc p env _ t hNoPc2
      have he2 : observe p (eval env (pc₂ ++ (eval env pc₂ c).lbl.conf) e) = none :=
        observe_eval_eq_none_of_not_canAccessConf_pc p env _ e hNoPc2
      have out1 : observe p (eval env pc₁ (.ite c t e)) = none := by
        cases hcond : (eval env pc₁ c).val <;> simp [eval, hcond, ht1, he1]
      have out2 : observe p (eval env pc₂ (.ite c t e)) = none := by
        cases hcond : (eval env pc₂ c).val <;> simp [eval, hcond, ht2, he2]
      simp [out1, out2]
    | some b =>
      have hObsC' : observe p (eval env pc₂ c) = some b := by simpa [hC] using hObsC
      have hAccC1 : canAccess p (eval env pc₁ c).lbl := (observe.eq_some_iff).1 hObsC |>.1
      have hAccC2 : canAccess p (eval env pc₂ c).lbl := (observe.eq_some_iff).1 hObsC' |>.1
      have hb1 : (eval env pc₁ c).val = b := (observe.eq_some_iff).1 hObsC |>.2
      have hb2 : (eval env pc₂ c).val = b := (observe.eq_some_iff).1 hObsC' |>.2
      -- The combined branch PC is satisfiable in both runs.
      have hPc1 : canAccessConf p (pc₁ ++ (eval env pc₁ c).lbl.conf) :=
        (canAccessConf_append_iff p pc₁ (eval env pc₁ c).lbl.conf).2 ⟨hpc₁, hAccC1⟩
      have hPc2 : canAccessConf p (pc₂ ++ (eval env pc₂ c).lbl.conf) :=
        (canAccessConf_append_iff p pc₂ (eval env pc₂ c).lbl.conf).2 ⟨hpc₂, hAccC2⟩
      -- Now appeal to IH on the chosen branch under these satisfiable PCs.
      cases b with
      | false =>
        have hB :=
          ihe (pc₁ := pc₁ ++ (eval env pc₁ c).lbl.conf) (pc₂ := pc₂ ++ (eval env pc₂ c).lbl.conf) hPc1 hPc2
        simp [eval, hb1, hb2, hB]
      | true =>
        have hB :=
          iht (pc₁ := pc₁ ++ (eval env pc₁ c).lbl.conf) (pc₂ := pc₂ ++ (eval env pc₂ c).lbl.conf) hPc1 hPc2
        simp [eval, hb1, hb2, hB]

theorem noninterference_eval (p : Principal) (ρ₁ ρ₂ : Env) (pc : ConfLabel) (e : Expr)
    (hEnv : LowEqEnv p ρ₁ ρ₂) :
    observe p (eval ρ₁ pc e) = observe p (eval ρ₂ pc e) := by
  classical
  induction e generalizing pc with
  | lit b =>
    simp [eval, observe]
  | var x =>
    simpa [eval] using observe_taint_eq p pc (hEnv x)
  | not e ih =>
    have h := ih (pc := pc)
    cases hObs : observe p (eval ρ₁ pc e) with
    | none =>
      have : observe p (eval ρ₂ pc e) = none := by simpa [h] using hObs
      have h1 : ¬ canAccess p (eval ρ₁ pc e).lbl := (observe.eq_none_iff).1 hObs
      have h2 : ¬ canAccess p (eval ρ₂ pc e).lbl := (observe.eq_none_iff).1 this
      simp [eval, observe, h1, h2]
    | some b =>
      have : observe p (eval ρ₂ pc e) = some b := by simpa [h] using hObs
      have h1 : canAccess p (eval ρ₁ pc e).lbl := (observe.eq_some_iff).1 hObs |>.1
      have h2 : canAccess p (eval ρ₂ pc e).lbl := (observe.eq_some_iff).1 this |>.1
      have hb1 : (eval ρ₁ pc e).val = b := (observe.eq_some_iff).1 hObs |>.2
      have hb2 : (eval ρ₂ pc e).val = b := (observe.eq_some_iff).1 this |>.2
      simp [eval, observe, h1, h2, hb1, hb2]
  | and e₁ e₂ ih₁ ih₂ =>
    have h₁ := ih₁ (pc := pc)
    have h₂ := ih₂ (pc := pc)
    -- Do a small case split on LHS/RHS observability in ρ₁; ρ₂ follows from IH.
    cases hObs1 : observe p (eval ρ₁ pc e₁) with
    | none =>
      have hObs1' : observe p (eval ρ₂ pc e₁) = none := by simpa [h₁] using hObs1
      have hNo1 : ¬ canAccess p (eval ρ₁ pc e₁).lbl := (observe.eq_none_iff).1 hObs1
      have hNo1' : ¬ canAccess p (eval ρ₂ pc e₁).lbl := (observe.eq_none_iff).1 hObs1'
      have hNoJoin1 : ¬ canAccess p ((eval ρ₁ pc e₁).lbl + (eval ρ₁ pc e₂).lbl) := by
        intro hJ
        have : canAccess p (eval ρ₁ pc e₁).lbl := (canAccess_join_iff p _ _).1 hJ |>.1
        exact hNo1 this
      have hNoJoin2 : ¬ canAccess p ((eval ρ₂ pc e₁).lbl + (eval ρ₂ pc e₂).lbl) := by
        intro hJ
        have : canAccess p (eval ρ₂ pc e₁).lbl := (canAccess_join_iff p _ _).1 hJ |>.1
        exact hNo1' this
      simp [eval, observe, hNoJoin1, hNoJoin2]
    | some b₁ =>
      have hObs1' : observe p (eval ρ₂ pc e₁) = some b₁ := by simpa [h₁] using hObs1
      have hAcc1 : canAccess p (eval ρ₁ pc e₁).lbl := (observe.eq_some_iff).1 hObs1 |>.1
      have hAcc1' : canAccess p (eval ρ₂ pc e₁).lbl := (observe.eq_some_iff).1 hObs1' |>.1
      have hb1 : (eval ρ₁ pc e₁).val = b₁ := (observe.eq_some_iff).1 hObs1 |>.2
      have hb1' : (eval ρ₂ pc e₁).val = b₁ := (observe.eq_some_iff).1 hObs1' |>.2
      cases hObs2 : observe p (eval ρ₁ pc e₂) with
      | none =>
        have hObs2' : observe p (eval ρ₂ pc e₂) = none := by simpa [h₂] using hObs2
        have hNo2 : ¬ canAccess p (eval ρ₁ pc e₂).lbl := (observe.eq_none_iff).1 hObs2
        have hNo2' : ¬ canAccess p (eval ρ₂ pc e₂).lbl := (observe.eq_none_iff).1 hObs2'
        have hNoJoin1 : ¬ canAccess p ((eval ρ₁ pc e₁).lbl + (eval ρ₁ pc e₂).lbl) := by
          intro hJ
          have : canAccess p (eval ρ₁ pc e₂).lbl := (canAccess_join_iff p _ _).1 hJ |>.2
          exact hNo2 this
        have hNoJoin2 : ¬ canAccess p ((eval ρ₂ pc e₁).lbl + (eval ρ₂ pc e₂).lbl) := by
          intro hJ
          have : canAccess p (eval ρ₂ pc e₂).lbl := (canAccess_join_iff p _ _).1 hJ |>.2
          exact hNo2' this
        simp [eval, observe, hNoJoin1, hNoJoin2]
      | some b₂ =>
        have hObs2' : observe p (eval ρ₂ pc e₂) = some b₂ := by simpa [h₂] using hObs2
        have hAcc2 : canAccess p (eval ρ₁ pc e₂).lbl := (observe.eq_some_iff).1 hObs2 |>.1
        have hAcc2' : canAccess p (eval ρ₂ pc e₂).lbl := (observe.eq_some_iff).1 hObs2' |>.1
        have hb2 : (eval ρ₁ pc e₂).val = b₂ := (observe.eq_some_iff).1 hObs2 |>.2
        have hb2' : (eval ρ₂ pc e₂).val = b₂ := (observe.eq_some_iff).1 hObs2' |>.2
        have hJoin1 : canAccess p ((eval ρ₁ pc e₁).lbl + (eval ρ₁ pc e₂).lbl) :=
          (canAccess_join_iff p _ _).2 ⟨hAcc1, hAcc2⟩
        have hJoin2 : canAccess p ((eval ρ₂ pc e₁).lbl + (eval ρ₂ pc e₂).lbl) :=
          (canAccess_join_iff p _ _).2 ⟨hAcc1', hAcc2'⟩
        simp [eval, observe, hJoin1, hJoin2, hb1, hb1', hb2, hb2']
  | ite c t e ihc iht ihe =>
    have hC := ihc (pc := pc)
    cases hObsC : observe p (eval ρ₁ pc c) with
    | none =>
      have hObsC' : observe p (eval ρ₂ pc c) = none := by simpa [hC] using hObsC
      have hNoC1 : ¬ canAccess p (eval ρ₁ pc c).lbl := (observe.eq_none_iff).1 hObsC
      have hNoC2 : ¬ canAccess p (eval ρ₂ pc c).lbl := (observe.eq_none_iff).1 hObsC'
      have hNoPc1 : ¬ canAccessConf p (pc ++ (eval ρ₁ pc c).lbl.conf) := by
        intro hAcc
        have : canAccessConf p (eval ρ₁ pc c).lbl.conf :=
          (canAccessConf_append_iff p pc (eval ρ₁ pc c).lbl.conf).1 hAcc |>.2
        exact hNoC1 this
      have hNoPc2 : ¬ canAccessConf p (pc ++ (eval ρ₂ pc c).lbl.conf) := by
        intro hAcc
        have : canAccessConf p (eval ρ₂ pc c).lbl.conf :=
          (canAccessConf_append_iff p pc (eval ρ₂ pc c).lbl.conf).1 hAcc |>.2
        exact hNoC2 this
      have ht1 : observe p (eval ρ₁ (pc ++ (eval ρ₁ pc c).lbl.conf) t) = none :=
        observe_eval_eq_none_of_not_canAccessConf_pc p ρ₁ _ t hNoPc1
      have he1 : observe p (eval ρ₁ (pc ++ (eval ρ₁ pc c).lbl.conf) e) = none :=
        observe_eval_eq_none_of_not_canAccessConf_pc p ρ₁ _ e hNoPc1
      have ht2 : observe p (eval ρ₂ (pc ++ (eval ρ₂ pc c).lbl.conf) t) = none :=
        observe_eval_eq_none_of_not_canAccessConf_pc p ρ₂ _ t hNoPc2
      have he2 : observe p (eval ρ₂ (pc ++ (eval ρ₂ pc c).lbl.conf) e) = none :=
        observe_eval_eq_none_of_not_canAccessConf_pc p ρ₂ _ e hNoPc2
      have out1 : observe p (eval ρ₁ pc (.ite c t e)) = none := by
        cases hcond : (eval ρ₁ pc c).val <;> simp [eval, hcond, ht1, he1]
      have out2 : observe p (eval ρ₂ pc (.ite c t e)) = none := by
        cases hcond : (eval ρ₂ pc c).val <;> simp [eval, hcond, ht2, he2]
      simp [out1, out2]
    | some b =>
      have hObsC' : observe p (eval ρ₂ pc c) = some b := by simpa [hC] using hObsC
      have hAccC1 : canAccess p (eval ρ₁ pc c).lbl := (observe.eq_some_iff).1 hObsC |>.1
      have hAccC2 : canAccess p (eval ρ₂ pc c).lbl := (observe.eq_some_iff).1 hObsC' |>.1
      have hb1 : (eval ρ₁ pc c).val = b := (observe.eq_some_iff).1 hObsC |>.2
      have hb2 : (eval ρ₂ pc c).val = b := (observe.eq_some_iff).1 hObsC' |>.2
      -- pc is satisfiable (needed to strip the branch PC back to pc).
      have hpc : canAccessConf p pc := by
        have hSub := pc_subset_eval_conf ρ₁ pc c
        exact canAccessConf_of_subset hSub hAccC1
      have hPc1 : canAccessConf p (pc ++ (eval ρ₁ pc c).lbl.conf) :=
        (canAccessConf_append_iff p pc (eval ρ₁ pc c).lbl.conf).2 ⟨hpc, hAccC1⟩
      have hPc2 : canAccessConf p (pc ++ (eval ρ₂ pc c).lbl.conf) :=
        (canAccessConf_append_iff p pc (eval ρ₂ pc c).lbl.conf).2 ⟨hpc, hAccC2⟩
      -- Use PC-independence (for observable PCs) to rewrite each side to evaluation under the shared pc.
      cases b with
      | false =>
        have hStrip1 :=
          observe_eval_eq_of_accessible_pc p ρ₁ (pc ++ (eval ρ₁ pc c).lbl.conf) pc e hPc1 hpc
        have hStrip2 :=
          observe_eval_eq_of_accessible_pc p ρ₂ (pc ++ (eval ρ₂ pc c).lbl.conf) pc e hPc2 hpc
        have hBranch := ihe (pc := pc)
        simp [eval, hb1, hb2, hStrip1, hStrip2, hBranch]
      | true =>
        have hStrip1 :=
          observe_eval_eq_of_accessible_pc p ρ₁ (pc ++ (eval ρ₁ pc c).lbl.conf) pc t hPc1 hpc
        have hStrip2 :=
          observe_eval_eq_of_accessible_pc p ρ₂ (pc ++ (eval ρ₂ pc c).lbl.conf) pc t hPc2 hpc
        have hBranch := iht (pc := pc)
        simp [eval, hb1, hb2, hStrip1, hStrip2, hBranch]

theorem noninterference (p : Principal) (ρ₁ ρ₂ : Env) (e : Expr)
    (hEnv : LowEqEnv p ρ₁ ρ₂) :
    observe p (eval0 ρ₁ e) = observe p (eval0 ρ₂ e) := by
  simpa [eval0] using noninterference_eval p ρ₁ ρ₂ [] e hEnv

end Noninterference
end Proofs

end Cfc
