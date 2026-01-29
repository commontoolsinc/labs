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

/-!
Length-preservation transition lemmas (spec 8.5.4).

Unlike `subsetOf` / `filteredFrom` / `permutationOf`, length preservation makes no claim about
which elements are present, only about the *count* of elements.
-/

/-
Container confidentiality for length preservation is still tainted by `pc` (membership secrecy).
-/
@[simp] theorem conf_lengthPreserved_container {Ref : Type} (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hLen : outputMembers.length = input.members.length) :
    (CollectionTransition.lengthPreserved pc source input outputMembers hLen).container.conf =
      pc ++ input.container.conf := by
  simp [CollectionTransition.lengthPreserved]

/-
Length preservation actually preserves the length, by its parameter `hLen`.
-/
theorem length_lengthPreserved_eq {Ref : Type} (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hLen : outputMembers.length = input.members.length) :
    (CollectionTransition.lengthPreserved pc source input outputMembers hLen).members.length =
      input.members.length := by
  simpa [CollectionTransition.lengthPreserved] using hLen

/-
The transition records its structural guarantee via a `lengthPreserved` integrity atom.
-/
theorem mem_lengthPreserved_lengthAtom {Ref : Type} (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hLen : outputMembers.length = input.members.length) :
    Atom.lengthPreserved source ∈
      (CollectionTransition.lengthPreserved pc source input outputMembers hLen).container.integ := by
  simp [CollectionTransition.lengthPreserved]

/-
Length preservation drops any existing "complete collection" claims (same reasoning as subsets):
once elements are transformed, `completeCollection` is no longer justified.
-/
theorem not_mem_lengthPreserved_completeCollection {Ref : Type} (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (hLen : outputMembers.length = input.members.length) (completeSource : Nat) :
    Atom.completeCollection completeSource ∉
      (CollectionTransition.lengthPreserved pc source input outputMembers hLen).container.integ := by
  classical
  simp [CollectionTransition.lengthPreserved, CollectionTransition.stripCollectionIntegrity, Atom.isCollectionIntegrity]

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

/-!
Selection-decision integrity / declassification (spec 8.5.7).

The spec claims that some selection/membership confidentiality taint can be cleared if the runtime
has integrity evidence that the selection criteria were user-aligned or properly disclosed.

Our Lean model represents this with:
- a confidentiality atom `Atom.selectionDecisionConf source`, and
- integrity atoms like `Atom.selectionDecisionUserSpecified source`.

The runtime-only declassification rule is `CollectionTransition.declassifySelectionDecisionIf`,
which is guarded by:
- required integrity atoms on the *container* label, and
- `trustedScope ∈ pcI` (trusted control-flow evidence).
-/

theorem mem_clearSelectionDecisionConf (source : Nat) (cl : Clause) (conf : ConfLabel) :
    cl ∈ CollectionTransition.clearSelectionDecisionConf source conf ↔
      cl ∈ conf ∧ Atom.selectionDecisionConf source ∉ cl := by
  classical
  simp [CollectionTransition.clearSelectionDecisionConf]

theorem requiresAll_eq_true_iff (required : List Atom) (I : IntegLabel) :
    CollectionTransition.requiresAll required I = true ↔ ∀ a, a ∈ required → a ∈ I := by
  classical
  simp [CollectionTransition.requiresAll, List.all_eq_true]

theorem conf_declassifySelectionDecisionIf_eq_of_not_trusted {Ref : Type}
    (pcI : IntegLabel) (source : Nat) (required : List Atom) (c : LabeledCollection Ref)
    (hNo : trustedScope ∉ pcI) :
    (CollectionTransition.declassifySelectionDecisionIf pcI source required c).container.conf =
      c.container.conf := by
  classical
  -- Case split on the `decide` of the trust predicate.
  cases ht : decide (trustedScope ∈ pcI) with
  | false =>
      simp [CollectionTransition.declassifySelectionDecisionIf, ht]
  | true =>
      have : trustedScope ∈ pcI := of_decide_eq_true ht
      exact (hNo this).elim

theorem conf_declassifySelectionDecisionIf_eq_clear_of_success {Ref : Type}
    (pcI : IntegLabel) (source : Nat) (required : List Atom) (c : LabeledCollection Ref)
    (hReq : CollectionTransition.requiresAll required c.container.integ = true)
    (hTrust : trustedScope ∈ pcI) :
    (CollectionTransition.declassifySelectionDecisionIf pcI source required c).container.conf =
      CollectionTransition.clearSelectionDecisionConf source c.container.conf := by
  classical
  have ht : decide (trustedScope ∈ pcI) = true := (decide_eq_true_iff).2 hTrust
  simp [CollectionTransition.declassifySelectionDecisionIf, hReq, ht]

/-
Soundness lemmas for the executable verification checks in `CollectionTransition.Verify`.

These are the connection between the spec's "runtime verification algorithm" story and the
pure transition rules:
- the boolean checks are what a runtime would *compute*,
- the lemmas below say that when a check returns `true`, the intended mathematical property holds.
-/

theorem subsetOfB_eq_true_iff {Ref : Type} [DecidableEq Ref]
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) :
    CollectionTransition.Verify.subsetOfB input outputMembers = true ↔
      ∀ m, m ∈ outputMembers → m ∈ input.members := by
  classical
  simp [CollectionTransition.Verify.subsetOfB, List.all_eq_true]

