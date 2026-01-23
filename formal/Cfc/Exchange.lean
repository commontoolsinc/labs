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

/-- Boolean check: every atom in `need` is present in `avail`. -/
def hasAllB (need avail : List Atom) : Bool :=
  need.all (fun a => decide (a ∈ avail))

/-- Prop view of `hasAllB`. -/
def hasAll (need avail : List Atom) : Prop :=
  hasAllB need avail = true

/-- Conditional exchange step that adds an alternative to a target atom. -/
def exchangeAddAltIf (needInteg : List Atom) (target alt : Atom)
    (boundary : IntegLabel) (ℓ : Label) : Label :=
  let avail := availIntegrity ℓ boundary
  if hasAllB needInteg avail then
    { ℓ with conf := confAddAltFor target alt ℓ.conf }
  else
    ℓ

/-- Conditional exchange step that drops a singleton confidentiality requirement. -/
def exchangeDropSingletonIf (needInteg : List Atom) (a : Atom)
    (boundary : IntegLabel) (ℓ : Label) : Label :=
  let avail := availIntegrity ℓ boundary
  if hasAllB needInteg avail then
    { ℓ with conf := confDropSingleton a ℓ.conf }
  else
    ℓ

/-- Boolean check: the clause contains some `Space(s)` whose `HasRole(acting,s,"reader")` is available. -/
def clauseHasSpaceReaderB (acting : String) (avail : IntegLabel) (c : Clause) : Bool :=
  c.any (fun a =>
    match a with
    | .space s => decide (Atom.hasRole acting s "reader" ∈ avail)
    | _ => false)

/-- Space reader exchange:
If a clause contains `Space(S)` and `HasRole(acting,S,"reader")` is available as integrity,
add `User(acting)` as an alternative for that clause.

This models spec Section 3.6.3 and the `SpaceReaderAccess` exchange rule in 4.3.3.
-/
def exchangeSpaceReader (acting : String) (boundary : IntegLabel) (ℓ : Label) : Label :=
  let avail := availIntegrity ℓ boundary
  { ℓ with
    conf :=
      ℓ.conf.map (fun c =>
        if clauseHasSpaceReaderB acting avail c then
          clauseInsert (.user acting) c
        else
          c) }

/-- Boolean check: all participants have provided consent for the same `participants` list. -/
def hasAllMultiPartyConsentsB (participants : List String) (avail : IntegLabel) : Bool :=
  participants.all (fun p => decide (Atom.multiPartyConsent p participants ∈ avail))

/-- Prop view of `hasAllMultiPartyConsentsB`. -/
def hasAllMultiPartyConsents (participants : List String) (avail : IntegLabel) : Prop :=
  hasAllMultiPartyConsentsB participants avail = true

/-- Boolean check: the confidentiality label contains singleton `User(p)` clauses for every participant. -/
def hasUserClausesB (participants : List String) (C : ConfLabel) : Bool :=
  participants.all (fun p => decide (([Atom.user p] : Clause) ∈ C))

/-- Prop view of `hasUserClausesB`. -/
def hasUserClauses (participants : List String) (C : ConfLabel) : Prop :=
  hasUserClausesB participants C = true

/-- Boolean check: clause is a singleton `User(p)` clause for some `p` in `participants`. -/
def isParticipantUserClauseB (participants : List String) (c : Clause) : Bool :=
  participants.any (fun p => decide (c = [Atom.user p]))

/-- Prop view of `isParticipantUserClauseB`. -/
def isParticipantUserClause (participants : List String) (c : Clause) : Prop :=
  isParticipantUserClauseB participants c = true

/-- Remove singleton `User(p)` clauses for all `participants`. -/
def confDropParticipantUserClauses (participants : List String) (C : ConfLabel) : ConfLabel :=
  C.filter (fun c => !isParticipantUserClauseB participants c)

/-- Compute-side multi-party consent exchange:
Collapse conjunctive `User(p)` requirements into a single `MultiPartyResult(participants)` clause,
but only if all participant consents are present.

This models spec Section 3.9.6.
-/
def exchangeMultiPartyConsentCompute (participants : List String) (boundary : IntegLabel) (ℓ : Label) : Label :=
  let avail := availIntegrity ℓ boundary
  if hasUserClausesB participants ℓ.conf && hasAllMultiPartyConsentsB participants avail then
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
def exchangeMultiPartyResultView (acting : String) (participants : List String)
    (boundary : IntegLabel) (ℓ : Label) : Label :=
  let avail := availIntegrity ℓ boundary
  { ℓ with
    conf :=
      ℓ.conf.map (fun c =>
        if decide (Atom.multiPartyResult participants ∈ c) &&
            decide (acting ∈ participants) &&
            hasAllMultiPartyConsentsB participants avail then
          clauseInsert (.user acting) c
        else
          c) }

end Exchange

end Cfc
