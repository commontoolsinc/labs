import Std

import Cfc.Access
import Cfc.Exchange
import Cfc.Link
import Cfc.Proofs.Exchange
import Cfc.Proofs.Link

namespace Cfc

namespace Proofs
namespace Scenarios

open Cfc
open Cfc.Exchange

/-
Scenario-style regression tests for the exchange + access-control model.

Unlike the core proof modules (non-interference, robust declassification, etc.),
this file is a collection of small "worked examples" that mirror concrete spec stories:

- Space reader access (role-based exchange)
- Conjunctive link confidentiality
- Multi-party consent collapse and view-side opening
- Authority-only secrecy drop (guarded by integrity)
- Expiration clauses and guarded retention relaxation

These theorems are valuable for two reasons:
1) They act as unit tests: if a refactor breaks one of these, it likely broke intended behavior.
2) They serve as documentation: each proof shows how to use the core definitions in practice.

Most proofs are `simp`-heavy: they unfold definitions and let Lean discharge routine logic
about list membership and CNF satisfaction.
-/

/- -------------------------------------------------------------------------- -/
/- Space Reader Access (spec 3.6.3 / 4.3.3)                                   -/
/- -------------------------------------------------------------------------- -/

/-- A principal representing an acting user context. -/
def pUser (u : String) : Principal :=
  { now := 0
    atoms := [Atom.user u] }

/-- Data classified to a space. -/
def ℓSpace (s : String) : Label :=
  { conf := [[Atom.space s]]
    integ := [] }

/-- Data classified to a single user. -/
def ℓUser (u : String) : Label :=
  { conf := [[Atom.user u]]
    integ := [] }

/-- Space membership is required unless role-based exchange fires. -/
theorem space_reader_exchange_allows (acting space : String) :
    canAccess (pUser acting)
      (Exchange.exchangeSpaceReader acting [Atom.hasRole acting space "reader"] (ℓSpace space)) := by
  classical
  -- Unfold to a single clause and witness `User(acting)`.
  simp [pUser, ℓSpace, Exchange.exchangeSpaceReader, Exchange.availIntegrity,
    Exchange.clauseHasSpaceReaderB, Exchange.hasSpaceReaderRoleB, Exchange.clauseInsert,
    canAccess, canAccessConf, clauseSat, Principal.satisfies]

/-- Role hierarchy: `writer` implies `reader` for purposes of `SpaceReaderAccess`. -/
theorem space_writer_exchange_allows (acting space : String) :
    canAccess (pUser acting)
      (Exchange.exchangeSpaceReader acting [Atom.hasRole acting space "writer"] (ℓSpace space)) := by
  classical
  simp [pUser, ℓSpace, Exchange.exchangeSpaceReader, Exchange.availIntegrity,
    Exchange.clauseHasSpaceReaderB, Exchange.hasSpaceReaderRoleB, Exchange.clauseInsert,
    canAccess, canAccessConf, clauseSat, Principal.satisfies]

/-- Role hierarchy: `owner` implies `reader` for purposes of `SpaceReaderAccess`. -/
theorem space_owner_exchange_allows (acting space : String) :
    canAccess (pUser acting)
      (Exchange.exchangeSpaceReader acting [Atom.hasRole acting space "owner"] (ℓSpace space)) := by
  classical
  simp [pUser, ℓSpace, Exchange.exchangeSpaceReader, Exchange.availIntegrity,
    Exchange.clauseHasSpaceReaderB, Exchange.hasSpaceReaderRoleB, Exchange.clauseInsert,
    canAccess, canAccessConf, clauseSat, Principal.satisfies]

/-- Without the required role integrity, exchange does not grant access. -/
theorem space_reader_exchange_denies_without_role (acting space : String) :
    ¬ canAccess (pUser acting)
      (Exchange.exchangeSpaceReader acting ([] : IntegLabel) (ℓSpace space)) := by
  classical
  -- No role fact means the clause stays `Space(space)`, which `pUser` cannot satisfy.
  simp [pUser, ℓSpace, Exchange.exchangeSpaceReader, Exchange.availIntegrity,
    Exchange.clauseHasSpaceReaderB, Exchange.hasSpaceReaderRoleB,
    canAccess, canAccessConf, clauseSat, Principal.satisfies]

