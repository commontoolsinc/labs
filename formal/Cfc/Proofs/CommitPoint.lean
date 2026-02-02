import Std

import Cfc.CommitPoint
import Cfc.Proofs.Intent

namespace Cfc

namespace Proofs
namespace CommitPoint

open Cfc

/-
Proofs about the minimal commit-point model (`Cfc.CommitPoint`).

Spec connection:
- Safety invariant 4: commit-coupled consumption for side effects.

Recall `CommitPoint.declassifyCommit`:
- checks/consumes an intent token with `Intent.commitOnce`
- only evaluates the declassification expression when `committed = true`
- otherwise returns `CommitResult.failed` with the (possibly unchanged) store

These lemmas formalize the key behaviors:
- no intent => cannot commit
- failure => no consumption
- success => single-use (under `Nodup` store)
-/

set_option linter.unnecessarySimpa false

/-
If the intent token is not present, `declassifyCommit` always fails.

This is a definitional simplification: `Intent.commitOnce` returns `none`,
so `declassifyCommit` takes the `none` match branch.
-/
theorem declassifyCommit_failed_of_no_intent
    (tok : Atom) (committed : Bool) (store : IntentStore)
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (guard secret : ExprD)
    (h : tok ∉ store) :
    Cfc.CommitPoint.declassifyCommit tok committed store env pc pcI guard secret =
      CommitResult.failed store := by
  simp [Cfc.CommitPoint.declassifyCommit, Cfc.Intent.commitOnce, h]

/-
If the token is present but `committed = false`, then `declassifyCommit` fails *without consuming*
the token (no-consume-on-failure).

Again this is definitional: in the `committed=false` branch, `Intent.commitOnce` returns `some store`,
and then `declassifyCommit` returns `failed store`.
-/
theorem declassifyCommit_no_consume_on_failure
    (tok : Atom) (store : IntentStore)
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (guard secret : ExprD)
    (h : tok ∈ store) :
    Cfc.CommitPoint.declassifyCommit tok false store env pc pcI guard secret =
      CommitResult.failed store := by
  simp [Cfc.CommitPoint.declassifyCommit, Cfc.Intent.commitOnce, h]

/-
Single-use for commit points:

Assume:
- `store` has no duplicates (`Nodup`)
- a first call to `declassifyCommit` with `committed = true` returns `.committed ... store'`

Then a second call with the resulting `store'` must fail (`.failed store'`),
because the token was consumed by the first successful commit.

Proof outline:
1) From the hypothesis about `declassifyCommit`, extract that `Intent.commitOnce tok store true = some store'`.
   We do this by case-splitting on `commitOnce` and ruling out the `none` case (it couldn't produce `.committed`).
2) Apply `Proofs.Intent.commitOnce_single_use` to show `commitOnce tok store' true = none`.
3) Unfold `declassifyCommit`: if `commitOnce` is `none`, we are in the `.failed` case.
-/
theorem declassifyCommit_single_use
    {tok : Atom} {store store' : IntentStore}
    (hs : store.Nodup)
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (guard secret : ExprD)
    (hCommit :
      Cfc.CommitPoint.declassifyCommit tok true store env pc pcI guard secret =
        CommitResult.committed (evalD env pc pcI (.declassifyIf tok guard secret)) store') :
    Cfc.CommitPoint.declassifyCommit tok true store' env pc pcI guard secret =
      CommitResult.failed store' := by
  -- Extract the consumed store from the definitional behavior of `declassifyCommit`.
  have hStore' : Cfc.Intent.commitOnce tok store true = some store' := by
    cases hStore : Cfc.Intent.commitOnce tok store true
    case none =>
      -- Contradiction: no intent => `declassifyCommit` can't be `.committed`.
      have hContra : False := by
        have : CommitResult.failed store =
            CommitResult.committed (evalD env pc pcI (.declassifyIf tok guard secret)) store' := by
          simpa [Cfc.CommitPoint.declassifyCommit, hStore] using hCommit
        cases this
      exact False.elim hContra
    case some store'' =>
      have hCommit' := hCommit
      simp [Cfc.CommitPoint.declassifyCommit, hStore] at hCommit'
      -- `simp` reduces this to the store equality in the success case.
      have hEq : store'' = store' := hCommit'
      subst hEq
      rfl
  -- Single-use: after a successful commit, the token is no longer present.
  have hNo : Cfc.Intent.commitOnce tok store' true = none :=
    Proofs.Intent.commitOnce_single_use (tok := tok) (s := store) (s' := store') hs hStore'
  -- Therefore the second commit fails.
  simp [Cfc.CommitPoint.declassifyCommit, hNo]

end CommitPoint
end Proofs

end Cfc
