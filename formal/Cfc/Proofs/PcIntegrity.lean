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
      (evalD env pc' pcI' secret).lbl.conf := by
  intro pc' pcI'
  have hPc : trustedScope ∉ pcI' := by
    -- `pcI' = pcI ∩ condInteg`, and `TrustedScope ∉ condInteg`.
    exact trustedScope_not_mem_joinIntegrity_right pcI (evalD env pc pcI c).lbl.integ hCond
  simpa [pc', pcI'] using
    Proofs.RobustDeclassification.declassifyIf_pc_absent_preserves_conf
      (env := env) (pc := pc') (pcI := pcI') (tok := tok) (guard := guard) (secret := secret) hPc

end PcIntegrity
end Proofs

end Cfc

