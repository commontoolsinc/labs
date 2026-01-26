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
  Scoped integrity for projections (spec 8.3.2).

  This atom is mainly used in *integrity labels*.

  Key idea: `scoped path a` is a fresh atom distinct from `a`.
  So if you scope the same base integrity claim to two different paths, the scoped atoms
  are different, and our integrity-join (intersection) will drop the claim when you recombine.
  This matches the spec's motivation for preventing accidental integrity "recombination".
  -/
  | scoped (path : List String) (atom : Atom)
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
