import Std

import Cfc.Exchange
import Cfc.Language.Declassify
import Cfc.Proofs.FlowPathConfidentiality

namespace Cfc

namespace Proofs
namespace ExchangeDeclassification

open Cfc
open Cfc.Exchange

/-!
Exchange-Based Declassification: A Composed "End-to-End" Theorem
===============================================================

The CFC spec's (somewhat novel) declassification story is:

  *Confidentiality is CNF (AND of OR-clauses).*
  A singleton clause `[A]` means "you must satisfy principal/authority `A`".

  *Declassification happens via exchange rules at trusted boundaries.*
  Given integrity evidence (provenance/consent/authorization), the runtime may rewrite the CNF.
  One important special case is **cancelling a requirement**:
    if the boundary can prove some integrity guard, it can *drop* a singleton clause `[A]`.

In this Lean repo, that cancellation primitive is modeled by:

  - `Exchange.exchangeDropSingletonIf` (in `Cfc.Exchange`)

which checks an integrity guard and, if it passes, drops the singleton clause `[A]` from the
confidentiality CNF.

However, to “tie it back to core IFC principles”, we want a *composed* theorem that connects:

  1) **Flow-path confidentiality** (PC confidentiality): if a decision depends on a secret guard,
     then outputs computed under that decision are also tainted by the guard's confidentiality.
     (Modeled and proved in `Cfc.Proofs.FlowPathConfidentiality`.)

  2) **Transparent endorsement**: `endorseIf tok guard x` can add an integrity token `tok`,
     but it does not remove confidentiality; it also propagates the guard's confidentiality into
     the branch `pc` for `x`. (Modeled in `Cfc.Language.Declassify`.)

  3) **Exchange-based cancellation**: dropping `[A]` should not create a covert channel by making
     an output observable even when its guard is hidden.

