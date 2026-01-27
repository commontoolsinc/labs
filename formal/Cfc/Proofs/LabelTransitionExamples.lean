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
This file is a tiny "regression suite" for Chapter 8.

Unlike the earlier big theorems (non-interference, robust declassification, etc.),
these are meant as *sanity checks* that the transition primitives behave like the spec says.

Each theorem is intentionally small and uses mostly definitional reasoning (`simp`).
If one of these breaks, it usually means we accidentally changed a transition rule.
-/

/-
Spec 8.3.2 (projection scoping) is motivated by preventing an integrity bug:
you must not be able to take `.lat` from one measurement and `.long` from another and still claim
"this pair is a valid GPS measurement".

In our model:
- projecting scopes integrity atoms, turning `GPSMeasurement` into
  `scopedFrom source ["lat"] GPSMeasurement` or `scopedFrom source ["long"] GPSMeasurement`
- integrity join is intersection

Therefore, joining the two projections produces *no* integrity atoms (empty intersection),
because the scoped atoms are different.

The Lean proof just unfolds the definitions and lets `simp` compute the intersection.
-/
theorem projection_scoping_drops_integrity_on_join :
    let base : Atom := Atom.integrityTok "GPSMeasurement"
    let input : Label := { conf := [], integ := [base] }
    let source : Nat := 7
    let lat := LabelTransition.projectionFrom [] input source ["lat"]
    let lon := LabelTransition.projectionFrom [] input source ["long"]
    (lat + lon).integ = [] := by
  classical
  intro base input source lat lon
  -- `joinIntegrity` is list intersection implemented via `List.filter`.
  -- After unfolding, Lean sees two singleton lists with different atoms, so the filter returns `[]`.
  simp [lat, lon, LabelTransition.projectionFrom, LabelTransition.taintPc,
    LabelTransition.scopeIntegrityFrom, Label.joinIntegrity]

/-
Safe recomposition (motivated by spec 8.3.2):

If `/lat` and `/long` projections come from the *same* source measurement, the runtime can verify
that fact and restore the integrity of the whole measurement for the recomposed object.

We model this with `recomposeFromProjections`, which checks for the presence of the scoped
integrity atoms and then adds `scopedFrom source [] base` (empty path = whole object).
-/
theorem projection_recompose_restores_integrity :
    let base : Atom := Atom.integrityTok "GPSMeasurement"
    let input : Label := { conf := [], integ := [base] }
    let source : Nat := 7
    let lat := LabelTransition.projectionFrom [] input source ["lat"]
    let lon := LabelTransition.projectionFrom [] input source ["long"]
    let parts : List LabelTransition.ProjectionPart :=
      [ { path := ["lat"], expectedRef := 1, outputRef := 1, label := lat }
      , { path := ["long"], expectedRef := 2, outputRef := 2, label := lon } ]
    ∃ out, LabelTransition.recomposeFromProjections [] source base parts = some out ∧
      Atom.scopedFrom source [] base ∈ out.integ := by
  classical
  intro base input source lat lon parts
  let out0 : Label := LabelTransition.combinedFrom [] [lat, lon]
  let out : Label := { out0 with integ := out0.integ ++ [Atom.scopedFrom source [] base] }
  refine ⟨out, ?_, ?_⟩
  ·
    -- Discharge the verification check (`List.all` of membership facts) and unfold the definition.
    simp [out, out0, LabelTransition.recomposeFromProjections, LabelTransition.verifyRecomposeProjections,
      LabelTransition.combinedFrom, parts, lat, lon, input, LabelTransition.projectionFrom,
      LabelTransition.taintPc, LabelTransition.scopeIntegrityFrom]
  ·
    -- The recomposition function appends the "whole object" integrity atom by construction.
    simp [out, out0]

/-
Unsafe recomposition is rejected:

