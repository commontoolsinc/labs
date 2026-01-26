import Std

import Cfc.Label
import Cfc.Link

namespace Cfc

/-!
Collections (spec 8.5).

The spec distinguishes:
- *member* labels (each element's own confidentiality/integrity)
- *membership* label (the container's label, tracking which members are present)

We model this explicitly as a container label plus a list of labeled members.
-/

structure LabeledCollection (Ref : Type) where
  container : Label
  members : List (Ref × Label)
  deriving Repr

namespace LabeledCollection

variable {Ref : Type}

/-- The label for observing a member value: membership confidentiality is conjunctive (8.5.6.1). -/
def derefMember (c : LabeledCollection Ref) (member : Label) : Label :=
  Cfc.Link.deref c.container member

/-- Observing `length` reveals only membership information (8.5.6.1). -/
def lengthLabel (c : LabeledCollection Ref) : Label :=
  c.container

end LabeledCollection

namespace Atom

/-- Collection-level integrity atoms (8.5.6). -/
def isCollectionIntegrity : Atom → Bool
  | .completeCollection _ => true
  | .filteredFrom _ _ => true
  | .permutationOf _ => true
  | _ => false

end Atom

namespace CollectionTransition

/-- Drop collection-level integrity claims (used by `subsetOf` and `filteredFrom`). -/
def stripCollectionIntegrity (I : IntegLabel) : IntegLabel :=
  I.filter (fun a => ! Atom.isCollectionIntegrity a)

theorem mem_stripCollectionIntegrity (a : Atom) (I : IntegLabel) :
    a ∈ stripCollectionIntegrity I ↔ a ∈ I ∧ Atom.isCollectionIntegrity a = false := by
  classical
  simp [stripCollectionIntegrity, Atom.isCollectionIntegrity]

/--
Subset transition (8.5.2):
- membership confidentiality tainted by `pc`
- member labels preserved (each output member must come from the input)

We conservatively drop any collection-level integrity claims on the container.
-/
def subsetOf {Ref : Type} (pc : ConfLabel)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (_hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) : LabeledCollection Ref :=
  { container :=
      { conf := pc ++ input.container.conf
        integ := stripCollectionIntegrity input.container.integ }
    members := outputMembers }

/--
Permutation transition (8.5.3):
- membership confidentiality tainted by `pc` (order/selection decisions are control-flow)
- member labels preserved (reordering only)
- collection-level integrity preserved, plus a `permutationOf` witness atom
-/
def permutationOf {Ref : Type} (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (_hPerm : outputMembers.Perm input.members) : LabeledCollection Ref :=
  { container :=
      { conf := pc ++ input.container.conf
        integ := input.container.integ ++ [Atom.permutationOf source] }
    members := outputMembers }

/--
Filtered transition (8.5.5 / 8.5.6):
- membership confidentiality tainted by `pc` (predicate may be confidential)
- member labels preserved (subset)
- collection loses "completeness" integrity; gains a `filteredFrom` witness atom
-/
def filteredFrom {Ref : Type} (pc : ConfLabel) (source : Nat) (predicate : String)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (_hSubset : ∀ m, m ∈ outputMembers → m ∈ input.members) : LabeledCollection Ref :=
  { container :=
      { conf := pc ++ input.container.conf
        integ := stripCollectionIntegrity input.container.integ ++
          [Atom.filteredFrom source predicate] }
    members := outputMembers }

end CollectionTransition

end Cfc
