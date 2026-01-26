import Std

import Cfc.Language.Declassify
import Cfc.Proofs.TransparentEndorsement

namespace Cfc

namespace Proofs
namespace FlowPathConfidentiality

open Cfc

/-!
Flow-path confidentiality (PC confidentiality) lemmas for the tiny expression model.

These correspond to the spec's "PC confidentiality must be joined into downstream outputs"
story (docs/specs/cfc/10-safety-invariants.md invariant 9).
-/

theorem pc_subset_evalD_conf (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (e : ExprD) :
    pc ⊆ (evalD env pc pcI e).lbl.conf := by
  induction e generalizing pc pcI with
  | lit b =>
    intro c hc
    simpa [evalD] using hc
  | var x =>
    intro c hc
    -- (env x).conf ++ pc contains every clause from pc.
    exact List.mem_append.2 (Or.inr (by simpa [evalD, taint, taintConf] using hc))
  | not e ih =>
    simpa [evalD] using ih (pc := pc) (pcI := pcI)
  | and e₁ e₂ ih₁ ih₂ =>
    intro c hc
    -- Use the RHS operand: its conf contains pc, and confs are concatenated.
    have hsub : pc ⊆ (evalD env pc pcI e₂).lbl.conf := ih₂ (pc := pc) (pcI := pcI)
    have : c ∈ (evalD env pc pcI e₂).lbl.conf := hsub hc
    have : c ∈ (evalD env pc pcI e₁).lbl.conf ++ (evalD env pc pcI e₂).lbl.conf :=
      List.mem_append.2 (Or.inr this)
    simpa [evalD, Label.join] using this
  | ite c t e ihc iht ihe =>
    intro clause hmem
    have hIn : clause ∈ pc ++ (evalD env pc pcI c).lbl.conf :=
      List.mem_append.2 (Or.inl hmem)
    by_cases hcond : (evalD env pc pcI c).val
    ·
      have hsub :
          (pc ++ (evalD env pc pcI c).lbl.conf) ⊆
            (evalD env (pc ++ (evalD env pc pcI c).lbl.conf)
              (Label.joinIntegrity pcI (evalD env pc pcI c).lbl.integ) t).lbl.conf :=
        iht (pc := pc ++ (evalD env pc pcI c).lbl.conf)
            (pcI := Label.joinIntegrity pcI (evalD env pc pcI c).lbl.integ)
      have : clause ∈
          (evalD env (pc ++ (evalD env pc pcI c).lbl.conf)
            (Label.joinIntegrity pcI (evalD env pc pcI c).lbl.integ) t).lbl.conf :=
        hsub hIn
      simpa [evalD, hcond] using this
    ·
      have hsub :
          (pc ++ (evalD env pc pcI c).lbl.conf) ⊆
            (evalD env (pc ++ (evalD env pc pcI c).lbl.conf)
              (Label.joinIntegrity pcI (evalD env pc pcI c).lbl.integ) e).lbl.conf :=
        ihe (pc := pc ++ (evalD env pc pcI c).lbl.conf)
            (pcI := Label.joinIntegrity pcI (evalD env pc pcI c).lbl.integ)
      have : clause ∈
          (evalD env (pc ++ (evalD env pc pcI c).lbl.conf)
            (Label.joinIntegrity pcI (evalD env pc pcI c).lbl.integ) e).lbl.conf :=
        hsub hIn
      simpa [evalD, hcond] using this
  | endorseIf tok guard x ihg ihx =>
    intro clause hmem
    let pc' : ConfLabel := pc ++ (evalD env pc pcI guard).lbl.conf
    let pcI' : IntegLabel := Label.joinIntegrity pcI (evalD env pc pcI guard).lbl.integ
    have hIn : clause ∈ pc' := by
      exact List.mem_append.2 (Or.inl hmem)
    have hsub : pc' ⊆ (evalD env pc' pcI' x).lbl.conf :=
      ihx (pc := pc') (pcI := pcI')
    have : clause ∈ (evalD env pc' pcI' x).lbl.conf := hsub hIn
    -- `endorseIf` does not change confidentiality; it returns the `x`-branch value.
    have hEq :=
      Proofs.TransparentEndorsement.endorseIf_conf_eq
        (env := env) (pc := pc) (pcI := pcI) (tok := tok) (guard := guard) (x := x)
    simpa [pc', pcI', hEq] using this
  | declassifyIf tok guard secret ihg ihs =>
    intro clause hmem
    let pc' : ConfLabel := pc ++ (evalD env pc pcI guard).lbl.conf
    have hIn : clause ∈ pc' := by
      exact List.mem_append.2 (Or.inl hmem)
    have hsub : pc' ⊆ (evalD env pc' pcI secret).lbl.conf :=
      ihs (pc := pc') (pcI := pcI)
    have hInSecret : clause ∈ (evalD env pc' pcI secret).lbl.conf := hsub hIn
    by_cases hTok : tok ∈ (evalD env pc pcI guard).lbl.integ
    · by_cases hPc : trustedScope ∈ pcI
      · -- Fires: conf is exactly `pc'`.
        simpa [evalD, pc', hTok, hPc] using hIn
      · -- Doesn't fire: returns the flow-tainted secret.
        simpa [evalD, pc', hTok, hPc] using hInSecret
    · -- No guard: returns the flow-tainted secret.
      simpa [evalD, pc', hTok] using hInSecret

theorem observe_evalD_eq_none_of_not_canAccessConf_pc
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (e : ExprD)
    (hpc : ¬ canAccessConf p pc) :
    observe p (evalD env pc pcI e) = none := by
  classical
  have hNo : ¬ canAccess p (evalD env pc pcI e).lbl := by
    intro hAcc
    have hSub := pc_subset_evalD_conf env pc pcI e
    have : canAccessConf p pc := canAccessConf_of_subset hSub hAcc
    exact hpc this
  simp [observe, hNo]

theorem canAccessConf_guard_of_canAccess_endorseIf
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (tok : Atom) (guard x : ExprD)
    (hAcc : canAccess p (evalD env pc pcI (.endorseIf tok guard x)).lbl) :
    canAccessConf p (evalD env pc pcI guard).lbl.conf := by
  let pc' : ConfLabel := pc ++ (evalD env pc pcI guard).lbl.conf
  let pcI' : IntegLabel := Label.joinIntegrity pcI (evalD env pc pcI guard).lbl.integ
  have hEq :=
    Proofs.TransparentEndorsement.endorseIf_conf_eq
      (env := env) (pc := pc) (pcI := pcI) (tok := tok) (guard := guard) (x := x)
  have hAccX : canAccessConf p (evalD env pc' pcI' x).lbl.conf := by
    simpa [canAccess, pc', pcI', hEq] using hAcc
  have hSub : pc' ⊆ (evalD env pc' pcI' x).lbl.conf :=
    pc_subset_evalD_conf env pc' pcI' x
  have hAccPc' : canAccessConf p pc' :=
    canAccessConf_of_subset hSub hAccX
  -- `pc' = pc ++ guardConf`, so access to `pc'` implies access to `guardConf`.
  exact (canAccessConf_append_iff p pc (evalD env pc pcI guard).lbl.conf).1 (by simpa [pc'] using hAccPc') |>.2

theorem observe_endorseIf_eq_none_of_hidden_guard
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (tok : Atom) (guard x : ExprD)
    (hHide : ¬ canAccessConf p (evalD env pc pcI guard).lbl.conf) :
    observe p (evalD env pc pcI (.endorseIf tok guard x)) = none := by
  classical
  have hNo : ¬ canAccess p (evalD env pc pcI (.endorseIf tok guard x)).lbl := by
    intro hAcc
    exact hHide (canAccessConf_guard_of_canAccess_endorseIf p env pc pcI tok guard x hAcc)
  simp [observe, hNo]

theorem canAccessConf_cond_of_canAccess_ite
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (c t e : ExprD)
    (hAcc : canAccess p (evalD env pc pcI (.ite c t e)).lbl) :
    canAccessConf p (evalD env pc pcI c).lbl.conf := by
  have hAccOut : canAccessConf p (evalD env pc pcI (.ite c t e)).lbl.conf := by
    simpa [canAccess] using hAcc
  by_cases hcond : (evalD env pc pcI c).val
  ·
    let pc' : ConfLabel := pc ++ (evalD env pc pcI c).lbl.conf
    let pcI' : IntegLabel := Label.joinIntegrity pcI (evalD env pc pcI c).lbl.integ
    have hAccBranch : canAccessConf p (evalD env pc' pcI' t).lbl.conf := by
      simpa [evalD, hcond, pc', pcI'] using hAccOut
    have hSub : pc' ⊆ (evalD env pc' pcI' t).lbl.conf :=
      pc_subset_evalD_conf env pc' pcI' t
    have hAccPc' : canAccessConf p pc' :=
      canAccessConf_of_subset hSub hAccBranch
    exact (canAccessConf_append_iff p pc (evalD env pc pcI c).lbl.conf).1 (by simpa [pc'] using hAccPc') |>.2
  ·
    let pc' : ConfLabel := pc ++ (evalD env pc pcI c).lbl.conf
    let pcI' : IntegLabel := Label.joinIntegrity pcI (evalD env pc pcI c).lbl.integ
    have hAccBranch : canAccessConf p (evalD env pc' pcI' e).lbl.conf := by
      simpa [evalD, hcond, pc', pcI'] using hAccOut
    have hSub : pc' ⊆ (evalD env pc' pcI' e).lbl.conf :=
      pc_subset_evalD_conf env pc' pcI' e
    have hAccPc' : canAccessConf p pc' :=
      canAccessConf_of_subset hSub hAccBranch
    exact (canAccessConf_append_iff p pc (evalD env pc pcI c).lbl.conf).1 (by simpa [pc'] using hAccPc') |>.2

theorem observe_ite_eq_none_of_hidden_cond
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (c t e : ExprD)
    (hHide : ¬ canAccessConf p (evalD env pc pcI c).lbl.conf) :
    observe p (evalD env pc pcI (.ite c t e)) = none := by
  classical
  have hNo : ¬ canAccess p (evalD env pc pcI (.ite c t e)).lbl := by
    intro hAcc
    exact hHide (canAccessConf_cond_of_canAccess_ite p env pc pcI c t e hAcc)
  simp [observe, hNo]

theorem canAccessConf_guard_of_canAccess_declassifyIf
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom)
    (guard secret : ExprD)
    (hAcc : canAccess p (evalD env pc pcI (.declassifyIf tok guard secret)).lbl) :
    canAccessConf p (evalD env pc pcI guard).lbl.conf := by
  let pc' : ConfLabel := pc ++ (evalD env pc pcI guard).lbl.conf
  have hAccOut : canAccessConf p (evalD env pc pcI (.declassifyIf tok guard secret)).lbl.conf := by
    simpa [canAccess] using hAcc
  have hSub : pc' ⊆ (evalD env pc pcI (.declassifyIf tok guard secret)).lbl.conf := by
    intro c hc
    by_cases hTok : tok ∈ (evalD env pc pcI guard).lbl.integ
    · by_cases hPc : trustedScope ∈ pcI
      · -- Fires: conf is exactly `pc'`.
        simpa [evalD, pc', hTok, hPc] using hc
      · -- Doesn't fire: returns the flow-tainted secret.
        have hSubSecret : pc' ⊆ (evalD env pc' pcI secret).lbl.conf :=
          pc_subset_evalD_conf env pc' pcI secret
        have : c ∈ (evalD env pc' pcI secret).lbl.conf := hSubSecret hc
        simpa [evalD, pc', hTok, hPc] using this
    · -- No guard: returns the flow-tainted secret.
      have hSubSecret : pc' ⊆ (evalD env pc' pcI secret).lbl.conf :=
        pc_subset_evalD_conf env pc' pcI secret
      have : c ∈ (evalD env pc' pcI secret).lbl.conf := hSubSecret hc
      simpa [evalD, pc', hTok] using this
  have hAccPc' : canAccessConf p pc' :=
    canAccessConf_of_subset hSub hAccOut
  exact (canAccessConf_append_iff p pc (evalD env pc pcI guard).lbl.conf).1 (by simpa [pc'] using hAccPc') |>.2

/-!
A small "composed" regression test:
If endorsement depends on a high-conf guard, then using the endorsed value as evidence for a
declassification is also high-conf (the endorsement decision is not observable).
-/
theorem observe_declassifyIf_endorseIf_eq_none_of_hidden_guard
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom)
    (g x secret : ExprD)
    (hHide : ¬ canAccessConf p (evalD env pc pcI g).lbl.conf) :
    observe p (evalD env pc pcI (.declassifyIf tok (.endorseIf tok g x) secret)) = none := by
  classical
  have hNo : ¬ canAccess p (evalD env pc pcI (.declassifyIf tok (.endorseIf tok g x) secret)).lbl := by
    intro hAcc
    have hAccEndorseConf :
        canAccessConf p (evalD env pc pcI (.endorseIf tok g x)).lbl.conf :=
      canAccessConf_guard_of_canAccess_declassifyIf p env pc pcI tok (.endorseIf tok g x) secret hAcc
    have hAccEndorse : canAccess p (evalD env pc pcI (.endorseIf tok g x)).lbl := by
      simpa [canAccess] using hAccEndorseConf
    have : canAccessConf p (evalD env pc pcI g).lbl.conf :=
      canAccessConf_guard_of_canAccess_endorseIf p env pc pcI tok g x hAccEndorse
    exact hHide this
  simp [observe, hNo]

end FlowPathConfidentiality
end Proofs

end Cfc
