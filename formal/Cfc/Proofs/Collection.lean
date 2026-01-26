import Std

import Cfc.Collection
import Cfc.Proofs.Link

namespace Cfc

namespace Proofs
namespace Collection

open Cfc

/-
This file contains the "preservation lemmas" for the collection transitions in `Cfc.Collection`.

Each transition constructor (subset/permutation/filter) is *parameterized* by evidence that
the runtime check succeeded (e.g. "output members are a subset of input members").

The transition functions themselves ignore this evidence computationally (they are just label
rewrites), but including it in the types makes it easy to state and prove lemmas that line up
with the spec's intended runtime verification.
-/

/-
Subset preservation for members:

If `outputMembers` is a subset of `input.members` (witnessed by `hSubset`),
then the members field of the constructed output collection is also a subset of `input.members`.

In the Lean code, this is almost tautological: `subsetOf` stores `outputMembers` unchanged.
-/
theorem subsetOf_members_subset {Ref : Type} (pc : ConfLabel)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) :
    ∀ m, m ∈ (CollectionTransition.subsetOf pc input outputMembers hSubset).members →
      m ∈ input.members := by
  intro m hm
  exact hSubset m (by simpa [CollectionTransition.subsetOf] using hm)

/-
Container confidentiality for subset:

By definition, `subsetOf` taints the container label by `pc` (membership secrecy)
and preserves the original container confidentiality otherwise.

This is a pure definitional simplification, so `simp` finishes it.
-/
@[simp] theorem conf_subsetOf_container {Ref : Type} (pc : ConfLabel)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) :
    (CollectionTransition.subsetOf pc input outputMembers hSubset).container.conf =
      pc ++ input.container.conf := by
  simp [CollectionTransition.subsetOf]

/-
Subset drops "completeCollection" integrity:

`subsetOf` applies `stripCollectionIntegrity`, which filters out collection-level integrity atoms.
So in particular no `Atom.completeCollection source` can remain in the output container integrity.

The proof is `simp` after unfolding filter and the classifier `Atom.isCollectionIntegrity`.
-/
theorem not_mem_subsetOf_completeCollection {Ref : Type} (pc : ConfLabel)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) (source : Nat) :
    Atom.completeCollection source ∉
      (CollectionTransition.subsetOf pc input outputMembers hSubset).container.integ := by
  classical
  simp [CollectionTransition.subsetOf, CollectionTransition.stripCollectionIntegrity, Atom.isCollectionIntegrity]

/-
Permutation preserves the multiset of members:

Lean's `List.Perm` is the standard notion of list permutation: same elements, possibly reordered.
So the lemma simply re-exports the `hPerm` witness, after unfolding the transition.
-/
theorem perm_members_perm {Ref : Type} (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hPerm : outputMembers.Perm input.members) :
    (CollectionTransition.permutationOf pc source input outputMembers hPerm).members.Perm
      input.members := by
  simpa [CollectionTransition.permutationOf] using hPerm

/-
Container confidentiality for permutation:

Even though the elements are the same, the *order* can leak information; we conservatively taint
membership confidentiality by `pc` in all collection transitions.
-/
@[simp] theorem conf_permutationOf_container {Ref : Type} (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hPerm : outputMembers.Perm input.members) :
    (CollectionTransition.permutationOf pc source input outputMembers hPerm).container.conf =
      pc ++ input.container.conf := by
  simp [CollectionTransition.permutationOf]

/-
Permutation adds a `permutationOf` witness atom:

This is how we record "same members, maybe reordered" at the collection level.
Again, the proof is definitional: the transition appends that atom.
-/
theorem mem_permutationOf_permutationAtom {Ref : Type} (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hPerm : outputMembers.Perm input.members) :
    Atom.permutationOf source ∈
      (CollectionTransition.permutationOf pc source input outputMembers hPerm).container.integ := by
  simp [CollectionTransition.permutationOf]

/-
Container confidentiality for filtering:

Filtering depends on a predicate (which may be secret), so membership confidentiality is tainted
by `pc` just like in `subsetOf`.
-/
@[simp] theorem conf_filteredFrom_container {Ref : Type} (pc : ConfLabel) (source : Nat) (predicate : String)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) :
    (CollectionTransition.filteredFrom pc source predicate input outputMembers hSubset).container.conf =
      pc ++ input.container.conf := by
  simp [CollectionTransition.filteredFrom]

/-
Filtering adds the `filteredFrom` witness atom:

This records "subset determined by predicate P" at the collection level, and importantly it
does *not* claim completeness.
-/
theorem mem_filteredFrom_filteredAtom {Ref : Type} (pc : ConfLabel) (source : Nat) (predicate : String)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) :
    Atom.filteredFrom source predicate ∈
      (CollectionTransition.filteredFrom pc source predicate input outputMembers hSubset).container.integ := by
  simp [CollectionTransition.filteredFrom]

/-
Filtering drops completeness:

Like `subsetOf`, `filteredFrom` strips all collection-level integrity and then re-adds only
the specific `filteredFrom` witness, so `completeCollection` cannot appear.
-/
theorem not_mem_filteredFrom_completeCollection {Ref : Type} (pc : ConfLabel) (source : Nat) (predicate : String)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) (completeSource : Nat) :
    Atom.completeCollection completeSource ∉
      (CollectionTransition.filteredFrom pc source predicate input outputMembers hSubset).container.integ := by
  classical
  simp [CollectionTransition.filteredFrom, CollectionTransition.stripCollectionIntegrity, Atom.isCollectionIntegrity]

/-
Access rule for "observing a member":

`LabeledCollection.derefMember` is defined as `Link.deref container member`.
We already proved a lemma about `Link.deref`:
  canAccess p (deref link target)  <->  canAccess p link AND canAccess p target

So this lemma is just a one-line rewrite to reuse that result.

In prose: you can observe the element only if you can observe (1) the membership information
and (2) the element itself.
-/
theorem canAccess_derefMember_iff {Ref : Type} (p : Principal) (c : LabeledCollection Ref) (member : Label) :
    canAccess p (LabeledCollection.derefMember c member) ↔ canAccess p c.container ∧ canAccess p member := by
  simpa [LabeledCollection.derefMember] using (Proofs.Link.canAccess_deref_iff p c.container member)

end Collection
end Proofs

end Cfc
