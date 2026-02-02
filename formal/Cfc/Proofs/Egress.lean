import Std

import Cfc.Egress
import Cfc.Proofs.GmailExample
import Cfc.Proofs.Policy

namespace Cfc

/-!
End-to-end egress regressions.

Goal: connect three layers of the spec in one place:

1) A value has a confidentiality label (CNF).
2) A trusted boundary evaluates policy exchange rules (to a fixpoint).
3) The boundary then checks `canAccess` for the boundary principal (acting user + capabilities).

This is the smallest self-contained bridge from "policy evaluation" to "egress allowed/denied".
-/

namespace Proofs
namespace Egress

open Cfc.Egress
open Cfc.Policy
open Cfc.Proofs.GmailExample

/-!
## A network capability principal

We model "network egress to gmail.googleapis.com is allowed" as a capability principal
that the network boundary principal can satisfy.

This is intentionally schematic; the spec has a richer `Capability` shape.
-/

def gmailNet : Atom :=
  Atom.capability "network" "gmail.googleapis.com"

/-!
## A GoogleAuth policy rule that enables Gmail egress

This is a toy rule for the egress story:

  If we have integrity evidence that the request was authorized and had trusted network provenance,
  then we may treat `GoogleAuth(Alice)` as also satisfiable by the Gmail network capability.

In CNF terms: we add `gmailNet` as an alternative to the clause containing `GoogleAuth(Alice)`.
-/

def googleAuthEnablesGmailEgressRule : ExchangeRule :=
  { name := "GoogleAuthEnablesGmailEgress"
    preConf :=
      [ AtomPattern.eq (googleAuth Cfc.Proofs.Policy.alice) ]
    preInteg :=
      [ AtomPattern.eq authorizedRequest
        , AtomPattern.eq networkProvenance ]
    postConf :=
      [ AtomPattern.eq gmailNet ]
    postInteg := [] }

def googleAuthPolicyWithEgress : PolicyRecord :=
  { principal := googleAuth Cfc.Proofs.Policy.alice
    exchangeRules := [googleAuthEnablesGmailEgressRule] }

/-!
## Boundary principal for network egress

We treat the egress principal as "acting user + egress capability".

This is how we connect confidentiality to an actual sink:
to egress, the sink must be able to "read" the value under the post-policy label.
-/

def netBoundaryPrincipal : Principal :=
  { now := 0, atoms := [Atom.user Cfc.Proofs.Policy.alice, gmailNet] }

def netBoundaryWithGuards : Cfc.Egress.Boundary :=
  { fuel := 2
    integrity := [authorizedRequest, networkProvenance]
    principal := netBoundaryPrincipal }

def netBoundaryNoGuards : Cfc.Egress.Boundary :=
  { fuel := 2
    integrity := []
    principal := netBoundaryPrincipal }

/-!
## Theorems: egress denied without guards; allowed with guards

These are the core safety stories:

* Safe default: without integrity evidence, policy evaluation cannot unlock egress.
* With evidence, policy evaluation can add exactly the capability needed to satisfy the sink.
-/

example : ¬ Cfc.Egress.allowed [googleAuthPolicyWithEgress] netBoundaryNoGuards (tokenLabel Cfc.Proofs.Policy.alice) := by
  classical
  intro hAllowed
  -- Without guards, the policy rule does not fire, so the label stays `tokenLabel alice`.
  have hEval :
      Cfc.Egress.evalAtBoundary [googleAuthPolicyWithEgress] netBoundaryNoGuards (tokenLabel Cfc.Proofs.Policy.alice) =
        tokenLabel Cfc.Proofs.Policy.alice := by
    -- The evaluator is executable; `native_decide` computes this equality.
    native_decide
  have hAcc : canAccess netBoundaryPrincipal (tokenLabel Cfc.Proofs.Policy.alice) := by
    simpa [Cfc.Egress.allowed, Cfc.Egress.evalAtBoundary, netBoundaryNoGuards, hEval] using hAllowed
  -- But `tokenLabel alice` contains a singleton `[GoogleAuth(alice)]` clause, which the egress principal
  -- does not satisfy.
  have hMem : ([googleAuth Cfc.Proofs.Policy.alice] : Clause) ∈ (tokenLabel Cfc.Proofs.Policy.alice).conf := by
    simp [tokenLabel]
  have hClause : clauseSat netBoundaryPrincipal [googleAuth Cfc.Proofs.Policy.alice] := hAcc _ hMem
  rcases hClause with ⟨a, haMem, haSat⟩
  have : a = googleAuth Cfc.Proofs.Policy.alice := by simpa using haMem
  subst this
  -- The principal's atoms are `[User(alice), gmailNet]`, so it cannot satisfy `GoogleAuth(alice)`.
  simp [netBoundaryPrincipal, Principal.satisfies, googleAuth, gmailNet] at haSat

example : Cfc.Egress.allowed [googleAuthPolicyWithEgress] netBoundaryWithGuards (tokenLabel Cfc.Proofs.Policy.alice) := by
  classical
  -- With guards, policy evaluation adds `gmailNet` as an alternative for the GoogleAuth clause.
  let outLbl : Label :=
    { conf := [[Atom.user Cfc.Proofs.Policy.alice], [gmailNet, googleAuth Cfc.Proofs.Policy.alice]]
      integ := [] }
  have hEval :
      Cfc.Egress.evalAtBoundary [googleAuthPolicyWithEgress] netBoundaryWithGuards (tokenLabel Cfc.Proofs.Policy.alice) =
        outLbl := by
    native_decide

  -- Show `canAccess` for the evaluated normal form by providing one satisfying atom per clause.
  have hAcc : canAccess netBoundaryPrincipal outLbl := by
    unfold canAccess canAccessConf clauseSat
    intro c hc
    have hc' : c = [Atom.user Cfc.Proofs.Policy.alice] ∨ c = [gmailNet, googleAuth Cfc.Proofs.Policy.alice] := by
      simpa [outLbl] using hc
    cases hc' with
    | inl hUser =>
        subst hUser
        refine ⟨Atom.user Cfc.Proofs.Policy.alice, by simp, ?_⟩
        simp [netBoundaryPrincipal, Principal.satisfies]
    | inr hEgress =>
        subst hEgress
        refine ⟨gmailNet, by simp, ?_⟩
        simp [netBoundaryPrincipal, Principal.satisfies, gmailNet]

  -- Finally, rewrite `allowed` using the computed boundary evaluation result.
  unfold Cfc.Egress.allowed
  simpa [Cfc.Egress.evalAtBoundary, netBoundaryWithGuards, hEval] using hAcc

end Egress
end Proofs

end Cfc
