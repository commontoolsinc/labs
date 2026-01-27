import Std

import Cfc.Language.Declassify
import Cfc.Proofs.RobustDeclassification

namespace Cfc

namespace Proofs
namespace PcIntegrity

open Cfc

/-
PC integrity (spec 3.4 and its use in robust declassification / transparent endorsement).

In the extended evaluator (`evalD`), we thread:
- `pc : ConfLabel` for flow-path confidentiality, and
- `pcI : IntegLabel` for control integrity (how trusted the current control path is).

When we branch on a condition `c`, we update:
  pc'  := pc ++ c.conf
  pcI' := joinIntegrity pcI c.integ

Since `joinIntegrity` is list intersection, `pcI'` can only contain tokens that are in *both*
the old pcI and the condition's integrity. This captures the idea:
"to trust a control decision, both the ambient context and the condition evidence must be trusted".

`TrustedScope` is our distinguished token that represents "trusted control flow".

This file proves simple facts of the form:
- if `TrustedScope` is absent from one side of an integrity intersection, it is absent from the result,
and uses them to show that:
- untrusted branch conditions block declassification and endorsement inside the branch.
-/

/-
If `TrustedScope` is not in the right operand of an intersection, it is not in the intersection.

Proof: membership in `joinIntegrity` means membership in both operands (`Label.mem_joinIntegrity`).
-/
theorem trustedScope_not_mem_joinIntegrity_right (I₁ I₂ : IntegLabel)
    (h : trustedScope ∉ I₂) :
    trustedScope ∉ Label.joinIntegrity I₁ I₂ := by
  intro hMem
  have h' := (Label.mem_joinIntegrity trustedScope I₁ I₂).1 hMem
  exact h h'.2

/-
Symmetric version: if `TrustedScope` is not in the left operand, it is not in the intersection.
-/
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
/-
This lemma is a "control-flow blocking" result for declassification.

Setup:
- We assume the condition `c` does *not* carry `TrustedScope` in its integrity.
- When we branch on `c`, we compute `pcI' := pcI ∩ c.integ`.
  By the intersection property, `TrustedScope ∉ pcI'`.
- Then, inside the branch, `declassifyIf` is blocked by `TrustedScope ∉ pcI'`.

Conclusion:
The confidentiality of `declassifyIf` inside the branch is the same as the normal
flow-tainted secret: no declassification rewrite happens.

Technically, we reuse the lemma `declassifyIf_pc_absent_preserves_conf` from
`Cfc.Proofs.RobustDeclassification`.
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
/-
Analogous blocking lemma for endorsement.

If the branch pc-integrity `pcI'` lacks `TrustedScope`, then *even if* the endorsement guard is true,
`endorseIf` cannot add the new token `tok`.

We prove this by showing:
  TrustedScope ∉ (pcI' ∩ guard.integ)
which is the condition checked by the endorsement semantics.

Then unfolding `evalD` reduces the endorsement to the "no-op" case on integrity.
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
