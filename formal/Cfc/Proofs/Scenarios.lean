import Std

import Cfc.Access
import Cfc.Exchange
import Cfc.Proofs.Exchange

namespace Cfc

namespace Proofs
namespace Scenarios

open Cfc
open Cfc.Exchange

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
  simp [pUser, ℓSpace, Exchange.exchangeSpaceReader, Exchange.availIntegrity, Exchange.clauseInsert,
    canAccess, canAccessConf, clauseSat, Principal.satisfies]

/-- Without the required role integrity, exchange does not grant access. -/
theorem space_reader_exchange_denies_without_role (acting space : String) :
    ¬ canAccess (pUser acting)
      (Exchange.exchangeSpaceReader acting ([] : IntegLabel) (ℓSpace space)) := by
  classical
  -- No role fact means the clause stays `Space(space)`, which `pUser` cannot satisfy.
  simp [pUser, ℓSpace, Exchange.exchangeSpaceReader, Exchange.availIntegrity,
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
  have hMem : ([Atom.space B] : Clause) ∈
      (Exchange.exchangeSpaceReader acting [Atom.hasRole acting A "reader"] ℓ).conf := by
    simp [ℓ, ℓSpace, Exchange.exchangeSpaceReader, Exchange.availIntegrity, Exchange.clauseInsert,
      Label.joinIntegrity, hAB]
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
    canAccess, canAccessConf, clauseSat, Principal.satisfies, Label.joinIntegrity]

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

/-- With multi-party consent, the conjunctive user clauses collapse to a `MultiPartyResult` clause. -/
theorem multiparty_consent_compute_collapses (participants : List String) :
    let boundary : IntegLabel := participants.map (fun p => Atom.multiPartyConsent p participants)
    let ℓ := { conf := participants.map (fun p => ([Atom.user p] : Clause)), integ := [] }
    (Exchange.exchangeMultiPartyConsentCompute participants boundary ℓ).conf =
      [[Atom.multiPartyResult participants]] := by
  classical
  intro boundary ℓ
  have hUser : Exchange.hasUserClauses participants ℓ.conf := by
    intro p hp
    -- By construction, each participant contributes a `User(p)` singleton clause.
    have hIn : ([Atom.user p] : Clause) ∈ participants.map (fun p => ([Atom.user p] : Clause)) :=
      List.mem_map.2 ⟨p, hp, rfl⟩
    simpa [ℓ] using hIn
  have hConsents : Exchange.hasAllMultiPartyConsents participants boundary := by
    intro p hp
    -- Boundary integrity includes all `MultiPartyConsent` facts.
    have hIn : Atom.multiPartyConsent p participants ∈
        participants.map (fun p => Atom.multiPartyConsent p participants) :=
      List.mem_map.2 ⟨p, hp, rfl⟩
    simpa [boundary] using hIn
  -- The filter removes all participant `User` clauses; only the `MultiPartyResult` remains.
  have hDrop : Exchange.confDropParticipantUserClauses participants ℓ.conf = [] := by
    apply (List.eq_nil_iff_forall_not_mem).2
    intro c hc
    have hc' := (List.mem_filter.1 hc)
    have hcMem : c ∈ ℓ.conf := hc'.1
    have hcKeep : decide (¬ Exchange.isParticipantUserClause participants c) = true := hc'.2
    rcases List.mem_map.1 (by simpa [ℓ] using hcMem) with ⟨p, hp, hpEq⟩
    have hIs : Exchange.isParticipantUserClause participants c := by
      refine ⟨p, hp, ?_⟩
      simp [hpEq]
    have hNot : ¬ Exchange.isParticipantUserClause participants c :=
      (Eq.mp (decide_eq_true_eq (p := ¬ Exchange.isParticipantUserClause participants c)) hcKeep)
    exact hNot hIs
  have hAll : Exchange.hasAllMultiPartyConsents participants (ℓ.integ ++ boundary) := by
    simpa [ℓ] using hConsents
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
  have hConsents : Exchange.hasAllMultiPartyConsents participants boundary := by
    intro p hp
    have hIn : Atom.multiPartyConsent p participants ∈
        participants.map (fun p => Atom.multiPartyConsent p participants) :=
      List.mem_map.2 ⟨p, hp, rfl⟩
    simpa [boundary] using hIn
  simp [pUser, ℓ, Exchange.exchangeMultiPartyResultView, Exchange.availIntegrity,
    Exchange.clauseInsert, hMem, hConsents,
    canAccess, canAccessConf, clauseSat, Principal.satisfies]

/-- Authority-only secrecy can be dropped only when integrity guards are present. -/
theorem authority_only_drop_requires_guards (acting : String) :
    let googleAuth : Atom := Atom.policy "GoogleAuth" acting "h"
    let need : IntegLabel := [Atom.integrityTok "AuthorizedRequest", Atom.integrityTok "NetworkProvenance"]
    let ℓ : Label := { conf := [[Atom.user acting], [googleAuth]], integ := [] }
    ¬ canAccess (pUser acting) (Exchange.exchangeDropSingletonIf need googleAuth ([] : IntegLabel) ℓ) := by
  classical
  intro googleAuth need ℓ
  have hNo : ¬ Exchange.hasAll need ℓ.integ := by
    intro hAll
    have hReq : Atom.integrityTok "AuthorizedRequest" ∈ need := by
      simp [need]
    have : Atom.integrityTok "AuthorizedRequest" ∈ ℓ.integ := hAll _ hReq
    simp [ℓ] at this
  have hEq : Exchange.exchangeDropSingletonIf need googleAuth ([] : IntegLabel) ℓ = ℓ := by
    simp [Exchange.exchangeDropSingletonIf, Exchange.availIntegrity, hNo]
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
  have hNeed : Exchange.hasAll need boundary := by
    intro a ha
    simpa [boundary] using ha
  simp [Exchange.exchangeDropSingletonIf, Exchange.availIntegrity, hNeed,
    Exchange.confDropSingleton,
    pUser, ℓ, Principal.satisfies,
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
  have hNeed : Exchange.hasAll need boundary := by
    intro a ha
    simpa [boundary] using ha
  simp [Exchange.exchangeAddAltIf, Exchange.availIntegrity, hNeed,
    Exchange.confAddAltFor, Exchange.clauseInsert,
    ℓ, Principal.satisfies,
    canAccess, canAccessConf, clauseSat]

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
  have hNeed : Exchange.hasAll need boundary := by
    intro a ha
    simpa [boundary] using ha
  simp [Exchange.exchangeDropSingletonIf, Exchange.availIntegrity, hNeed,
    Exchange.confDropSingleton,
    p, ℓ, Principal.satisfies,
    canAccess, canAccessConf, clauseSat]

end Scenarios
end Proofs

end Cfc
