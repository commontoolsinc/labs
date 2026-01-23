import Std

import Cfc.Language.Declassify

namespace Cfc

namespace Proofs
namespace TransparentEndorsement

open Cfc

theorem endorseIf_conf_eq (env : Env) (pc : ConfLabel) (tok : Atom) (guard x : ExprD) :
    (evalD env pc (.endorseIf tok guard x)).lbl.conf =
      (evalD env (pc ++ (evalD env pc guard).lbl.conf) x).lbl.conf := by
  cases h : (evalD env pc guard).val <;> simp [evalD, h]

theorem endorseIf_tok_mem_of_guard_true (env : Env) (pc : ConfLabel) (tok : Atom) (guard x : ExprD)
    (hTrue : (evalD env pc guard).val = true) :
    tok ∈ (evalD env pc (.endorseIf tok guard x)).lbl.integ := by
  -- Unfold and use the `guard = true` branch.
  simp [evalD, hTrue, Label.endorse, Label.endorseIntegrity]

end TransparentEndorsement
end Proofs

end Cfc

