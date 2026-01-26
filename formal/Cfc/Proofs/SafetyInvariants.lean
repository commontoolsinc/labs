import Std

import Cfc.Exchange
import Cfc.Language.Declassify
import Cfc.Proofs.Exchange
import Cfc.Proofs.FlowPathConfidentiality
import Cfc.Proofs.PcIntegrity
import Cfc.Proofs.RobustDeclassification
import Cfc.Proofs.TransparentEndorsement

namespace Cfc

namespace Proofs
namespace SafetyInvariants

open Cfc

/-!
Index of theorems corresponding to the CFC Safety Invariants
(`docs/specs/cfc/10-safety-invariants.md`) for the subset modeled in Lean.

This file mostly re-exports/aliases theorems from more focused proof modules so that:
- spec readers can find the Lean statement quickly, and
- scenario proofs can depend on a stable "invariant API".
-/

/-!
Invariant 9 (Flow-path confidentiality):
"PC confidentiality must be joined into downstream outputs".
-/
theorem inv9_pc_subset_evalD_conf
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (e : ExprD) :
    pc ⊆ (evalD env pc pcI e).lbl.conf :=
  Proofs.FlowPathConfidentiality.pc_subset_evalD_conf env pc pcI e

theorem inv9_observe_eq_none_of_hidden_pc
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (e : ExprD)
    (hpc : ¬ canAccessConf p pc) :
    observe p (evalD env pc pcI e) = none :=
  Proofs.FlowPathConfidentiality.observe_evalD_eq_none_of_not_canAccessConf_pc p env pc pcI e hpc

theorem inv9_canAccessConf_cond_of_canAccess_ite
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (c t e : ExprD)
    (hAcc : canAccess p (evalD env pc pcI (.ite c t e)).lbl) :
    canAccessConf p (evalD env pc pcI c).lbl.conf :=
  Proofs.FlowPathConfidentiality.canAccessConf_cond_of_canAccess_ite
    (p := p) (env := env) (pc := pc) (pcI := pcI) (c := c) (t := t) (e := e) hAcc

theorem inv9_observe_ite_eq_none_of_hidden_cond
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (c t e : ExprD)
    (hHide : ¬ canAccessConf p (evalD env pc pcI c).lbl.conf) :
    observe p (evalD env pc pcI (.ite c t e)) = none :=
  Proofs.FlowPathConfidentiality.observe_ite_eq_none_of_hidden_cond
    (p := p) (env := env) (pc := pc) (pcI := pcI) (c := c) (t := t) (e := e) hHide

/-!
Invariant 3 (Confidentiality exchange requires explicit integrity guards) and
Invariant 6 (violating policy never silently downgrades confidentiality; exchange is disabled).

For exchange rules, the "disable on failure" story is definitional: if the guard check is false,
the exchange returns the original label.
-/
theorem exchangeAddAltIf_eq_of_hasAllB_false
    (needInteg : List Atom) (target alt : Atom) (boundary : IntegLabel) (ℓ : Label)
    (h : Exchange.hasAllB needInteg (Exchange.availIntegrity ℓ boundary) = false) :
    Exchange.exchangeAddAltIf needInteg target alt boundary ℓ = ℓ := by
  simp [Exchange.exchangeAddAltIf, h]

theorem exchangeDropSingletonIf_eq_of_hasAllB_false
    (needInteg : List Atom) (a : Atom) (boundary : IntegLabel) (ℓ : Label)
    (h : Exchange.hasAllB needInteg (Exchange.availIntegrity ℓ boundary) = false) :
    Exchange.exchangeDropSingletonIf needInteg a boundary ℓ = ℓ := by
  simp [Exchange.exchangeDropSingletonIf, h]

/-!
Invariant 6 / 3 for the tiny declassifier:
if the integrity gate is missing (either evidence token or trusted PC-integrity),
the declassifier does not rewrite confidentiality.
-/
theorem inv6_declassifyIf_guard_absent_preserves_conf
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom) (guard secret : ExprD)
    (hTok : tok ∉ (evalD env pc pcI guard).lbl.integ) :
    (evalD env pc pcI (.declassifyIf tok guard secret)).lbl.conf =
      (evalD env (pc ++ (evalD env pc pcI guard).lbl.conf) pcI secret).lbl.conf :=
  Proofs.RobustDeclassification.declassifyIf_guard_absent_preserves_conf
    (env := env) (pc := pc) (pcI := pcI) (tok := tok) (guard := guard) (secret := secret) hTok