/-- Cross-space links are conjunctive: access requires roles in both spaces. -/
theorem link_requires_both_spaces (acting A B : String) :
    A ≠ B →
    let ℓ := (ℓSpace A + ℓSpace B)
    ¬ canAccess (pUser acting)
        (Exchange.exchangeSpaceReader acting [Atom.hasRole acting A "reader"] ℓ) := by
  classical
  intro hAB ℓ
  unfold canAccess
  intro hAcc
  have hBA : B ≠ A := by
    intro h
    exact hAB h.symm
  have hMem : ([Atom.space B] : Clause) ∈
      (Exchange.exchangeSpaceReader acting [Atom.hasRole acting A "reader"] ℓ).conf := by
    simp [ℓ, ℓSpace, Exchange.exchangeSpaceReader, Exchange.availIntegrity, Exchange.clauseInsert,
      Exchange.clauseHasSpaceReaderB, Exchange.hasSpaceReaderRoleB, Label.joinIntegrity, hBA]
  have hClause : clauseSat (pUser acting) [Atom.space B] := hAcc [Atom.space B] hMem
  rcases hClause with ⟨a, ha, hs⟩
  have : a = Atom.space B := by
    simpa using ha
  subst this
  simp [pUser, Principal.satisfies] at hs

/-- With reader roles in both spaces, link access succeeds. -/
theorem link_allows_with_roles (acting A B : String) :
    let ℓ := (ℓSpace A + ℓSpace B)
    canAccess (pUser acting)
        (Exchange.exchangeSpaceReader acting
          [Atom.hasRole acting A "reader", Atom.hasRole acting B "reader"]
          ℓ) := by
  classical
  intro ℓ
  simp [ℓ, pUser, ℓSpace, Exchange.exchangeSpaceReader, Exchange.availIntegrity, Exchange.clauseInsert,
    Exchange.clauseHasSpaceReaderB, Exchange.hasSpaceReaderRoleB,
    canAccess, canAccessConf, clauseSat, Principal.satisfies, Label.joinIntegrity]

/-- Link dereference adds endorsement integrity (spec 3.7.2), unlike integrity join. -/
theorem link_deref_adds_integrity_example :
    let link : Label := { conf := [[Atom.space "A"]], integ := [Atom.integrityTok "LinkedByAlice"] }
    let target : Label := { conf := [[Atom.space "B"]], integ := [Atom.integrityTok "AuthoredByBob"] }
    (link + target).integ = [] ∧
      (Cfc.Link.deref link target).integ =
        [Atom.integrityTok "AuthoredByBob", Atom.integrityTok "LinkedByAlice"] := by
  classical
  intro link target
  simp [link, target, Cfc.Link.deref, Label.endorseIntegrity, Label.joinIntegrity]

/-
The next group of theorems corresponds to the multi-party consent story (spec 3.9).
-/

/-- Default CNF join yields conjunctive multi-user confidentiality: a single user cannot access. -/
theorem multiparty_default_join_denies_single (alice bob carol : String) :
    bob ≠ alice →
    let ℓ := (ℓUser alice + ℓUser bob + ℓUser carol)
    ¬ canAccess (pUser alice) ℓ := by
  classical
  intro hBob ℓ
  unfold canAccess
  intro hAcc
  have hMem : ([Atom.user bob] : Clause) ∈ ℓ.conf := by
    simp [ℓ, ℓUser]
  have hClause : clauseSat (pUser alice) [Atom.user bob] := hAcc [Atom.user bob] hMem
  rcases hClause with ⟨a, ha, hs⟩
  have : a = Atom.user bob := by
    simpa using ha
  subst this
  simp [pUser, Principal.satisfies, hBob] at hs

/-
Now we exercise the two multi-party exchange rules:
- compute-side collapse (`exchangeMultiPartyConsentCompute`)
- view-side opening (`exchangeMultiPartyResultView`)
-/