If the parts come from different sources, the verification check fails and the runtime rejects
the recomposition claim (`none`).
-/
theorem projection_recompose_rejects_mixed_sources :
    let base : Atom := Atom.integrityTok "GPSMeasurement"
    let input : Label := { conf := [], integ := [base] }
    let source₁ : Nat := 7
    let source₂ : Nat := 8
    let lat := LabelTransition.projectionFrom [] input source₁ ["lat"]
    let lon := LabelTransition.projectionFrom [] input source₂ ["long"]
    let parts : List LabelTransition.ProjectionPart :=
      [ { path := ["lat"], expectedRef := 1, outputRef := 1, label := lat }
      , { path := ["long"], expectedRef := 2, outputRef := 2, label := lon } ]
    LabelTransition.recomposeFromProjections [] source₁ base parts = none := by
  classical
  intro base input source₁ source₂ lat lon parts
  -- In this concrete example, `source₁` and `source₂` are definitional equal to `7` and `8`,
  -- so Lean can decide that they are different.
  have hs : source₁ ≠ source₂ := by decide
  -- With `hs`, the integrity atom demanded by the recomposition verifier cannot be present in `lon`'s label,
  -- so the boolean check fails and the transition returns `none`.
  simp [LabelTransition.recomposeFromProjections, LabelTransition.verifyRecomposeProjections,
    parts, lat, lon, input, LabelTransition.projectionFrom, LabelTransition.taintPc,
    LabelTransition.scopeIntegrityFrom, hs]

/-
Spec 8.4 (exactCopyOf) says:
- if the runtime check confirms output is an exact copy of an input, preserve the label
- if the check fails, reject the handler output

Our `exactCopyOf` returns an `Option Label`:
- `some ...` means "accept and use this label"
- `none` means "reject"

This theorem checks the reject case on a concrete `Ref` type (`Nat`) with `1 ≠ 2`.
-/
theorem exactCopyOf_rejects_mismatch (input : Label) :
    LabelTransition.exactCopyOf (Ref := Nat) [] 1 2 input = none := by
  have h : (1 : Nat) ≠ 2 := by decide
  exact (Proofs.LabelTransitions.exactCopyOf_eq_none_iff (pc := []) (inputRef := 1) (outputRef := 2)
    (input := input)).2 h

/-
Spec 8.7.2 (endorsed transformations):

Most computations should *not* preserve input integrity, because arbitrary code can tamper with data.
So the default transformation rule mints a `TransformedBy(...)` provenance atom.

However, if a transformer is in a trusted registry, the runtime may preserve certain integrity atoms.

In Lean we model this as a checked transition:
  `endorsedTransformedFromChecked reg pc codeHash inputRefs inputs claimedPreserve`

The registry `reg` lists which (codeHash, preserves) pairs are endorsed, and the schema claims which
atoms it wants preserved (`claimedPreserve`).

This example checks the happy path:
- the transformer is endorsed,
- the input actually has the atom,
- so the output includes both `TransformedBy(...)` and the preserved atom.
-/
theorem endorsedTransformedFromChecked_preserves_allowed_atom :
    let base : Atom := Atom.integrityTok "LengthMeasurement"
    let input : Label := { conf := [], integ := [base] }
    let reg : List LabelTransition.TransformRule :=
      [{ codeHash := "abc123", preserves := [base] }]
    ∃ out,
      LabelTransition.endorsedTransformedFromChecked reg [] "abc123" [10] [input] [base] = some out ∧
      base ∈ out.integ := by
  classical
  intro base input reg
  -- Spell out the expected output label explicitly.
  let out : Label :=
    LabelTransition.taintPc []
      { conf := input.conf
        integ := [Atom.transformedBy "abc123" [10]] ++ [base] }
  refine ⟨out, ?_, ?_⟩
  ·
    -- The registry check succeeds and `preservedFromInputs` keeps `base` (it is common to all inputs).
    simp [out, LabelTransition.endorsedTransformedFromChecked, LabelTransition.verifyEndorsedTransform,
      LabelTransition.preservedFromInputs, LabelTransition.commonIntegrity, input, reg,
      LabelTransition.taintPc]
  ·
    -- The preserved atom is appended by construction.
    simp [out]

/-
If the transformer is *not* in the registry (or the schema claims atoms not allowed by the registry),
the runtime rejects the "endorsed transformation" claim.
-/
theorem endorsedTransformedFromChecked_rejects_unendorsed_code :
    let base : Atom := Atom.integrityTok "LengthMeasurement"
    let input : Label := { conf := [], integ := [base] }
    let reg : List LabelTransition.TransformRule := []
    LabelTransition.endorsedTransformedFromChecked reg [] "abc123" [10] [input] [base] = none := by
  classical
  intro base input reg
  simp [LabelTransition.endorsedTransformedFromChecked, LabelTransition.verifyEndorsedTransform, reg]

