import Std

import Cfc.Label

namespace Cfc

/-!
Exchange / label rewrite utilities.

The core label algebra (`Label.join`) is monotone: confidentiality accumulates by conjunction.
At trusted boundaries, policies may *rewrite* confidentiality in an integrity-guarded way.

This file provides a small, proof-friendly subset of the spec's exchange mechanisms.
-/

namespace Exchange

/-- Integrity available at a trusted boundary: value integrity plus boundary-minted facts. -/
def availIntegrity (ℓ : Label) (boundary : IntegLabel) : IntegLabel :=
  ℓ.integ ++ boundary

/-- Insert an alternative into a clause (idempotent). -/
def clauseInsert (a : Atom) (c : Clause) : Clause :=
  if a ∈ c then c else a :: c

/-- Add `alt` as an alternative in every clause containing `target`. -/
def confAddAltFor (target alt : Atom) (C : ConfLabel) : ConfLabel :=
  C.map (fun c => if target ∈ c then clauseInsert alt c else c)

/-- Drop every singleton clause `[a]`. Used for rules like authority-only untainting. -/
def confDropSingleton (a : Atom) (C : ConfLabel) : ConfLabel :=
  C.filter (fun c => decide (c ≠ [a]))

/-- `hasAll need avail` means every atom in `need` is present in `avail`. -/
def hasAll (need avail : List Atom) : Prop :=
  ∀ a, a ∈ need → a ∈ avail

/-- Conditional exchange step that adds an alternative to a target atom. -/
noncomputable def exchangeAddAltIf (needInteg : List Atom) (target alt : Atom)
    (boundary : IntegLabel) (ℓ : Label) : Label := by
  classical
  let avail := availIntegrity ℓ boundary
  exact if h : hasAll needInteg avail then
    { ℓ with conf := confAddAltFor target alt ℓ.conf }
  else
    ℓ

/-- Conditional exchange step that drops a singleton confidentiality requirement. -/
noncomputable def exchangeDropSingletonIf (needInteg : List Atom) (a : Atom)
    (boundary : IntegLabel) (ℓ : Label) : Label := by
  classical
  let avail := availIntegrity ℓ boundary
  exact if h : hasAll needInteg avail then
    { ℓ with conf := confDropSingleton a ℓ.conf }
  else
    ℓ

/-- Space reader exchange:
If a clause contains `Space(S)` and `HasRole(acting,S,"reader")` is available as integrity,
add `User(acting)` as an alternative for that clause.

This models spec Section 3.6.3 and the `SpaceReaderAccess` exchange rule in 4.3.3.
-/
noncomputable def exchangeSpaceReader (acting : String) (boundary : IntegLabel) (ℓ : Label) : Label := by
  classical
  let avail := availIntegrity ℓ boundary
  let conf' := ℓ.conf.map (fun c =>
    if h : (∃ s, Atom.space s ∈ c ∧ Atom.hasRole acting s "reader" ∈ avail) then
      clauseInsert (.user acting) c
    else
      c)
  exact { ℓ with conf := conf' }

/-- All participants have provided consents for the same `participants` set. -/
def hasAllMultiPartyConsents (participants : List String) (avail : IntegLabel) : Prop :=
  ∀ p, p ∈ participants → Atom.multiPartyConsent p participants ∈ avail

/-- The confidentiality label contains singleton `User(p)` clauses for every participant. -/
def hasUserClauses (participants : List String) (C : ConfLabel) : Prop :=
  ∀ p, p ∈ participants → ([Atom.user p] : Clause) ∈ C

/-- Clause is a singleton `User(p)` clause for some `p` in `participants`. -/
def isParticipantUserClause (participants : List String) (c : Clause) : Prop :=
  ∃ p, p ∈ participants ∧ c = [Atom.user p]

/-- Remove singleton `User(p)` clauses for all `participants`. -/
noncomputable def confDropParticipantUserClauses (participants : List String) (C : ConfLabel) : ConfLabel := by
  classical
  exact C.filter (fun c => decide (¬ isParticipantUserClause participants c))

/-- Compute-side multi-party consent exchange:
Collapse conjunctive `User(p)` requirements into a single `MultiPartyResult(participants)` clause,
but only if all participant consents are present.

This models spec Section 3.9.6.
-/
noncomputable def exchangeMultiPartyConsentCompute (participants : List String) (boundary : IntegLabel) (ℓ : Label) : Label := by
  classical
  let avail := availIntegrity ℓ boundary
  exact if h : hasUserClauses participants ℓ.conf ∧ hasAllMultiPartyConsents participants avail then
    { ℓ with
      conf := [[Atom.multiPartyResult participants]] ++
        confDropParticipantUserClauses participants ℓ.conf }
  else
    ℓ

/-- View-side exchange for a multi-party result:
If the acting user is a participant and all consents are present,
add `User(acting)` as an alternative for the `MultiPartyResult(participants)` clause.

This models spec Section 3.9.3.
-/
noncomputable def exchangeMultiPartyResultView (acting : String) (participants : List String)
    (boundary : IntegLabel) (ℓ : Label) : Label := by
  classical
  let avail := availIntegrity ℓ boundary
  let conf' := ℓ.conf.map (fun c =>
    if h : (Atom.multiPartyResult participants ∈ c ∧
            acting ∈ participants ∧
            hasAllMultiPartyConsents participants avail) then
      clauseInsert (.user acting) c
    else
      c)
  exact { ℓ with conf := conf' }

end Exchange

end Cfc
