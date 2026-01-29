import Std

import Cfc.Language.Declassify

namespace Cfc

namespace Proofs
namespace RobustDeclassification

open Cfc

/-
Robust declassification (spec 3.8.6; safety invariants around "no silent downgrade").

This file proves small lemmas about the `declassifyIf` construct in `Cfc.Language.Declassify`.

Recall the (simplified) semantics:

```
declassifyIf tok guard secret:
  vg := evalD guard under current pc/pcI
  pc' := pc ++ vg.conf     -- PC confidentiality flows through the decision
  vs := evalD secret under pc'
  if tok ∈ vg.integ then
    if TrustedScope ∈ pcI then
      return vs.val with label { conf := pc', integ := vs.integ }   -- declassify data conf
    else
      return vs   -- blocked: untrusted control
  else
    return vs     -- blocked: guard missing token
```

So the only way confidentiality can be *reduced* (rewritten to just `pc'`) is:
- the guard carries the required integrity token `tok`, AND
- the ambient control integrity `pcI` is trusted (`TrustedScope ∈ pcI`).

All lemmas below are proved by unfolding `evalD` and simplifying the relevant branch.
-/

/-
If the guard token is absent, `declassifyIf` does not rewrite confidentiality.

In prose: without the integrity evidence, the runtime refuses to declassify and simply returns
the flow-tainted secret (evaluated under `pc' = pc ++ guard.conf`).
-/
theorem declassifyIf_guard_absent_preserves_conf
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom) (guard secret : ExprD)
    (hTok : tok ∉ (evalD env pc pcI guard).lbl.integ) :
    (evalD env pc pcI (.declassifyIf tok guard secret)).lbl.conf =
      (evalD env (pc ++ (evalD env pc pcI guard).lbl.conf) pcI secret).lbl.conf := by
  -- With no guard token, the declassifier returns the (flow-tainted) secret unchanged.
  simp [evalD, hTok]

/-
If the pc-integrity is untrusted (no `TrustedScope`), declassification is blocked even if the
guard token is present.

Again, the result is just the flow-tainted secret under `pc'`.
-/
theorem declassifyIf_pc_absent_preserves_conf
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom) (guard secret : ExprD)
    (hPc : trustedScope ∉ pcI) :
    (evalD env pc pcI (.declassifyIf tok guard secret)).lbl.conf =
      (evalD env (pc ++ (evalD env pc pcI guard).lbl.conf) pcI secret).lbl.conf := by
  simp [evalD, hPc]

/-
When declassification *does* fire (guard token present and TrustedScope present),
the resulting confidentiality is exactly the branch pc:

  conf = pc ++ guard.conf

This is the formal version of "declassify the data label but keep flow-path confidentiality".
-/
theorem declassifyIf_fires_conf_eq_pc_join_guard
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom) (guard secret : ExprD)
    (hTok : tok ∈ (evalD env pc pcI guard).lbl.integ)
    (hPc : trustedScope ∈ pcI) :
    (evalD env pc pcI (.declassifyIf tok guard secret)).lbl.conf =
      pc ++ (evalD env pc pcI guard).lbl.conf := by
  simp [evalD, hTok, hPc]

/-
Observation lemma for the "no-guard" case:

If declassification is blocked (guard token absent) and the resulting flow-tainted secret is not
accessible to `p`, then observing the whole `declassifyIf` expression yields `none`.

This is mostly a convenience lemma: it lets later proofs avoid re-unfolding `evalD`.
-/
theorem declassifyIf_guard_absent_no_observation
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom)
    (guard secret : ExprD)
    (hTok : tok ∉ (evalD env pc pcI guard).lbl.integ)
    (hNo : ¬ canAccess p (evalD env (pc ++ (evalD env pc pcI guard).lbl.conf) pcI secret).lbl) :
    observe p (evalD env pc pcI (.declassifyIf tok guard secret)) = none := by
  classical
  -- Reduce to observing the unchanged (flow-tainted) secret.
  simp [evalD, hTok, observe, hNo]

/-
If declassification fires and `p` can access the output, then `p` must be able to access the guard.

Intuition:
- When declassification fires, output.conf = pc ++ guard.conf.
- To access the output, you must be able to satisfy both parts of that CNF (pc and guard.conf).
- Therefore you can access the guard confidentiality.

This lemma is used to show that if the guard is hidden from `p`, then the declassification result
must also be hidden (preventing covert channels).
-/
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

/-
If declassification fires but the guard is hidden from `p`, then the declassification result is
also hidden from `p` (observation is `none`).

This is the "no covert channel via hidden guard" story in the spec: if the runtime allowed the
result to become observable while the guard remained unobservable, you could leak bits via whether
declassification succeeds.
-/
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