/-- With multi-party consent, the conjunctive user clauses collapse to a `MultiPartyResult` clause. -/
theorem multiparty_consent_compute_collapses (participants : List String) :
    let boundary : IntegLabel := participants.map (fun p => Atom.multiPartyConsent p participants)
    let ℓ := { conf := participants.map (fun p => ([Atom.user p] : Clause)), integ := [] }
    (Exchange.exchangeMultiPartyConsentCompute participants boundary ℓ).conf =
      [[Atom.multiPartyResult participants]] := by
  classical
  intro boundary ℓ
  have hUser : Exchange.hasUserClausesB participants ℓ.conf = true := by
    -- `hasUserClausesB` is a `List.all` check over `participants`.
    simp [Exchange.hasUserClausesB, List.all_eq_true]
    intro p hp
    have hIn : ([Atom.user p] : Clause) ∈ participants.map (fun p => ([Atom.user p] : Clause)) :=
      List.mem_map.2 ⟨p, hp, rfl⟩
    simpa [ℓ] using hIn
  have hConsents : Exchange.hasAllMultiPartyConsentsB participants boundary = true := by
    simp [Exchange.hasAllMultiPartyConsentsB, List.all_eq_true]
    intro p hp
    have hIn : Atom.multiPartyConsent p participants ∈
        participants.map (fun p => Atom.multiPartyConsent p participants) :=
      List.mem_map.2 ⟨p, hp, rfl⟩
    simpa [boundary] using hIn
  have hDrop : Exchange.confDropParticipantUserClauses participants ℓ.conf = [] := by
    apply (List.eq_nil_iff_forall_not_mem).2
    intro c hc
    have hc' := (List.mem_filter.1 hc)
    have hcMem : c ∈ ℓ.conf := hc'.1
    have hcKeep : (!Exchange.isParticipantUserClauseB participants c) = true := hc'.2
    rcases List.mem_map.1 (by simpa [ℓ] using hcMem) with ⟨p, hp, rfl⟩
    have hIs : Exchange.isParticipantUserClauseB participants [Atom.user p] = true := by
      apply (List.any_eq_true).2
      refine ⟨p, hp, ?_⟩
      simp
    have hIs' : Exchange.isParticipantUserClauseB participants [Atom.user p] = false :=
      Eq.mp (Bool.not_eq_true' _) hcKeep
    -- Contradiction: a clause cannot be both a participant `User` clause and not such a clause.
    rw [hIs] at hIs'
    cases hIs'
  have hAll : Exchange.hasAllMultiPartyConsentsB participants (ℓ.integ ++ boundary) = true := by
    -- `ℓ.integ = []`, so this is the same check as `hConsents`.
    simpa [Exchange.availIntegrity, ℓ] using hConsents
  simp [Exchange.exchangeMultiPartyConsentCompute, Exchange.availIntegrity, hUser, hAll, hDrop]

/-- Participants can view a multi-party result after view-side exchange. -/
theorem multiparty_result_view_allows_participant (acting : String) (participants : List String)
    (hMem : acting ∈ participants) :
    let boundary : IntegLabel := participants.map (fun p => Atom.multiPartyConsent p participants)
    let ℓ : Label := { conf := [[Atom.multiPartyResult participants]], integ := [] }
    canAccess (pUser acting)
      (Exchange.exchangeMultiPartyResultView acting participants boundary ℓ) := by
  classical
  intro boundary ℓ
  have hConsents : Exchange.hasAllMultiPartyConsentsB participants boundary = true := by
    simp [Exchange.hasAllMultiPartyConsentsB, boundary, List.all_eq_true]
  simp [pUser, ℓ, Exchange.exchangeMultiPartyResultView, Exchange.availIntegrity,
    Exchange.clauseInsert, hMem, hConsents,
    canAccess, canAccessConf, clauseSat, Principal.satisfies]

/-
Authority-only secrecy: an extra singleton clause can be dropped only when integrity guards are present.

This mirrors the "GoogleAuth token" story used later in the Gmail example.
-/

/-- Authority-only secrecy can be dropped only when integrity guards are present. -/
theorem authority_only_drop_requires_guards (acting : String) :
    let googleAuth : Atom := Atom.policy "GoogleAuth" acting "h"
    let need : IntegLabel := [Atom.integrityTok "AuthorizedRequest", Atom.integrityTok "NetworkProvenance"]
    let ℓ : Label := { conf := [[Atom.user acting], [googleAuth]], integ := [] }
    ¬ canAccess (pUser acting) (Exchange.exchangeDropSingletonIf need googleAuth ([] : IntegLabel) ℓ) := by
  classical
  intro googleAuth need ℓ
  have hEq : Exchange.exchangeDropSingletonIf need googleAuth ([] : IntegLabel) ℓ = ℓ := by
    simp [Exchange.exchangeDropSingletonIf, Exchange.hasAllB, Exchange.availIntegrity, ℓ, need]
  unfold canAccess
  intro hAcc
  have hMem : ([googleAuth] : Clause) ∈
      (Exchange.exchangeDropSingletonIf need googleAuth ([] : IntegLabel) ℓ).conf := by
    simp [hEq, ℓ]
  have hClause : clauseSat (pUser acting) [googleAuth] := hAcc [googleAuth] hMem
  rcases hClause with ⟨a, ha, hs⟩
  have : a = googleAuth := by
    simpa using ha
  subst this
  simp [pUser, Principal.satisfies] at hs

/-- With the guards, the authority-only clause is removed and the response becomes user-readable. -/
theorem authority_only_drop_allows_with_guards (acting : String) :
    let googleAuth : Atom := Atom.policy "GoogleAuth" acting "h"
    let need : IntegLabel := [Atom.integrityTok "AuthorizedRequest", Atom.integrityTok "NetworkProvenance"]
    let boundary : IntegLabel := need
    let ℓ : Label := { conf := [[Atom.user acting], [googleAuth]], integ := [] }
    canAccess (pUser acting) (Exchange.exchangeDropSingletonIf need googleAuth boundary ℓ) := by
  classical
  intro googleAuth need boundary ℓ
  simp [Exchange.exchangeDropSingletonIf, Exchange.hasAllB, Exchange.availIntegrity,
    Exchange.confDropSingleton, pUser, ℓ, need, boundary, Principal.satisfies,
    canAccess, canAccessConf, clauseSat]

/-- `GoogleAuth`-style exchange can add an alternative principal to a policy clause. -/
theorem googleauth_adds_userresource_alternative (acting : String) :
    let googleAuth : Atom := Atom.policy "GoogleAuth" acting "h"
    let userRes : Atom := Atom.other ("UserResource:" ++ acting)
    let need : IntegLabel := [Atom.integrityTok "AuthorizedRequest"]
    let boundary : IntegLabel := need
    let ℓ : Label := { conf := [[Atom.user acting], [googleAuth]], integ := [] }
    canAccess { now := 0, atoms := [Atom.user acting, userRes] }
      (Exchange.exchangeAddAltIf need googleAuth userRes boundary ℓ) := by
  classical
  intro googleAuth userRes need boundary ℓ
  simp [Exchange.exchangeAddAltIf, Exchange.hasAllB, Exchange.availIntegrity,
    Exchange.confAddAltFor, Exchange.clauseInsert,
    ℓ, need, boundary, Principal.satisfies,
    canAccess, canAccessConf, clauseSat]

/-
Expiration and retention relaxation:

`Atom.expires t` is a special atom satisfied by time comparison (`p.now ≤ t`).
This gives us an easy way to model time-based access restrictions.

We show both:
- the basic "expired => no access" fact, and
- that policies can explicitly drop an expiration clause when integrity guards allow it.
-/

/-- Expiration is a confidentiality clause: once expired, access fails. -/
theorem expires_clause_denies_after_deadline (u : String) (t : Nat) :
    let p : Principal := { now := t + 1, atoms := [Atom.user u] }
    let ℓ : Label := { conf := [[Atom.user u], [Atom.expires t]], integ := [] }
    ¬ canAccess p ℓ := by
  classical
  intro p ℓ
  unfold canAccess
  intro hAcc
  have hMem : ([Atom.expires t] : Clause) ∈ ℓ.conf := by
    simp [ℓ]
  have hClause : clauseSat p [Atom.expires t] := hAcc [Atom.expires t] hMem
  rcases hClause with ⟨a, ha, hs⟩
  have : a = Atom.expires t := by
    simpa using ha
  subst this
  -- `p.now ≤ t` is false when `p.now = t + 1`.
  exact (Nat.not_succ_le_self t) (by simpa [p, Principal.satisfies] using hs)

/-- Policies may drop an `Expires(t)` clause when explicitly guarded (retention relaxation). -/
theorem expires_clause_can_be_dropped_with_guard (u : String) (t : Nat) :
    let p : Principal := { now := t + 1, atoms := [Atom.user u] }
    let ℓ : Label := { conf := [[Atom.user u], [Atom.expires t]], integ := [] }
    let need : IntegLabel := [Atom.integrityTok "RetainOk"]
    let boundary : IntegLabel := need
    canAccess p (Exchange.exchangeDropSingletonIf need (Atom.expires t) boundary ℓ) := by
  classical
  intro p ℓ need boundary
  simp [Exchange.exchangeDropSingletonIf, Exchange.hasAllB, Exchange.availIntegrity,
    Exchange.confDropSingleton,
    p, ℓ, need, boundary, Principal.satisfies,
    canAccess, canAccessConf, clauseSat]

end Scenarios
end Proofs

end Cfc
