import Std

import Cfc.Language.Declassify

namespace Cfc

namespace Proofs
namespace RobustDeclassification

open Cfc

theorem declassifyIf_guard_absent_preserves_conf
    (env : Env) (pc : ConfLabel) (tok : Atom) (guard secret : ExprD)
    (hTok : tok ∉ (evalD env pc guard).lbl.integ) :
    (evalD env pc (.declassifyIf tok guard secret)).lbl.conf = (evalD env pc secret).lbl.conf := by
  -- With no guard token, the declassifier returns the secret unchanged.
  simp [evalD, hTok]

theorem declassifyIf_guard_present_conf_eq_pc
    (env : Env) (pc : ConfLabel) (tok : Atom) (guard secret : ExprD)
    (hTok : tok ∈ (evalD env pc guard).lbl.integ) :
    (evalD env pc (.declassifyIf tok guard secret)).lbl.conf = pc := by
  simp [evalD, hTok]

theorem declassifyIf_guard_absent_no_observation
    (p : Principal) (env : Env) (pc : ConfLabel) (tok : Atom) (guard secret : ExprD)
    (hTok : tok ∉ (evalD env pc guard).lbl.integ)
    (hNo : ¬ canAccess p (evalD env pc secret).lbl) :
    observe p (evalD env pc (.declassifyIf tok guard secret)) = none := by
  classical
  -- Reduce to observing the unchanged secret.
  simp [evalD, hTok, observe, hNo]

end RobustDeclassification
end Proofs

end Cfc

