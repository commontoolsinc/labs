import Std

import Cfc.Label
import Cfc.Link

namespace Cfc

/-!
Collections (spec 8.5).

The spec distinguishes:
- *member* labels (each element's own confidentiality/integrity)
- *membership* label (the container's label, tracking which members are present)

We model this explicitly as:

  container : Label
  members   : List (Ref × Label)

where `Ref` is an abstract reference/id for an element (standing in for the spec's
content-addressed references).

Intuition for the split (spec 8.5.6.1):

- Even if each element is public, the *fact that a particular element is included*
  can be confidential. Example: "search results" where the catalog items are public
  but the query is private; inclusion leaks the query.

So we treat the collection container label as "membership confidentiality",
and we treat each element label as "member confidentiality".

This is also consistent with the spec's "per-path labeling" idea:
the label at `/items` (the array container) can differ from the labels at `/items/*`.
-/

structure LabeledCollection (Ref : Type) where
  container : Label
  members : List (Ref × Label)
  deriving Repr

namespace LabeledCollection

variable {Ref : Type}

/-
When you "observe a member" (i.e. read the element's value), you learn:
1) the element's own contents, and
2) that this element is present in this particular collection.

The spec models that as conjunctive confidentiality between:
- the member label, and
- the container label.

We already have a label operation with exactly those semantics: `Link.deref` (spec 3.7.1),
which says "to view the target through a link, you must be allowed to see both".

So we reuse it here as a convenient way to express the idea:
  derefMember c member = deref (containerLabel) (memberLabel)
-/
def derefMember (c : LabeledCollection Ref) (member : Label) : Label :=
  Cfc.Link.deref c.container member

/-
Observing `length` does not reveal any member contents, only membership/selection information.
So its label is just the container label.
-/
def lengthLabel (c : LabeledCollection Ref) : Label :=
  c.container

end LabeledCollection

namespace Atom

/-
Collection-level integrity atoms (spec 8.5.6).

The spec distinguishes integrity facts about the *collection as a whole*, for example:
- "this is the complete collection from source X"
- "this is a filtered subset of source X with predicate P"
- "this is a permutation of source X"

We represent those as regular integrity atoms (see `Cfc.Atom`) and provide a Boolean
classifier so we can strip/preserve them depending on which transition we apply.
-/
def isCollectionIntegrity : Atom → Bool
  | .completeCollection _ => true
  | .filteredFrom _ _ => true
  | .permutationOf _ => true
  | .lengthPreserved _ => true
  | _ => false

end Atom

namespace CollectionTransition

/-
Drop collection-level integrity claims.

Operationally this is just a `List.filter`: keep atoms that are *not* collection-level claims.

We use this for transitions that produce a subset: once you drop elements, you cannot keep
claims like "completeCollection source".
-/
def stripCollectionIntegrity (I : IntegLabel) : IntegLabel :=
  I.filter (fun a => ! Atom.isCollectionIntegrity a)

/-
Membership characterization for `stripCollectionIntegrity`:

  a is in stripCollectionIntegrity I
    iff (a is in I) AND (a is not a collection-integrity atom).

This is a standard property of `List.filter`.
-/
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

/-
Selection-decision declassification (spec 8.5.7):

The spec introduces the idea that a collection's membership/order can be confidential because it
leaks something about the selection criteria (e.g. a private search query).

It also introduces a *checked declassification rule*:
if the selection criteria are user-aligned or properly disclosed/acknowledged, then the runtime
may clear the selection-decision confidentiality taint.

We model a very small version of that idea:

- The confidentiality taint is represented by a clause containing `Atom.selectionDecisionConf source`.
  (A clause is a disjunction; in most examples this will be a singleton clause.)
- The integrity justification is represented by required integrity atoms on the *container* label,
  e.g. `selectionDecisionUserSpecified source`.
- Finally, declassification is only allowed if the ambient control integrity contains `trustedScope`
  (the same "trusted control-flow" token used elsewhere in the repo).

This keeps the key shape of robust declassification:
declassify only with both (a) integrity justification and (b) trusted control.
-/

def clearSelectionDecisionConf (source : Nat) (conf : ConfLabel) : ConfLabel :=
  conf.filter (fun cl => ! decide (Atom.selectionDecisionConf source ∈ cl))

def requiresAll (required : List Atom) (I : IntegLabel) : Bool :=
  required.all (fun a => decide (a ∈ I))

def declassifySelectionDecisionIf {Ref : Type}
    (pcI : IntegLabel) (source : Nat) (required : List Atom) (c : LabeledCollection Ref) : LabeledCollection Ref :=
  if requiresAll required c.container.integ && decide (trustedScope ∈ pcI) then
    { c with container := { c.container with conf := clearSelectionDecisionConf source c.container.conf } }
  else
    c

/--
Length-preserved transition (8.5.4):

This models the "map-like" case where the output collection has the same length as the input,
but elements may have been transformed (so there is no subset/permutation relationship).

Semantics:
- membership confidentiality is tainted by `pc` (selection/order decisions are control-flow)
- we strip any existing collection-level integrity claims (e.g. `completeCollection`)
  because the members have changed
- we add a witness atom `lengthPreserved source` tying the output to an input collection id
  (here `source : Nat` stands in for the spec's content-addressed reference).
-/
def lengthPreserved {Ref : Type} (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label))
    (_hLen : outputMembers.length = input.members.length) : LabeledCollection Ref :=
  { container :=
      { conf := pc ++ input.container.conf
        integ := stripCollectionIntegrity input.container.integ ++ [Atom.lengthPreserved source] }
    members := outputMembers }

namespace Verify

/-
Executable (boolean) verification algorithms for the collection constraints in spec 8.5.

The spec presents these checks in TypeScript-like pseudocode (subset/permutation/filter).
Here we provide Lean `Bool` versions and later prove soundness lemmas about them.

Design choice:
- We check membership/permutation on the full `(Ref × Label)` pairs, not just the `Ref`.
  This is slightly stronger than the spec's "reference-only" checks, but it matches our
  current representation where a member is already a `(ref, label)` pair.
  If output members are constructed by copying labels from the input, these checks coincide.
-/

def subsetOfB {Ref : Type} [DecidableEq Ref]
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) : Bool :=
  outputMembers.all (fun m => decide (m ∈ input.members))