theorem inv6_declassifyIf_pc_absent_preserves_conf
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom) (guard secret : ExprD)
    (hPc : trustedScope ∉ pcI) :
    (evalD env pc pcI (.declassifyIf tok guard secret)).lbl.conf =
      (evalD env (pc ++ (evalD env pc pcI guard).lbl.conf) pcI secret).lbl.conf :=
  Proofs.RobustDeclassification.declassifyIf_pc_absent_preserves_conf
    (env := env) (pc := pc) (pcI := pcI) (tok := tok) (guard := guard) (secret := secret) hPc

/-!
Invariant 7 (Robust declassification):
untrusted control-flow cannot enable declassification.
-/
theorem inv7_declassifyIf_blocked_by_untrusted_cond
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (c : ExprD)
    (tok : Atom) (guard secret : ExprD)
    (hCond : trustedScope ∉ (evalD env pc pcI c).lbl.integ) :
    let pc' := pc ++ (evalD env pc pcI c).lbl.conf
    let pcI' := Label.joinIntegrity pcI (evalD env pc pcI c).lbl.integ
    (evalD env pc' pcI' (.declassifyIf tok guard secret)).lbl.conf =
      (evalD env (pc' ++ (evalD env pc' pcI' guard).lbl.conf) pcI' secret).lbl.conf :=
  Proofs.PcIntegrity.declassifyIf_blocked_by_untrusted_cond
    (env := env) (pc := pc) (pcI := pcI) (c := c) (tok := tok) (guard := guard) (secret := secret) hCond

/-!
Invariant 8 (Transparent endorsement):
secret-dependent endorsement decisions are not observable, and untrusted control-flow cannot
mint new endorsement facts.
-/
theorem inv8_observe_endorseIf_eq_none_of_hidden_guard
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (tok : Atom) (guard x : ExprD)
    (hHide : ¬ canAccessConf p (evalD env pc pcI guard).lbl.conf) :
    observe p (evalD env pc pcI (.endorseIf tok guard x)) = none :=
  Proofs.FlowPathConfidentiality.observe_endorseIf_eq_none_of_hidden_guard
    (p := p) (env := env) (pc := pc) (pcI := pcI) (tok := tok) (guard := guard) (x := x) hHide

theorem inv8_endorseIf_blocked_by_untrusted_cond
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (c : ExprD)
    (tok : Atom) (guard x : ExprD)
    (hCond : trustedScope ∉ (evalD env pc pcI c).lbl.integ) :
    let pc' := pc ++ (evalD env pc pcI c).lbl.conf
    let pcI' := Label.joinIntegrity pcI (evalD env pc pcI c).lbl.integ
    (evalD env pc' pcI' (.endorseIf tok guard x)).lbl.integ =
      (evalD env (pc' ++ (evalD env pc' pcI' guard).lbl.conf)
        (Label.joinIntegrity pcI' (evalD env pc' pcI' guard).lbl.integ) x).lbl.integ :=
  Proofs.PcIntegrity.endorseIf_blocked_by_untrusted_cond
    (env := env) (pc := pc) (pcI := pcI) (c := c) (tok := tok) (guard := guard) (x := x) hCond

/-!
Composed regression: endorsement feeding declassification stays secret if the endorsement guard is
secret.
-/
theorem composed_endorse_then_declassify_hidden_guard
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom)
    (g x secret : ExprD)
    (hHide : ¬ canAccessConf p (evalD env pc pcI g).lbl.conf) :
    observe p (evalD env pc pcI (.declassifyIf tok (.endorseIf tok g x) secret)) = none :=
  Proofs.FlowPathConfidentiality.observe_declassifyIf_endorseIf_eq_none_of_hidden_guard
    (p := p) (env := env) (pc := pc) (pcI := pcI) (tok := tok) (g := g) (x := x) (secret := secret) hHide

end SafetyInvariants
end Proofs

end Cfc