theorem permutationOfB_eq_true_iff {Ref : Type} [DecidableEq Ref]
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) :
    CollectionTransition.Verify.permutationOfB input outputMembers = true ↔
      outputMembers.Perm input.members := by
  simp [CollectionTransition.Verify.permutationOfB]

theorem lengthPreservedB_eq_true_iff {Ref : Type}
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) :
    CollectionTransition.Verify.lengthPreservedB input outputMembers = true ↔
      outputMembers.length = input.members.length := by
  -- `lengthPreservedB` is defined as `decide (...)`, so `simp` turns `= true` into the proposition.
  simp [CollectionTransition.Verify.lengthPreservedB]

theorem subsetOfChecked_eq_some_iff {Ref : Type} [DecidableEq Ref]
    (pc : ConfLabel) (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) (out : LabeledCollection Ref) :
    CollectionTransition.Verify.subsetOfChecked pc input outputMembers = some out ↔
      CollectionTransition.Verify.subsetOfB input outputMembers = true ∧
      out =
        { container :=
            { conf := pc ++ input.container.conf
              integ := CollectionTransition.stripCollectionIntegrity input.container.integ }
          members := outputMembers } := by
  classical
  by_cases h : CollectionTransition.Verify.subsetOfB input outputMembers = true <;>
    simp [CollectionTransition.Verify.subsetOfChecked, h, eq_comm]

theorem filteredFromChecked_eq_some_iff {Ref : Type} [DecidableEq Ref]
    (pc : ConfLabel) (source : Nat) (predicate : String)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) (out : LabeledCollection Ref) :
    CollectionTransition.Verify.filteredFromChecked pc source predicate input outputMembers = some out ↔
      CollectionTransition.Verify.filteredFromB input outputMembers = true ∧
      out =
        { container :=
            { conf := pc ++ input.container.conf
              integ :=
                CollectionTransition.stripCollectionIntegrity input.container.integ ++
                  [Atom.filteredFrom source predicate] }
          members := outputMembers } := by
  classical
  by_cases h : CollectionTransition.Verify.filteredFromB input outputMembers = true <;>
    simp [CollectionTransition.Verify.filteredFromChecked, h, eq_comm]

theorem permutationOfChecked_eq_some_iff {Ref : Type} [DecidableEq Ref]
    (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) (out : LabeledCollection Ref) :
    CollectionTransition.Verify.permutationOfChecked pc source input outputMembers = some out ↔
      CollectionTransition.Verify.permutationOfB input outputMembers = true ∧
      out =
        { container :=
            { conf := pc ++ input.container.conf
              integ := input.container.integ ++ [Atom.permutationOf source] }
          members := outputMembers } := by
  classical
  by_cases h : CollectionTransition.Verify.permutationOfB input outputMembers = true <;>
    simp [CollectionTransition.Verify.permutationOfChecked, h, eq_comm]

theorem lengthPreservedChecked_eq_some_iff {Ref : Type}
    (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) (out : LabeledCollection Ref) :
    CollectionTransition.Verify.lengthPreservedChecked pc source input outputMembers = some out ↔
      CollectionTransition.Verify.lengthPreservedB input outputMembers = true ∧
      out =
        { container :=
            { conf := pc ++ input.container.conf
              integ := CollectionTransition.stripCollectionIntegrity input.container.integ ++
                [Atom.lengthPreserved source] }
          members := outputMembers } := by
  classical
  by_cases h : CollectionTransition.Verify.lengthPreservedB input outputMembers = true <;>
    simp [CollectionTransition.Verify.lengthPreservedChecked, h, eq_comm]

end Collection
end Proofs

end Cfc
