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

How to read this file:

- Each theorem corresponds to a narrative claim in the spec's Gmail example chapter.
- We do not model Gmail data structures; we only model the *labels* that would be attached to them.
- A proof typically has the shape:
  1) unfold the label definitions,
  2) show a particular confidentiality clause is present (or has been removed),
  3) use `canAccess` / `clauseSat` to conclude access is allowed or denied.

So this file is a good place to see "end-to-end" use of:
- CNF confidentiality (`Cfc.Label`)
- access control (`Cfc.Access`)
- exchange rewrites (`Cfc.Exchange`)
- intent consumption at commit (`Cfc.CommitPoint`)
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

def pAliceWithNotes (u : String) : Principal :=
  { now := 0, atoms := [Atom.user u, emailMetadataSecret u, notesSecret u] }

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
/-
Modeling choices for 1.2:

- The OAuth token is labeled with two clauses:
    [[User u], [GoogleAuth u]]
  meaning: to see the token you need BOTH "User u" and "GoogleAuth u" authority.

- The Gmail read response is labeled:
    [[User u], [EmailMetadataSecret u]]
  meaning: the response reveals user data and email metadata.

- If we naïvely join them, the result contains the `[GoogleAuth u]` clause, which would
  incorrectly taint the response with token secrecy.

The spec's fix is an authority-only exchange: at a trusted boundary, if we have integrity evidence
that the request was authorized, we drop the `[GoogleAuth u]` clause from the token label.
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
/-
This section exercises basic label join:

If a query value is secret (here: `notesSecret u`), and the response depends on the query,
then joining the response label with the query label makes the result inaccessible to a principal
who lacks the query authority.

This is exactly the intended "query secrecy taints response" behavior.
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

theorem search_query_allows_with_notesSecret (u : String) :
    let ℓResp := gmailReadResponseLabel u
    let ℓQuery : Label := { conf := [[notesSecret u]], integ := [] }
    canAccess (pAliceWithNotes u) (ℓResp + ℓQuery) := by
  classical
  intro ℓResp ℓQuery
  -- All required confidentiality atoms are present in the principal.
  simp [ℓResp, ℓQuery, gmailReadResponseLabel, pAliceWithNotes, notesSecret,
    emailMetadataSecret, canAccess, canAccessConf, clauseSat, Principal.satisfies]

/-!
Spec 1.4.6 (write): the commit point consumes an `IntentOnce` token only on commit,
and the token is single-use.
-/
/-
This section exercises the commit-point model:

- We represent the user's explicit approval as an intent token `tok`.
- `CommitPoint.declassifyCommit tok committed store ...` consumes the token iff `committed = true`.

We prove three behaviors:
1) If committed = false, store is unchanged (no-consume-on-failure).
2) If committed = true, the token is consumed.
3) After a successful commit, a second commit with the resulting store fails (single-use).

These are the minimal logical core of safety invariant 4.
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
