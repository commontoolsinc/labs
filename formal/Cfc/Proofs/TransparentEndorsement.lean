import Std

import Cfc.Language.Declassify

namespace Cfc

namespace Proofs
namespace TransparentEndorsement

open Cfc

theorem endorseIf_conf_eq (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (tok : Atom) (guard x : ExprD) :
    (evalD env pc pcI (.endorseIf tok guard x)).lbl.conf =
      (evalD env (pc ++ (evalD env pc pcI guard).lbl.conf)
        (Label.joinIntegrity pcI (evalD env pc pcI guard).lbl.integ) x).lbl.conf := by
  by_cases hVal : (evalD env pc pcI guard).val = true
  ·
    by_cases hPc : trustedScope ∈ Label.joinIntegrity pcI (evalD env pc pcI guard).lbl.integ
    · simp [evalD, hVal, hPc]
    · simp [evalD, hVal, hPc]
  · simp [evalD, hVal]

theorem endorseIf_tok_mem_of_guard_true
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom) (guard x : ExprD)
    (hTrue : (evalD env pc pcI guard).val = true)
    (hPc : trustedScope ∈ Label.joinIntegrity pcI (evalD env pc pcI guard).lbl.integ) :
    tok ∈ (evalD env pc pcI (.endorseIf tok guard x)).lbl.integ := by
  simp [evalD, hTrue, hPc]

end TransparentEndorsement
end Proofs

end Cfc
