import Std

import Cfc.CommitPoint
import Cfc.Proofs.Intent

namespace Cfc

namespace Proofs
namespace CommitPoint

open Cfc

set_option linter.unnecessarySimpa false

theorem declassifyCommit_failed_of_no_intent
    (tok : Atom) (committed : Bool) (store : IntentStore)
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (guard secret : ExprD)
    (h : tok ∉ store) :
    Cfc.CommitPoint.declassifyCommit tok committed store env pc pcI guard secret =
      CommitResult.failed store := by
  simp [Cfc.CommitPoint.declassifyCommit, Cfc.Intent.commitOnce, h]

theorem declassifyCommit_no_consume_on_failure
    (tok : Atom) (store : IntentStore)
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (guard secret : ExprD)
    (h : tok ∈ store) :
    Cfc.CommitPoint.declassifyCommit tok false store env pc pcI guard secret =
      CommitResult.failed store := by
  simp [Cfc.CommitPoint.declassifyCommit, Cfc.Intent.commitOnce, h]

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
