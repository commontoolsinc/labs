import Std

import Cfc.Language.Declassify

namespace Cfc

namespace Proofs
namespace TransparentEndorsement

open Cfc

/-
Transparent endorsement (spec 3.8.7).

The idea:
- Endorsement adds integrity facts (e.g. "this value is authorized") to some result.
- But endorsement must be *transparent*: it must not silently create a covert channel where
  the presence/absence of integrity reveals secret information.

In our tiny model, `endorseIf tok guard x`:
- evaluates `guard` under `(pc, pcI)`
- propagates the guard's confidentiality into the branch pc for `x` (pc' := pc ++ guard.conf)
- propagates guard integrity into control integrity (pcI' := joinIntegrity pcI guard.integ)
- evaluates `x` under `(pc', pcI')`
- if guard is true AND `TrustedScope ∈ pcI'`, then it appends `[tok]` to `x`'s integrity

So endorsement is blocked when the control decision is not trusted (no TrustedScope).

The lemmas below are small "field projection" facts about this semantics.
-/

/-
Confidentiality of endorsement:

Endorsement should not change confidentiality beyond what control flow already forces.
This lemma says: the resulting confidentiality of `endorseIf` is exactly the confidentiality
of evaluating `x` under the updated pc (pc ++ guard.conf) and updated control-integrity.

In other words, any difference between the "endorse" and "no endorse" case is only in integrity,
not in confidentiality.

Proof structure:
- Case split on whether the guard evaluates to true.
- In the true case, further split on whether TrustedScope is present in pcI'.
- In all cases, unfold `evalD` and let `simp` reduce.
-/
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

/-
If endorsement fires, the token appears in the output integrity.

Assumptions:
- guard evaluated to true
- TrustedScope is present in the updated pc-integrity

Then by the semantics, we take the branch that calls `Label.endorse ... [tok]`,
so `tok` is in the resulting integrity list.

This lemma is used later as "evidence extraction": if you observe an endorsed result,
you can rely on the token being present when the trust condition holds.
-/
theorem endorseIf_tok_mem_of_guard_true
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel) (tok : Atom) (guard x : ExprD)
    (hTrue : (evalD env pc pcI guard).val = true)
    (hPc : trustedScope ∈ Label.joinIntegrity pcI (evalD env pc pcI guard).lbl.integ) :
    tok ∈ (evalD env pc pcI (.endorseIf tok guard x)).lbl.integ := by
  simp [evalD, hTrue, hPc]

end TransparentEndorsement
end Proofs

end Cfc
