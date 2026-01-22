import Std

namespace Cfc

/-!
Atoms are the basic "principals/facts" that appear in confidentiality clauses and integrity sets.

This is intentionally a tiny core model; the full CFC spec has many atom variants.
-/

inductive Atom where
  | user (did : String)
  | policy (name : String) (subject : String) (hash : String)
  | integrityTok (name : String)
  | expires (t : Nat)
  | other (name : String)
  deriving DecidableEq, Repr

def trustedScope : Atom :=
  Atom.integrityTok "TrustedScope"

end Cfc

