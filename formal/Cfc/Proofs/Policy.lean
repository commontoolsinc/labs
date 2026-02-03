import Std

import Cfc.Policy
import Cfc.SinkGate
import Cfc.Proofs.GmailExample

namespace Cfc

/-!
Proofs / regressions for policy evaluation (spec 4.3 / 4.4 / 5).

This file connects the abstract "policy record + exchange rules" evaluator (`Cfc.Policy`)
to concrete examples already present in the repo (notably the Gmail OAuth example).

The key goals:

1. Show that policy evaluation can reproduce the "authority-only token drop" behavior from
   `formal/Cfc/Proofs/GmailExample.lean`, but now via a **sink-scoped exchange rule**
   evaluated by the sink gate (spec 5.2.1), rather than by a separate `endorse_request`
   component.

2. Show that if the token taint appears at a disallowed path, the sink gate does not strip it
   (safe default).

We keep these as small executable regressions (computed by `simp`) rather than deep proofs.
-/

namespace Proofs
namespace Policy

open Cfc.Policy
open Cfc.Proofs.GmailExample

/-!
## A GoogleAuth policy record (minimal)

In the spec, `GoogleAuth(Alice)` is a policy principal whose policy record contains exchange rules.
For this Lean model, we only need *one* sink-scoped exchange rule:

  If the request flows to the `fetchData` sink and the `GoogleAuth(u)` taint appears only at the
  allowed Authorization header path, then drop the singleton confidentiality clause
  `[GoogleAuth(u)]` and emit `AuthorizedRequest(fetchData)` as integrity.

This models the "authority-only" token behavior from spec 1.2, but with the updated
architecture from spec 5.2.1 (sink gate).
-/

def fetchDataSink : String := "fetchData"

def authHeaderPath : SinkGate.Path :=
  ["options", "headers", "Authorization"]

def googleAuthPolicySinkDropRule (u : String) : ExchangeRule :=
  { name := "SinkDropGoogleAuthAtAuthorizationHeader"
    preConf :=
      [ AtomPattern.policy
          (Pat.lit "GoogleAuth")
          (Pat.lit u)
          (Pat.lit "h") ]
    preInteg := []
    -- Empty postConf means: drop the matched alternative (and the clause, since it is a singleton).
    postConf := []
    postInteg := []
    allowedSink := some fetchDataSink
    allowedPaths := [authHeaderPath] }

def googleAuthPolicyRecord (u : String) : PolicyRecord :=
  { principal := googleAuth u
    exchangeRules := [googleAuthPolicySinkDropRule u] }

/-!
Note on these regressions:

We pick a concrete user id (`"Alice"`) rather than quantifying over all `u : String`.
This makes the evaluator fully executable in the proof (all string equalities reduce),
which is closer to how the spec intends policy evaluation to run at runtime.
-/

def alice : String := "Alice"

/-!
## Regression 1: with correct token placement, the sink gate strips authority-only secrecy
-/

example :
    let pols := [googleAuthPolicyRecord alice]
    let taints : SinkGate.PathTaints := [(authHeaderPath, [googleAuth alice])]
    SinkGate.evalSinkGate pols fetchDataSink taints [] (tokenLabel alice) =
      { conf := [[Atom.user alice]], integ := [SinkGate.authorizedRequest fetchDataSink] } := by
  -- `native_decide` runs the computation and discharges definitional equalities.
  native_decide

/-!
## Regression 2: token at a disallowed path is NOT stripped (safe default)
-/

example :
    let pols := [googleAuthPolicyRecord alice]
    let badPath : SinkGate.Path := ["query", "token"]
    let taints : SinkGate.PathTaints := [(badPath, [googleAuth alice])]
    SinkGate.evalSinkGate pols fetchDataSink taints [] (tokenLabel alice) = tokenLabel alice := by
  native_decide

/-!
## Regression 3: avoid "stale index" bugs when applying drop rules

This regression targets a subtle but important implementation detail:

`matchRule` returns matches using *indices* into the label's CNF:
  - `clauseIndex` selects a clause in `label.conf`,
  - `altIndex` selects an alternative (atom) within that clause.

But drop rules (`postConf = []`) *remove* an alternative, and may remove the whole clause if it
becomes empty. That shifts indices.

If an evaluator computes all matches once and then applies them in ascending order, a later match
can accidentally refer to a different clause than the one it originally matched.

We guard against this in `Cfc.Policy` by:
- applying drop-matches in descending index order (delete-from-the-back), and
- re-checking that the atom at the target index is the one that was matched.

The example below would be wrong with a naive ascending-order application:

  Start: [ [PolicyP], [A], [B], [C] ]
  If you drop clause 1 first, `B` becomes clause 1 and `C` becomes clause 2.
  A later match that *intended* to drop `B` at clauseIndex=2 would instead drop `C`.

With the fixed implementation, all three `[A]`, `[B]`, `[C]` clauses are dropped.
-/

def P : Atom :=
  Atom.policy "P" "subject" "h"

def dropAnyOtherRule : ExchangeRule :=
  { name := "DropAnyOther"
    preConf := [AtomPattern.other (Pat.var "X")] -- match `Atom.other n` for any `n`
    preInteg := []
    postConf := []  -- drop the matched alternative
    postInteg := [] }

def dropAnyOtherRecord : PolicyRecord :=
  { principal := P
    exchangeRules := [dropAnyOtherRule] }

def staleIndexLabel : Label :=
  { conf := [[P], [Atom.other "A"], [Atom.other "B"], [Atom.other "C"]]
    integ := [] }

example :
    Policy.evalFixpoint 1 [dropAnyOtherRecord] [] staleIndexLabel =
      { conf := [[P]], integ := [] } := by
  native_decide

end Policy
end Proofs

end Cfc
