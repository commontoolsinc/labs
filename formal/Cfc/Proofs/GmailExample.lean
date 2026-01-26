import Std

import Cfc.Access
import Cfc.CommitPoint
import Cfc.Exchange
import Cfc.Language.Declassify
import Cfc.Proofs.CommitPoint

namespace Cfc

namespace Proofs
namespace GmailExample

open Cfc
open Cfc.Exchange

/-!
A small Lean "Gmail OAuth" regression suite aligned with `docs/specs/cfc/01-gmail-example.md`.

This is intentionally abstract: values are booleans, and we model only the label- and
intent-consumption aspects needed to exercise the core building blocks.
-/

def googleAuth (u : String) : Atom :=
  Atom.policy "GoogleAuth" u "h"

def emailMetadataSecret (u : String) : Atom :=
  Atom.other ("EmailMetadataSecret(" ++ u ++ ")")

def notesSecret (u : String) : Atom :=
  Atom.other ("NotesSecret(" ++ u ++ ")")

def authorizedRequest : Atom :=
  Atom.integrityTok "AuthorizedRequest"

def networkProvenance : Atom :=
  Atom.integrityTok "NetworkProvenance"

def pAlice (u : String) : Principal :=
  { now := 0, atoms := [Atom.user u, emailMetadataSecret u] }

def tokenLabel (u : String) : Label :=
  { conf := [[Atom.user u], [googleAuth u]]
    integ := [] }

def gmailReadResponseLabel (u : String) : Label :=
  { conf := [[Atom.user u], [emailMetadataSecret u]]
    integ := [] }

/-!
Spec 1.2 (read): token secrecy is authority-only and should not taint responses.

We model the "fix" as dropping the singleton `GoogleAuth(u)` clause when the appropriate
integrity guards are present.
-/
theorem read_requires_googleAuth_without_guards (u : String) :
    ¬ canAccess (pAlice u) (tokenLabel u + gmailReadResponseLabel u) := by
  classical
  -- The joined label contains a `[GoogleAuth(u)]` clause.
  intro hAcc
  have hMem : ([googleAuth u] : Clause) ∈ (tokenLabel u + gmailReadResponseLabel u).conf := by
    simp [tokenLabel, gmailReadResponseLabel]
  have hClause : clauseSat (pAlice u) [googleAuth u] := hAcc [googleAuth u] hMem
  rcases hClause with ⟨a, ha, hs⟩
  have : a = googleAuth u := by
    simpa using ha
  subst this
  -- `pAlice` does not satisfy `GoogleAuth(u)`.
  simp [pAlice, Principal.satisfies, emailMetadataSecret, googleAuth] at hs

theorem read_allows_after_authority_only_drop (u : String) :
    canAccess (pAlice u)
      ((Exchange.exchangeDropSingletonIf
          [authorizedRequest, networkProvenance]
          (googleAuth u)
          [authorizedRequest, networkProvenance]
          (tokenLabel u)) +
        gmailReadResponseLabel u) := by
  classical
  -- Compute the exchange result, then discharge `canAccess` by simple witnesses.
  have hTok :
      Exchange.exchangeDropSingletonIf
          [authorizedRequest, networkProvenance]
          (googleAuth u)
          [authorizedRequest, networkProvenance]
          (tokenLabel u) =
        { conf := [[Atom.user u]], integ := [] } := by
    simp [Exchange.exchangeDropSingletonIf, Exchange.hasAllB, Exchange.availIntegrity,
      Exchange.confDropSingleton, tokenLabel, authorizedRequest, networkProvenance, googleAuth]
  -- Now show `pAlice` can access both parts and use conjunctive access for joins.
  have hLeft : canAccess (pAlice u) { conf := [[Atom.user u]], integ := [] } := by
    unfold canAccess canAccessConf clauseSat
    intro c hc
    have : c = [Atom.user u] := by
      simpa using hc
    subst this
    refine ⟨Atom.user u, by simp, ?_⟩
    simp [pAlice, Principal.satisfies, emailMetadataSecret]
  have hResp : canAccess (pAlice u) (gmailReadResponseLabel u) := by
    unfold canAccess canAccessConf clauseSat
    intro c hc
    have : c = [Atom.user u] ∨ c = [emailMetadataSecret u] := by
      simpa [gmailReadResponseLabel] using hc
    cases this with
    | inl hcu =>
      subst hcu
      refine ⟨Atom.user u, by simp, ?_⟩
      simp [pAlice, Principal.satisfies, emailMetadataSecret]
    | inr hcm =>
      subst hcm
      refine ⟨emailMetadataSecret u, by simp, ?_⟩
      simp [pAlice, Principal.satisfies, emailMetadataSecret]
  have hJoin : canAccess (pAlice u) ({ conf := [[Atom.user u]], integ := [] } + gmailReadResponseLabel u) :=
    (canAccess_join_iff (pAlice u) _ _).2 ⟨hLeft, hResp⟩
  simpa [hTok] using hJoin

