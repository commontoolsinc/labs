import Std

import Cfc.Language.Declassify
import Cfc.Proofs.RobustDeclassification

namespace Cfc

namespace Proofs
namespace PcIntegrity

open Cfc

theorem trustedScope_not_mem_joinIntegrity_right (I₁ I₂ : IntegLabel)
    (h : trustedScope ∉ I₂) :
    trustedScope ∉ Label.joinIntegrity I₁ I₂ := by
  intro hMem
  have h' := (Label.mem_joinIntegrity trustedScope I₁ I₂).1 hMem
  exact h h'.2

theorem trustedScope_not_mem_joinIntegrity_left (I₁ I₂ : IntegLabel)
    (h : trustedScope ∉ I₁) :
    trustedScope ∉ Label.joinIntegrity I₁ I₂ := by
  intro hMem
  have h' := (Label.mem_joinIntegrity trustedScope I₁ I₂).1 hMem
  exact h h'.1

/--
If a branch condition is not trusted (w.r.t. `TrustedScope`), then the branch PC-integrity
cannot contain `TrustedScope`. As a result, any `declassifyIf` in that branch cannot fire.
-/
theorem declassifyIf_blocked_by_untrusted_cond
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (c : ExprD)
    (tok : Atom) (guard secret : ExprD)
    (hCond : trustedScope ∉ (evalD env pc pcI c).lbl.integ) :
    let pc' := pc ++ (evalD env pc pcI c).lbl.conf
    let pcI' := Label.joinIntegrity pcI (evalD env pc pcI c).lbl.integ
    (evalD env pc' pcI' (.declassifyIf tok guard secret)).lbl.conf =
      (evalD env (pc' ++ (evalD env pc' pcI' guard).lbl.conf) pcI' secret).lbl.conf := by
  intro pc' pcI'
  have hPc : trustedScope ∉ pcI' := by
    -- `pcI' = pcI ∩ condInteg`, and `TrustedScope ∉ condInteg`.
    exact trustedScope_not_mem_joinIntegrity_right pcI (evalD env pc pcI c).lbl.integ hCond
  simpa [pc', pcI'] using
    Proofs.RobustDeclassification.declassifyIf_pc_absent_preserves_conf
      (env := env) (pc := pc') (pcI := pcI') (tok := tok) (guard := guard) (secret := secret) hPc

/--
If a branch condition is not trusted (w.r.t. `TrustedScope`), then the branch PC-integrity
cannot contain `TrustedScope`. As a result, any `endorseIf` in that branch cannot add new
integrity tokens.
-/
theorem endorseIf_blocked_by_untrusted_cond
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (c : ExprD)
    (tok : Atom) (guard x : ExprD)
    (hCond : trustedScope ∉ (evalD env pc pcI c).lbl.integ) :
    let pc' := pc ++ (evalD env pc pcI c).lbl.conf
    let pcI' := Label.joinIntegrity pcI (evalD env pc pcI c).lbl.integ
    (evalD env pc' pcI' (.endorseIf tok guard x)).lbl.integ =
      (evalD env (pc' ++ (evalD env pc' pcI' guard).lbl.conf)
        (Label.joinIntegrity pcI' (evalD env pc' pcI' guard).lbl.integ) x).lbl.integ := by
  intro pc' pcI'
  have hPc : trustedScope ∉ pcI' := by
    -- `pcI' = pcI ∩ condInteg`, and `TrustedScope ∉ condInteg`.
    exact trustedScope_not_mem_joinIntegrity_right pcI (evalD env pc pcI c).lbl.integ hCond
  have hPc' : trustedScope ∉ Label.joinIntegrity pcI' (evalD env pc' pcI' guard).lbl.integ := by
    -- `pcI'' = pcI' ∩ guardInteg`, and `TrustedScope ∉ pcI'`.
    exact trustedScope_not_mem_joinIntegrity_left pcI' (evalD env pc' pcI' guard).lbl.integ hPc
  -- With no `TrustedScope` in the endorsement PC-integrity, the endorsement can't add `tok`.
  simp [evalD, pc', pcI', hPc']

end PcIntegrity
end Proofs

end Cfc
