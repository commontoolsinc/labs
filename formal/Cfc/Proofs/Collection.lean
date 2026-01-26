import Std

import Cfc.Collection
import Cfc.Proofs.Link

namespace Cfc

namespace Proofs
namespace Collection

open Cfc

theorem subsetOf_members_subset {Ref : Type} (pc : ConfLabel)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) :
    ∀ m, m ∈ (CollectionTransition.subsetOf pc input outputMembers hSubset).members →
      m ∈ input.members := by
  intro m hm
  exact hSubset m (by simpa [CollectionTransition.subsetOf] using hm)

@[simp] theorem conf_subsetOf_container {Ref : Type} (pc : ConfLabel)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) :
    (CollectionTransition.subsetOf pc input outputMembers hSubset).container.conf =
      pc ++ input.container.conf := by
  simp [CollectionTransition.subsetOf]

theorem not_mem_subsetOf_completeCollection {Ref : Type} (pc : ConfLabel)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) (source : Nat) :
    Atom.completeCollection source ∉
      (CollectionTransition.subsetOf pc input outputMembers hSubset).container.integ := by
  classical
  simp [CollectionTransition.subsetOf, CollectionTransition.stripCollectionIntegrity, Atom.isCollectionIntegrity]

theorem perm_members_perm {Ref : Type} (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hPerm : outputMembers.Perm input.members) :
    (CollectionTransition.permutationOf pc source input outputMembers hPerm).members.Perm
      input.members := by
  simpa [CollectionTransition.permutationOf] using hPerm

@[simp] theorem conf_permutationOf_container {Ref : Type} (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hPerm : outputMembers.Perm input.members) :
    (CollectionTransition.permutationOf pc source input outputMembers hPerm).container.conf =
      pc ++ input.container.conf := by
  simp [CollectionTransition.permutationOf]

theorem mem_permutationOf_permutationAtom {Ref : Type} (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hPerm : outputMembers.Perm input.members) :
    Atom.permutationOf source ∈
      (CollectionTransition.permutationOf pc source input outputMembers hPerm).container.integ := by
  simp [CollectionTransition.permutationOf]

@[simp] theorem conf_filteredFrom_container {Ref : Type} (pc : ConfLabel) (source : Nat) (predicate : String)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) :
    (CollectionTransition.filteredFrom pc source predicate input outputMembers hSubset).container.conf =
      pc ++ input.container.conf := by
  simp [CollectionTransition.filteredFrom]

theorem mem_filteredFrom_filteredAtom {Ref : Type} (pc : ConfLabel) (source : Nat) (predicate : String)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) :
    Atom.filteredFrom source predicate ∈
      (CollectionTransition.filteredFrom pc source predicate input outputMembers hSubset).container.integ := by
  simp [CollectionTransition.filteredFrom]

theorem not_mem_filteredFrom_completeCollection {Ref : Type} (pc : ConfLabel) (source : Nat) (predicate : String)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) (completeSource : Nat) :
    Atom.completeCollection completeSource ∉
      (CollectionTransition.filteredFrom pc source predicate input outputMembers hSubset).container.integ := by
  classical
  simp [CollectionTransition.filteredFrom, CollectionTransition.stripCollectionIntegrity, Atom.isCollectionIntegrity]

theorem canAccess_derefMember_iff {Ref : Type} (p : Principal) (c : LabeledCollection Ref) (member : Label) :
    canAccess p (LabeledCollection.derefMember c member) ↔ canAccess p c.container ∧ canAccess p member := by
  simpa [LabeledCollection.derefMember] using (Proofs.Link.canAccess_deref_iff p c.container member)

end Collection
end Proofs

end Cfc