/-!
Spec 1.3 (read): secret query input taints the response.
-/
theorem search_query_taints_response (u : String) :
    let ℓResp := gmailReadResponseLabel u
    let ℓQuery : Label := { conf := [[notesSecret u]], integ := [] }
    ¬ canAccess (pAlice u) (ℓResp + ℓQuery) := by
  classical
  intro ℓResp ℓQuery
  intro hAcc
  have hMem : ([notesSecret u] : Clause) ∈ (ℓResp + ℓQuery).conf := by
    simp [ℓResp, ℓQuery]
  have hClause : clauseSat (pAlice u) [notesSecret u] := hAcc [notesSecret u] hMem
  rcases hClause with ⟨a, ha, hs⟩
  have : a = notesSecret u := by
    simpa using ha
  subst this
  simp [pAlice, Principal.satisfies, notesSecret, emailMetadataSecret] at hs

/-!
Spec 1.4.6 (write): the commit point consumes an `IntentOnce` token only on commit,
and the token is single-use.
-/
theorem forward_commit_no_consume_on_failure (u : String) :
    let tok : Atom := Atom.integrityTok "IntentOnceForward"
    let env : Env := fun _ => { val := false, lbl := Label.bot }
    let pc : ConfLabel := [[Atom.user u]]
    let pcI : IntegLabel := [trustedScope, tok]
    let guard : ExprD := .lit true
    let secret : ExprD := .lit false
    Cfc.CommitPoint.declassifyCommit tok false [tok] env pc pcI guard secret =
      CommitResult.failed [tok] := by
  intro tok env pc pcI guard secret
  -- If the effect is not committed, we do not consume the token.
  have h : tok ∈ ([tok] : IntentStore) := by simp
  simpa using
    Proofs.CommitPoint.declassifyCommit_no_consume_on_failure tok [tok] env pc pcI guard secret h

theorem forward_commit_consumes_intent_once (u : String) :
    let tok : Atom := Atom.integrityTok "IntentOnceForward"
    let env : Env := fun _ => { val := false, lbl := Label.bot }
    let pc : ConfLabel := [[Atom.user u]]
    let pcI : IntegLabel := [trustedScope, tok]
    let guard : ExprD := .lit true
    let secret : ExprD := .lit false
    Cfc.CommitPoint.declassifyCommit tok true [tok] env pc pcI guard secret =
      CommitResult.committed (evalD env pc pcI (.declassifyIf tok guard secret)) [] := by
  intro tok env pc pcI guard secret
  simp [Cfc.CommitPoint.declassifyCommit, Cfc.Intent.commitOnce, Cfc.Intent.eraseOnce]

theorem forward_commit_single_use (u : String) :
    let tok : Atom := Atom.integrityTok "IntentOnceForward"
    let env : Env := fun _ => { val := false, lbl := Label.bot }
    let pc : ConfLabel := [[Atom.user u]]
    let pcI : IntegLabel := [trustedScope, tok]
    let guard : ExprD := .lit true
    let secret : ExprD := .lit false
    Cfc.CommitPoint.declassifyCommit tok true [tok] env pc pcI guard secret =
      CommitResult.committed (evalD env pc pcI (.declassifyIf tok guard secret)) [] →
    Cfc.CommitPoint.declassifyCommit tok true [] env pc pcI guard secret =
      CommitResult.failed [] := by
  intro tok env pc pcI guard secret hCommit
  have hs : ([tok] : IntentStore).Nodup := by simp
  exact Proofs.CommitPoint.declassifyCommit_single_use (tok := tok) (store := [tok]) (store' := [])
    hs env pc pcI guard secret hCommit

end GmailExample
end Proofs

end Cfc
