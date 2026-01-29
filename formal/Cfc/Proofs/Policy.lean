import Std

import Cfc.Policy
import Cfc.Proofs.GmailExample

namespace Cfc

/-!
Proofs / regressions for policy evaluation (spec 4.3 / 4.4 / 5).

This file connects the abstract "policy record + exchange rules" evaluator (`Cfc.Policy`)
to concrete examples already present in the repo (notably the Gmail OAuth example).

The key goals:

1. Show that policy evaluation can reproduce the "authority-only token drop" behavior from
   `formal/Cfc/Proofs/GmailExample.lean`, but now via a policy record instead of calling a
   specific exchange helper directly.

2. Show that if the integrity guard is missing, no rewrite occurs (safe default).

We keep these as small executable regressions (computed by `simp`) rather than deep proofs.
-/

namespace Proofs
namespace Policy

open Cfc.Policy
open Cfc.Proofs.GmailExample

/-!
## A GoogleAuth policy record (minimal)

In the spec, `GoogleAuth(Alice)` is a policy principal whose policy record contains exchange rules.
For this Lean model, we only need *one* exchange rule:

  If integrity contains `AuthorizedRequest` and `NetworkProvenance`,
  then drop the singleton confidentiality clause `[GoogleAuth(u)]`.

This models the "authority-only" token behavior from spec 1.2.
-/

def googleAuthPolicyDropRule (u : String) : ExchangeRule :=
  { name := "AuthorityOnlyDropGoogleAuth"
    preConf :=
      [ AtomPattern.policy
          (Pat.lit "GoogleAuth")
          (Pat.lit u)
          (Pat.lit "h") ]
    preInteg :=
      [ AtomPattern.integrityTok (Pat.lit "AuthorizedRequest")
        , AtomPattern.integrityTok (Pat.lit "NetworkProvenance") ]
    -- Empty postConf means: drop the matched alternative, and if that empties the clause, drop the clause.
    postConf := []
    postInteg := [] }

def googleAuthPolicyRecord (u : String) : PolicyRecord :=
  { principal := googleAuth u
    exchangeRules := [googleAuthPolicyDropRule u] }

/-!
Note on these regressions:

We pick a concrete user id (`"Alice"`) rather than quantifying over all `u : String`.
This makes the evaluator fully executable in the proof (all string equalities reduce),
which is closer to how the spec intends policy evaluation to run at runtime.
-/

def alice : String := "Alice"

/-!
## Regression 1: with guards, policy evaluation drops the token secrecy clause
-/

example :
    let pols := [googleAuthPolicyRecord alice]
    let boundary : IntegLabel := [authorizedRequest, networkProvenance]
    Policy.evalFixpoint 1 pols boundary (tokenLabel alice) = { conf := [[Atom.user alice]], integ := [] } := by
  -- `native_decide` runs the (trusted) computation and discharges definitional equalities.
  --
  -- This is a good fit for policy-evaluation regressions: we want to ensure the executable
  -- evaluator performs the same rewrite the spec describes.
  native_decide

/-!
## Regression 2: without guards, policy evaluation is a no-op (safe default)
-/

example :
    let pols := [googleAuthPolicyRecord alice]
    let boundary : IntegLabel := []  -- missing integrity evidence
    Policy.evalFixpoint 1 pols boundary (tokenLabel alice) = tokenLabel alice := by
  native_decide

end Policy
end Proofs

end Cfc