def permutationOfB {Ref : Type} [DecidableEq Ref]
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) : Bool :=
  decide (outputMembers.Perm input.members)

/-- Filtered-from is verified the same way as subset-of (it is a particular kind of subset). -/
def filteredFromB {Ref : Type} [DecidableEq Ref]
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) : Bool :=
  subsetOfB input outputMembers

def lengthPreservedB {Ref : Type}
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) : Bool :=
  decide (outputMembers.length = input.members.length)

/-
Checked versions of the collection transitions:
- return `some out` when the verification passes,
- return `none` (reject) when verification fails.

This matches the spec's "runtime verification" story: if a handler claims a particular
constraint (subset/permutation/filter) but does not satisfy it, the runtime rejects the output.
-/

def subsetOfChecked {Ref : Type} [DecidableEq Ref] (pc : ConfLabel)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) : Option (LabeledCollection Ref) :=
  if subsetOfB input outputMembers then
    some
      { container :=
          { conf := pc ++ input.container.conf
            integ := stripCollectionIntegrity input.container.integ }
        members := outputMembers }
  else
    none

def filteredFromChecked {Ref : Type} [DecidableEq Ref] (pc : ConfLabel) (source : Nat) (predicate : String)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) : Option (LabeledCollection Ref) :=
  if filteredFromB input outputMembers then
    some
      { container :=
          { conf := pc ++ input.container.conf
            integ := stripCollectionIntegrity input.container.integ ++
              [Atom.filteredFrom source predicate] }
        members := outputMembers }
  else
    none

def permutationOfChecked {Ref : Type} [DecidableEq Ref] (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) : Option (LabeledCollection Ref) :=
  if permutationOfB input outputMembers then
    some
      { container :=
          { conf := pc ++ input.container.conf
            integ := input.container.integ ++ [Atom.permutationOf source] }
        members := outputMembers }
  else
    none

def lengthPreservedChecked {Ref : Type} (pc : ConfLabel) (source : Nat)
    (input : LabeledCollection Ref) (outputMembers : List (Ref × Label)) : Option (LabeledCollection Ref) :=
  if lengthPreservedB input outputMembers then
    some
      { container :=
          { conf := pc ++ input.container.conf
            integ := stripCollectionIntegrity input.container.integ ++ [Atom.lengthPreserved source] }
        members := outputMembers }
  else
    none

end Verify

end CollectionTransition

end Cfc
