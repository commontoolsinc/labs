import Std

import Cfc.Access
import Cfc.Collection
import Cfc.LabelTransitions
import Cfc.Proofs.Collection
import Cfc.Proofs.LabelTransitions

namespace Cfc

namespace Proofs
namespace LabelTransitionExamples

open Cfc

/-
A few small regressions corresponding to spec Chapter 8:
- projection scoping prevents accidental integrity recombination
- exactCopyOf rejects mismatches
- collections separate membership confidentiality (container) from member labels
-/

theorem projection_scoping_drops_integrity_on_join :
    let input : Label := { conf := [], integ := [Atom.integrityTok "GPSMeasurement"] }
    let lat := LabelTransition.projection [] input ["lat"]
    let lon := LabelTransition.projection [] input ["long"]
    (lat + lon).integ = [] := by
  classical
  intro input lat lon
  -- `joinIntegrity` is list intersection; the scoped atoms differ by path, so the intersection is empty.
  simp [lat, lon, LabelTransition.projection, LabelTransition.taintPc, LabelTransition.scopeIntegrity, Label.joinIntegrity]

theorem exactCopyOf_rejects_mismatch (input : Label) :
    LabelTransition.exactCopyOf (Ref := Nat) [] 1 2 input = none := by
  have h : (1 : Nat) ≠ 2 := by decide
  exact (Proofs.LabelTransitions.exactCopyOf_eq_none_iff (pc := []) (inputRef := 1) (outputRef := 2)
    (input := input)).2 h

theorem filtered_collection_separates_membership_and_members :
    let publicLbl : Label := { conf := [], integ := [] }
    let input : LabeledCollection Nat :=
      { container := publicLbl
        members := [(1, publicLbl), (2, publicLbl)] }
    let outMembers : List (Nat × Label) := [(1, publicLbl)]
    let pc : ConfLabel := [[Atom.user "Alice"]]
    let out :=
      CollectionTransition.filteredFrom pc 0 "isActive" input outMembers (by
        intro m hm
        -- the only member is `(1, publicLbl)`
        have hm' : m = (1, publicLbl) := by
          simpa [outMembers] using hm
        subst hm'
        simp [input]
      )
    out.container.conf = pc ∧ out.members = outMembers := by
  classical
  intro publicLbl input outMembers pc out
  constructor
  · simp [out, input, publicLbl, CollectionTransition.filteredFrom]
  · rfl

theorem secret_membership_taints_member_access :
    let publicLbl : Label := { conf := [], integ := [] }
    let secret : ConfLabel := [[Atom.user "Alice"]]
    let c : LabeledCollection Nat := { container := { conf := secret, integ := [] }, members := [] }
    let pBob : Principal := { now := 0, atoms := [Atom.user "Bob"] }
    ¬ canAccess pBob (LabeledCollection.derefMember c publicLbl) := by
  classical
  intro publicLbl secret c pBob hAcc
  have h := (Proofs.Collection.canAccess_derefMember_iff (p := pBob) (c := c) (member := publicLbl)).1 hAcc
  have hNo : ¬ canAccess pBob c.container := by
    simp [c, pBob, secret, canAccess, canAccessConf, clauseSat, Principal.satisfies]
  exact hNo h.1

end LabelTransitionExamples
end Proofs

end Cfc