The theorem below is exactly that composition:

  If the endorsement guard is hidden from a principal `p`, then even after we apply an exchange
  rule that *might* drop a singleton confidentiality requirement `[dropAtom]`, the result is still
  unobservable to `p` — provided the exchange rule is not allowed to delete the guard's own
  confidentiality (we assume `[dropAtom]` is not one of the guard's confidentiality clauses).

This is the same “no covert channel via secret guard” principle proved for `declassifyIf`,
but now for the *exchange-based* cancellation mechanism.
-/

/-!
### A tiny helper: apply an exchange rewrite to a labeled value

`exchangeDropSingletonIf` rewrites a *Label*. Observation is defined on *LVal* (value + label),
so we package the rewritten label back into an `LVal`.

Note: this is a trusted-boundary operation; it is not part of the untrusted handler/program.
-/
def applyExchangeDropSingletonIf (needInteg : List Atom) (dropAtom : Atom)
    (boundary : IntegLabel) (v : LVal) : LVal :=
  { v with lbl := Exchange.exchangeDropSingletonIf needInteg dropAtom boundary v.lbl }

/-!
### Key technical lemma: the guard's confidentiality is still present after cancellation

Intuition:

1. Evaluating `endorseIf tok guard x` evaluates `x` under `pc' = pc ++ guard.conf`.
2. By the PC-confidentiality theorem `pc_subset_evalD_conf`, everything evaluated under `pc'`
   has confidentiality containing `pc'`, hence containing `guard.conf`.
3. `exchangeDropSingletonIf` only deletes the singleton clause `[dropAtom]`.
   So if `[dropAtom]` is *not* one of the guard's clauses, then every guard clause survives.

Formally, we show:

    guardConf ⊆ (exchangeDropSingletonIf ... (evalD ... endorseIf ...).lbl).conf

This is the bridge that lets us conclude:
if `p` can't satisfy `guardConf`, then `p` can't access the exchanged label either.
-/
theorem guardConf_subset_conf_after_exchangeDropSingletonIf
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (needInteg : List Atom) (dropAtom : Atom) (boundary : IntegLabel)
    (tok : Atom) (guard x : ExprD)
    (hNoDrop : ([dropAtom] : Clause) ∉ (evalD env pc pcI guard).lbl.conf) :
    (evalD env pc pcI guard).lbl.conf ⊆
      (Exchange.exchangeDropSingletonIf needInteg dropAtom boundary
        (evalD env pc pcI (.endorseIf tok guard x)).lbl).conf := by
  classical
  -- Shorthand names for readability in the proof.
  let guardConf : ConfLabel := (evalD env pc pcI guard).lbl.conf
  let pc' : ConfLabel := pc ++ guardConf
  let pcI' : IntegLabel := Label.joinIntegrity pcI (evalD env pc pcI guard).lbl.integ
  let xEval : LVal := evalD env pc' pcI' x

  -- First show: `guardConf ⊆ (evalD ... endorseIf ...).conf`.
  have hGuardInEndorse :
      guardConf ⊆ (evalD env pc pcI (.endorseIf tok guard x)).lbl.conf := by
    intro c hc
    -- `c ∈ guardConf` implies `c ∈ pc'` by membership in the right side of an append.
    have hcPc' : c ∈ pc' := by
      exact List.mem_append.2 (Or.inr (by simpa [guardConf] using hc))
    -- Any evaluation under `pc'` has confidentiality containing `pc'`.
    have hPcSub : pc' ⊆ xEval.lbl.conf :=
      Proofs.FlowPathConfidentiality.pc_subset_evalD_conf env pc' pcI' x
    have hcInX : c ∈ xEval.lbl.conf := hPcSub hcPc'
    -- `endorseIf` does not change confidentiality; it returns exactly the `x`-branch label.
    have hEqConf :
        (evalD env pc pcI (.endorseIf tok guard x)).lbl.conf = xEval.lbl.conf := by
      simpa [pc', pcI', xEval] using
        Proofs.TransparentEndorsement.endorseIf_conf_eq
          (env := env) (pc := pc) (pcI := pcI) (tok := tok) (guard := guard) (x := x)
    simpa [hEqConf] using hcInX

  -- Now we show the same subset holds *after* the exchange cancellation.
  --
  -- The exchange is an `if ... then ... else ...`, so we do a case split on the guard.
  let ℓ : Label := (evalD env pc pcI (.endorseIf tok guard x)).lbl
  cases hNeed : Exchange.hasAllB needInteg (Exchange.availIntegrity ℓ boundary) with
  | false =>
    -- Guard fails: exchange is the identity, so the subset is exactly `hGuardInEndorse`.
    have hEq : Exchange.exchangeDropSingletonIf needInteg dropAtom boundary ℓ = ℓ := by
      have hNeed' : Exchange.hasAllB needInteg (ℓ.integ ++ boundary) = false := by
        simpa [Exchange.availIntegrity] using hNeed
      simp [Exchange.exchangeDropSingletonIf, Exchange.availIntegrity, hNeed']
    -- Rewrite the goal with `hEq` and discharge it with the pre-exchange subset proof.
    simpa [hEq, ℓ, guardConf] using hGuardInEndorse
  | true =>
    -- Guard succeeds: confidentiality becomes `confDropSingleton dropAtom ℓ.conf`.
    --
    -- We must show: every `c ∈ guardConf` is still in the filtered list.
    have hEq :
        Exchange.exchangeDropSingletonIf needInteg dropAtom boundary ℓ =
          { ℓ with conf := Exchange.confDropSingleton dropAtom ℓ.conf } := by
      have hNeed' : Exchange.hasAllB needInteg (ℓ.integ ++ boundary) = true := by
        simpa [Exchange.availIntegrity] using hNeed
      simp [Exchange.exchangeDropSingletonIf, Exchange.availIntegrity, hNeed']
    intro c hc
    have hcInℓ : c ∈ ℓ.conf := by
      -- `hGuardInEndorse` was proven for the endorseIf output; `ℓ` is that label.
      have : c ∈ (evalD env pc pcI (.endorseIf tok guard x)).lbl.conf :=
        hGuardInEndorse (by simpa [guardConf] using hc)
      simpa [ℓ] using this
    have hcNe : c ≠ [dropAtom] := by
      -- If `c` were `[dropAtom]`, then `[dropAtom]` would be a member of `guardConf`,
      -- contradicting `hNoDrop`.
      intro hEq
      have : ([dropAtom] : Clause) ∈ guardConf := by
        simpa [guardConf, hEq] using hc
      exact hNoDrop (by simpa [guardConf] using this)
    -- Membership in a filtered list: keep `c` because it's not the removed singleton clause.
    have hcInDropped : c ∈ Exchange.confDropSingleton dropAtom ℓ.conf := by
      -- `confDropSingleton` is `filter (fun c => decide (c ≠ [dropAtom]))`.
      apply (List.mem_filter).2
      refine ⟨hcInℓ, ?_⟩
      -- Turn `hcNe : c ≠ [dropAtom]` into the boolean condition.
      simp [hcNe]
    -- Rewrite the goal with `hEq` and reduce `.conf`.
    simpa [ℓ, hEq] using hcInDropped

/-!
### Main composed theorem: cancellation cannot defeat PC confidentiality

If the endorsement guard is hidden from principal `p`, then the endorsed value is hidden
(already proved in `FlowPathConfidentiality.observe_endorseIf_eq_none_of_hidden_guard`).

But we also want: even after a *policy exchange* drops a singleton clause `[dropAtom]`,
the result is still hidden — so the cancellation mechanism cannot be used as a covert channel.

The proof is:

1. From `¬ canAccessConf p guardConf` we extract a specific clause `c ∈ guardConf`
   that `p` cannot satisfy.
2. By `guardConf_subset_conf_after_exchangeDropSingletonIf`, that same `c` appears in the
   confidentiality of the exchanged label (it survived the cancellation).
3. Therefore `p` still cannot access the exchanged label, hence observation is `none`.
-/
theorem observe_exchangeDropSingletonIf_endorseIf_eq_none_of_hidden_guard
    (p : Principal) (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (needInteg : List Atom) (dropAtom : Atom) (boundary : IntegLabel)
    (tok : Atom) (guard x : ExprD)
    (hHide : ¬ canAccessConf p (evalD env pc pcI guard).lbl.conf)
    (hNoDrop : ([dropAtom] : Clause) ∉ (evalD env pc pcI guard).lbl.conf) :
    observe p
      (applyExchangeDropSingletonIf needInteg dropAtom boundary
        (evalD env pc pcI (.endorseIf tok guard x))) = none := by
  classical
  -- Name the key objects to avoid repeating `evalD ...` everywhere.
  let guardConf : ConfLabel := (evalD env pc pcI guard).lbl.conf
  let v : LVal := evalD env pc pcI (.endorseIf tok guard x)
  let v' : LVal := applyExchangeDropSingletonIf needInteg dropAtom boundary v

  -- From `¬ canAccessConf p guardConf`, extract a concrete clause that `p` can't satisfy.
  have hBad : ∃ c : Clause, c ∈ guardConf ∧ ¬ clauseSat p c := by
    -- `canAccessConf p guardConf` is a `∀` over clauses, so its negation gives an `∃`.
    simpa [canAccessConf] using hHide

  rcases hBad with ⟨c, hcGuard, hNoSat⟩

  -- Show that the same bad clause `c` is still present in the exchanged confidentiality CNF.
  have hSub : guardConf ⊆ v'.lbl.conf := by
    -- Reuse the lemma proved above (it is exactly the subset fact we need).
    simpa [v', v, applyExchangeDropSingletonIf, guardConf] using
      guardConf_subset_conf_after_exchangeDropSingletonIf
        (env := env) (pc := pc) (pcI := pcI)
        (needInteg := needInteg) (dropAtom := dropAtom) (boundary := boundary)
        (tok := tok) (guard := guard) (x := x) hNoDrop

  have hcInOut : c ∈ v'.lbl.conf := hSub (by simpa [guardConf] using hcGuard)

  -- Therefore `p` cannot access the exchanged label: it still contains an unsatisfiable clause.
  have hNoAccess : ¬ canAccess p v'.lbl := by
    intro hAcc
    have hAccConf : canAccessConf p v'.lbl.conf := by
      simpa [canAccess] using hAcc
    have : clauseSat p c := hAccConf c (by simpa using hcInOut)
    exact hNoSat this

  -- And `observe` is `none` when access fails.
  have hNoAccess' :
      ¬ canAccess p
        (applyExchangeDropSingletonIf needInteg dropAtom boundary
          (evalD env pc pcI (.endorseIf tok guard x))).lbl := by
    simpa [v', v] using hNoAccess
  simp [observe, hNoAccess']

end ExchangeDeclassification
end Proofs

end Cfc
