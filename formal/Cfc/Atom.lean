import Std

namespace Cfc

/-!
Atoms are the basic "principals/facts" that appear in confidentiality clauses and integrity sets.

This is intentionally a tiny core model; the full CFC spec has many atom variants.

How to read this in the rest of the repo:
- In a confidentiality label (CNF), atoms are the "names" that principals can satisfy.
  Example: the clause `[User("Alice"), Space("S")]` means Alice OR anyone in space S can read.
- In an integrity label (a conjunction of atoms), atoms are "claims/evidence" about where the
  data came from and what invariants hold.

Most atoms are treated uniformly by `Principal.satisfies`: a principal satisfies an atom iff the
atom is in its `atoms` list. The exception is `expires`, which is time-based.
-/

inductive Atom where
  | user (did : String)
  | space (id : String)
  | policy (name : String) (subject : String) (hash : String)
  | hasRole (principal : String) (space : String) (role : String)
  | multiPartyResult (participants : List String)
  | multiPartyConsent (participant : String) (participants : List String)
  | integrityTok (name : String)
  /-
  Capability principals (spec 13.2 "Capability").

  These are confidentiality principals that represent *where* data may flow.
  The most important example is network egress:
  an output labeled with `capability "network" "gmail.googleapis.com"` is intended to be
  sendable only to that host (subject to policy exchange rules at the trusted boundary).

  We keep the structure intentionally small: just a `kind` string and a `resource` string.
  -/
  | capability (kind : String) (resource : String)
  /-
  Transformation provenance (spec 8.7 and the default case in 8.9.2).

  When a handler *computes* a new value from inputs (as opposed to passing through a reference or
  proving an exact copy), the runtime should not preserve the inputs' integrity claims verbatim.
  Instead, it mints new integrity evidence that records what code ran and what it depended on.

  The full spec's `TransformedBy` atom carries structured details:
  - a code hash
  - references to inputs
  - (optionally) the integrity of each input

  Our Lean model keeps just enough structure to write useful safety lemmas:
  - `codeHash : String` identifies the transformation code
  - `inputs : List Nat` stands in for "references" / content-addresses of the inputs
  -/
  | transformedBy (codeHash : String) (inputs : List Nat)
  /-
  Selection-decision confidentiality and integrity (spec 8.5.7).

  The spec distinguishes:
  - *member confidentiality*: secrecy of the individual elements
  - *membership/selection confidentiality*: secrecy of which elements are included / in what order

  In the spec, "selection-decision integrity" is represented as integrity atoms that explain
  why a particular selection/order is user-aligned or properly disclosed.

  We model just enough structure to write and prove "checked declassification" rules:
  - `selectionDecisionConf source` is a *confidentiality* atom that can taint a collection container
    when membership/order decisions are influenced by sensitive criteria.
  - `selectionDecisionUserSpecified source` is an *integrity* atom meaning the user chose the criteria.
  - `selectionDecisionDisclosed source` and `userAcknowledgedSelection source` model the alternative
    "disclosed + acknowledged" justification path from the spec.

  As elsewhere, `source : Nat` is a stand-in for the spec's content-addressed `Reference`.
  -/
  | selectionDecisionConf (source : Nat)
  | selectionDecisionUserSpecified (source : Nat)
  | selectionDecisionDisclosed (source : Nat)
  | userAcknowledgedSelection (source : Nat)
  /-
  Scoped integrity for projections (spec 8.3.2).

  This atom is mainly used in *integrity labels*.

  Key idea: `scoped path a` is a fresh atom distinct from `a`.
  So if you scope the same base integrity claim to two different paths, the scoped atoms
  are different, and our integrity-join (intersection) will drop the claim when you recombine.
  This matches the spec's motivation for preventing accidental integrity "recombination".
  -/
  | scoped (path : List String) (atom : Atom)
  /-
  Like `scoped`, but also carries an explicit `source` id for the original structured value.

  This supports the "safe recomposition" use case from the spec:
  you *can* recombine `/lat` and `/long` from the same measurement and recover the integrity of the
  whole measurement, but you should not be able to recombine projections from *different* sources.

  We use `Nat` as a stand-in for the spec's "content-addressed reference" / `valueRef`.
  -/
  | scopedFrom (source : Nat) (path : List String) (atom : Atom)
  /-
  Collection-level integrity atoms (spec 8.5.6).

  In the spec, these mention a "source reference". We do not model cryptographic references
  here, so we use a `Nat` placeholder `source` to stand in for "the identity of the original
  collection". The important thing for the proofs is just that there *is* some identifier to
  tie the integrity fact to.
  -/
  | completeCollection (source : Nat)
  | filteredFrom (source : Nat) (predicate : String)
  | permutationOf (source : Nat)
  | lengthPreserved (source : Nat)
  /-
  Expiration is modeled as a special atom that depends on the principal's `now` time.

  In confidentiality labels, including `[expires t]` in a clause means: "this clause can only be
  satisfied before time `t`". This is a small example of an atom with semantics beyond
  set-membership.
  -/
  | expires (t : Nat)
  | other (name : String)
  deriving DecidableEq, Repr

/-
`TrustedScope` is a distinguished integrity token used by the tiny declassification language
to model "trusted control flow" (robust declassification / transparent endorsement).

In the spec this corresponds to the runtime being the trusted component that can vouch for
control-flow decisions.
-/
def trustedScope : Atom :=
  Atom.integrityTok "TrustedScope"

end Cfc