/-
Spec 8.5.6.1 (membership confidentiality vs member confidentiality) is the key subtlety for arrays.

This theorem is a lightweight check that our collection transition returns:
- a container label that includes `pc` (membership secrecy)
- a members list that is *exactly* the provided list (member labels are not modified here)

We build a tiny example:
- input has two public members
- output selects a single public member (filtering)
- `pc` is `[[User "Alice"]]` (membership depends on Alice's secret predicate/query)

Result:
- output.container.conf = pc  (since the input container is public)
- output.members = outMembers (since transitions preserve member labels structurally)
-/
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

/-
Length preservation (spec 8.5.4):

This is the "map-like" collection constraint: the output collection is allowed to contain
*different* elements, but it must have the same length as the source collection.

Our Lean model provides a checked transition:
  `CollectionTransition.Verify.lengthPreservedChecked`

which returns:
- `some out` if lengths match,
- `none` if they do not.

This example also checks the integrity behavior:
- the runtime drops any existing `completeCollection` claim, and
- adds a `lengthPreserved source` witness atom.
-/
theorem lengthPreservedChecked_accepts_equal_lengths :
    let base : Atom := Atom.integrityTok "X"
    let input : LabeledCollection Nat :=
      { container := { conf := [], integ := [Atom.completeCollection 0, base] }
        members := [(1, Label.bot), (2, Label.bot)] }
    let outputMembers : List (Nat × Label) := [(10, Label.bot), (20, Label.bot)]
    let pc : ConfLabel := [[Atom.user "Alice"]]
    ∃ out,
      CollectionTransition.Verify.lengthPreservedChecked pc 42 input outputMembers = some out ∧
      Atom.lengthPreserved 42 ∈ out.container.integ ∧
      Atom.completeCollection 0 ∉ out.container.integ := by
  classical
  intro base input outputMembers pc
  -- The checked transition returns exactly this constructed output on success.
  let out : LabeledCollection Nat :=
    { container :=
        { conf := pc ++ input.container.conf
          integ :=
            CollectionTransition.stripCollectionIntegrity input.container.integ ++
              [Atom.lengthPreserved 42] }
      members := outputMembers }
  refine ⟨out, ?_, ?_, ?_⟩
  ·
    -- Lengths match (`2 = 2`), so the boolean verifier returns `true`.
    simp [out, CollectionTransition.Verify.lengthPreservedChecked, CollectionTransition.Verify.lengthPreservedB,
      input, outputMembers, pc]
  ·
    -- The witness atom is appended by construction.
    simp [out]
  ·
    -- `completeCollection` is a collection-level integrity atom, so it is stripped.
    simp [out, CollectionTransition.stripCollectionIntegrity, Atom.isCollectionIntegrity]

/-
If the output length does *not* match the input length, the runtime rejects the claimed
`lengthPreserved` constraint.
-/
theorem lengthPreservedChecked_rejects_mismatched_lengths :
    let input : LabeledCollection Nat :=
      { container := Label.bot
        members := [(1, Label.bot), (2, Label.bot)] }
    let outputMembers : List (Nat × Label) := [(10, Label.bot)]
    CollectionTransition.Verify.lengthPreservedChecked [] 0 input outputMembers = none := by
  classical
  intro input outputMembers
  -- Lengths do not match (`1 ≠ 2`), so the check is false and the transition returns `none`.
  simp [CollectionTransition.Verify.lengthPreservedChecked, CollectionTransition.Verify.lengthPreservedB,
    input, outputMembers]

/-
This final example connects the "split label" story to `canAccess`:

Even if a member is public, you should not be able to observe it through a collection
if the membership itself is secret.

We encode that by defining:
  derefMember c member = Link.deref c.container member
and we have a lemma:
  canAccess p (derefMember c m) <-> canAccess p c.container AND canAccess p m

So we pick:
- `member` is public
- `container.conf` is `[[User "Alice"]]` (secret membership)
- principal `pBob` only has `User "Bob"`

Then `pBob` cannot access the container, hence cannot access the dereferenced member label.
-/
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
