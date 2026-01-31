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

Big picture:

The spec treats "commit points" as the place where:
- side effects (writes, egress, external calls) actually occur, and
- certain policy steps (notably declassification) are allowed, but only under strong conditions.

The most important condition we model is "intent-coupling":

  You can only perform a commit if you have an `IntentOnce` token,
  and if the commit succeeds, the token is consumed exactly once.

This prevents replay of user approval and matches Safety invariant 4.

This module ties that to our tiny declassification language (`Cfc.Language.Declassify`):
we evaluate a `declassifyIf tok guard secret` *only if* the commit actually committed.
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
/-
`CommitResult` is a lightweight way to model "either we produced an output at commit, or we did not":
- `committed value store'` means the side effect committed and we return a value plus the updated store.
- `failed store'` means no committed output (and we still return the store, because consumption matters).

`declassifyCommit` is the canonical "commit point" operation in this model.

Inputs:
- `tok` : the intent token required to commit
- `committed` : a Boolean standing in for the external world's success/failure outcome
- `store` : intent store before the attempt
- `env, pc, pcI, guard, secret` : inputs to evaluate the declassification expression

Behavior:
1) Call `Intent.commitOnce tok store committed`.
   - If it returns `none`, the token wasn't present: we fail without changing the store.
   - If it returns `some store'`, the token was present, and:
       * if `committed = true`, then `store'` is the consumed store,
       * if `committed = false`, then `store' = store` (no-consume-on-failure).
2) Only in the `committed = true` case do we evaluate the declassification expression.
   Otherwise we return `failed store'`.

Why "evaluate declassification only on commit"?

This models the spec's idea that declassification at commit is coupled to side effects:
you shouldn't be able to get a declassified output without actually consuming the intent and committing.
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
