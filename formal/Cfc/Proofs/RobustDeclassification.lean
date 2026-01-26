import Std

import Cfc.Language.Declassify

namespace Cfc

namespace Proofs
namespace RobustDeclassification

open Cfc

theorem declassifyIf_guard_absent_preserves_conf
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom) (guard secret : ExprD)
    (hTok : tok ∉ (evalD env pc pcI guard).lbl.integ) :
    (evalD env pc pcI (.declassifyIf tok guard secret)).lbl.conf =
      (evalD env pc pcI secret).lbl.conf := by
  -- With no guard token, the declassifier returns the secret unchanged.
  simp [evalD, hTok]

theorem declassifyIf_pc_absent_preserves_conf
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom) (guard secret : ExprD)
    (hPc : trustedScope ∉ pcI) :
    (evalD env pc pcI (.declassifyIf tok guard secret)).lbl.conf =
      (evalD env pc pcI secret).lbl.conf := by
  simp [evalD, hPc]

theorem declassifyIf_fires_conf_eq_pc_join_guard
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom) (guard secret : ExprD)
    (hTok : tok ∈ (evalD env pc pcI guard).lbl.integ)
    (hPc : trustedScope ∈ pcI) :
    (evalD env pc pcI (.declassifyIf tok guard secret)).lbl.conf =
      pc ++ (evalD env pc pcI guard).lbl.conf := by
  simp [evalD, hTok, hPc]

theorem declassifyIf_guard_absent_no_observation
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom)
    (guard secret : ExprD)
    (hTok : tok ∉ (evalD env pc pcI guard).lbl.integ)
    (hNo : ¬ canAccess p (evalD env pc pcI secret).lbl) :
    observe p (evalD env pc pcI (.declassifyIf tok guard secret)) = none := by
  classical
  -- Reduce to observing the unchanged secret.
  simp [evalD, hTok, observe, hNo]

theorem canAccessConf_guard_of_canAccess_declassifyIf
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom)
    (guard secret : ExprD)
    (hTok : tok ∈ (evalD env pc pcI guard).lbl.integ)
    (hPc : trustedScope ∈ pcI)
    (hAcc : canAccess p (evalD env pc pcI (.declassifyIf tok guard secret)).lbl) :
    canAccessConf p (evalD env pc pcI guard).lbl.conf := by
  have hEq :=
    declassifyIf_fires_conf_eq_pc_join_guard (env := env) (pc := pc) (pcI := pcI)
      (tok := tok) (guard := guard) (secret := secret) hTok hPc
  have hAcc' : canAccessConf p (pc ++ (evalD env pc pcI guard).lbl.conf) := by
    simpa [canAccess, hEq] using hAcc
  exact (canAccessConf_append_iff p pc (evalD env pc pcI guard).lbl.conf).1 hAcc' |>.2

theorem observe_declassifyIf_eq_none_of_hidden_guard
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom)
    (guard secret : ExprD)
    (hTok : tok ∈ (evalD env pc pcI guard).lbl.integ)
    (hPc : trustedScope ∈ pcI)
    (hHide : ¬ canAccessConf p (evalD env pc pcI guard).lbl.conf) :
    observe p (evalD env pc pcI (.declassifyIf tok guard secret)) = none := by
  classical
  have hNo : ¬ canAccess p (evalD env pc pcI (.declassifyIf tok guard secret)).lbl := by
    intro hAcc
    exact hHide (canAccessConf_guard_of_canAccess_declassifyIf p env pc pcI tok guard secret hTok hPc hAcc)
  simp [observe, hNo]

end RobustDeclassification
end Proofs

end Cfc
