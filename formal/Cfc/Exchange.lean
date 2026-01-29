import Std

import Cfc.Label

namespace Cfc

/-!
Exchange / label rewrite utilities.

The core label algebra (`Label.join`) is monotone: confidentiality accumulates by conjunction.
At trusted boundaries, policies may *rewrite* confidentiality in an integrity-guarded way.

This file provides a small, proof-friendly subset of the spec's exchange mechanisms.

Big picture:

- Inside a computation, labels "flow forward" and typically only get more restrictive.
  (In our model, confidentiality join is CNF conjunction, implemented as list append.)

- The spec allows *trusted* runtime/policy code to rewrite labels at boundaries:
  for example, if there is integrity evidence that "acting user has role X", then we can
  add `User(acting)` as an alternative to a `Space(S)` requirement.

These rewrites are the mechanism by which we encode policy: it is not handler code choosing
to drop confidentiality; it is the runtime verifying integrity evidence and applying a
schema/policy-specified rewrite.

Implementation approach:

- We implement runtime checks as `Bool` functions (computable).
- We also define corresponding `Prop` views like `hasAll ... := hasAllB ... = true`.
  This is a common pattern in Lean when you want both (1) executable checks and
  (2) proof-friendly statements.
-/

namespace Exchange

/-
Integrity available at a trusted boundary:

The runtime can use both:
- integrity already attached to the value, and
- integrity facts minted by the boundary itself (e.g. "this request was authorized").

We model that as list append.
-/
def availIntegrity (ℓ : Label) (boundary : IntegLabel) : IntegLabel :=
  ℓ.integ ++ boundary

/-
Insert an alternative into a clause.

Clauses are lists, so "insert" is:
- if the atom is already present, do nothing (idempotent)
- otherwise add it at the head

This is used by many exchange rules that say "add User(acting) as an alternative".
-/
def clauseInsert (a : Atom) (c : Clause) : Clause :=
  if a ∈ c then c else a :: c

/-
Add `alt` as an alternative in every clause containing `target`.

This is a CNF-local rewrite: it does not remove clauses, it only widens the OR within a clause.

In policy terms: "if target atom appears as a requirement, also accept alt as satisfying it".
-/
def confAddAltFor (target alt : Atom) (C : ConfLabel) : ConfLabel :=
  C.map (fun c => if target ∈ c then clauseInsert alt c else c)

/-
Drop every singleton clause `[a]`.

This implements the common policy pattern "authority-only secrecy":
the CNF may contain a clause that says "you must have authority A" (a singleton clause),
and certain trusted evidence can drop that requirement.

We represent the rule as filtering out `[a]` clauses.
-/
def confDropSingleton (a : Atom) (C : ConfLabel) : ConfLabel :=
  C.filter (fun c => decide (c ≠ [a]))

/-
Boolean check: every atom in `need` is present in `avail`.

We use `List.all` and `decide (a ∈ avail)` to compute the subset check.
-/
def hasAllB (need avail : List Atom) : Bool :=
  need.all (fun a => decide (a ∈ avail))

/-
Prop view of `hasAllB`:

`hasAll need avail` is the statement "the boolean check returns true".

Having both forms is useful:
- the `Bool` form matches a runtime implementation / executable semantics
- the `Prop` form is convenient for writing theorems
-/
def hasAll (need avail : List Atom) : Prop :=
  hasAllB need avail = true

/-
Conditional exchange step that adds an alternative to a target atom.

Informally:
  if (needInteg ⊆ (ℓ.integ ++ boundary)) then
    rewrite ℓ.conf by adding `alt` next to `target`
  else
    do nothing

This is a tiny generic "guarded rewrite" primitive used by multiple policies.
-/
def exchangeAddAltIf (needInteg : List Atom) (target alt : Atom)
    (boundary : IntegLabel) (ℓ : Label) : Label :=
  let avail := availIntegrity ℓ boundary
  if hasAllB needInteg avail then
    { ℓ with conf := confAddAltFor target alt ℓ.conf }
  else
    ℓ

/-
Conditional exchange step that drops a singleton confidentiality requirement.

Same guard pattern as `exchangeAddAltIf`, but the rewrite is `confDropSingleton`.

This is used for "authority-only clause drop" style policies.
-/
def exchangeDropSingletonIf (needInteg : List Atom) (a : Atom)
    (boundary : IntegLabel) (ℓ : Label) : Label :=
  let avail := availIntegrity ℓ boundary
  if hasAllB needInteg avail then
    { ℓ with conf := confDropSingleton a ℓ.conf }
  else
    ℓ

/-- Boolean check: the clause contains some `Space(s)` whose `HasRole(acting,s,"reader")` is available. -/
def hasSpaceReaderRoleB (acting : String) (space : String) (avail : IntegLabel) : Bool :=
  decide (Atom.hasRole acting space "reader" ∈ avail) ||
  decide (Atom.hasRole acting space "writer" ∈ avail) ||
  decide (Atom.hasRole acting space "owner" ∈ avail)

/-- Boolean check: the clause contains some `Space(s)` whose reader-or-higher role is available. -/
def clauseHasSpaceReaderB (acting : String) (avail : IntegLabel) (c : Clause) : Bool :=
  c.any (fun a =>
    match a with
    | .space s => hasSpaceReaderRoleB acting s avail
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

/-
Multi-party consent rules (spec 3.9):

The spec models a "multi-party result" (e.g. a group conversation summary) where *all*
participants must consent before the system can treat the result as jointly shareable.

We represent the baseline confidentiality requirement "all participants can read" as a CNF
containing singleton clauses:
  [[User(p1)], [User(p2)], ..., [User(pn)]]
Because CNF is AND-of-clauses, this means you must satisfy every `User(pi)` clause:
only a principal who has all those users (usually impossible) could read.

At a trusted boundary, if we have integrity evidence that each participant consented
(`MultiPartyConsent pi participants`), we can collapse those many singleton requirements into a
single clause `MultiPartyResult participants`. That clause can then be "opened up" on the view side
to an acting participant.

This is a policy rewrite: it does not come from untrusted handler code.
-/

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
