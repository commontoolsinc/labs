import Std

import Cfc.Intent
import Cfc.Language.Declassify

namespace Cfc

/-!
Commit points (spec Sections 6/7; Safety invariant 4).

This is a tiny, proof-friendly model:
- An external side effect is represented by a boolean `committed` outcome.
- An event-scoped intent token (`IntentOnce`) must be present to attempt the commit.
- The token is consumed iff the effect is committed ("no-consume-on-failure").

We only model the consumption behavior and its interaction with declassification at the commit point.
-/

inductive CommitResult (α : Type) where
  | committed (value : α) (store : IntentStore)
  | failed (store : IntentStore)
  deriving Repr

namespace CommitPoint

/--
Commit-coupled declassification:
- if no intent token is available, the commit cannot happen;
- if the effect is committed, the intent is consumed and declassification is evaluated;
- otherwise, the intent is not consumed and no output is produced.
-/
def declassifyCommit
    (tok : Atom) (committed : Bool) (store : IntentStore)
    (env : Env) (pc : ConfLabel) (pcI : IntegLabel)
    (guard secret : ExprD) : CommitResult LVal :=
  match Intent.commitOnce tok store committed with
  | none =>
      CommitResult.failed store
  | some store' =>
      if committed then
        CommitResult.committed (evalD env pc pcI (.declassifyIf tok guard secret)) store'
      else
        CommitResult.failed store'

end CommitPoint

end Cfc

