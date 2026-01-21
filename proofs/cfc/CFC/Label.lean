/-
  CFC/Label.lean
  Label structure as defined in Sections 3.1 and 4.2 of the CFC spec.

  Labels have two components:
  - Confidentiality: CNF structure (AND of clauses, each clause is OR of atoms)
  - Integrity: Simple conjunction (set of atoms)
-/

import CFC.Atom

namespace CFC

/-- A clause is a single atom or OR of atoms (disjunction)
    Represented as a non-empty list where:
    - Single element list = singleton clause
    - Multiple elements = disjunction (any one can satisfy)
-/
abbrev Clause := List Atom

/-- Check if a clause is valid (non-empty) -/
def Clause.valid (c : Clause) : Bool := !c.isEmpty

/-- A singleton clause (single atom) -/
def Clause.singleton (a : Atom) : Clause := [a]

/-- Create a disjunction clause from multiple atoms -/
def Clause.disjunction (atoms : List Atom) : Clause := atoms

/-- Add an alternative to an existing clause -/
def Clause.addAlternative (c : Clause) (a : Atom) : Clause :=
  if a ∈ c then c else c ++ [a]

/-- Confidentiality label: CNF structure (AND of clauses)
    Empty list means no confidentiality constraints (public) -/
abbrev ConfidentialityLabel := List Clause

/-- Integrity label: Simple conjunction (set of atoms)
    Empty list means no integrity claims -/
abbrev IntegrityLabel := List Atom

/-- A complete label with both confidentiality and integrity -/
structure Label where
  /-- CNF: AND of clauses, each clause is atom or OR of atoms -/
  confidentiality : ConfidentialityLabel
  /-- Simple conjunction of integrity atoms -/
  integrity : IntegrityLabel
  deriving Repr

/-- Empty label (no constraints, no claims) -/
def Label.empty : Label := ⟨[], []⟩

/-- Public data with no integrity -/
def Label.public : Label := Label.empty

/-- Check if a label is empty (fully public, no integrity) -/
def Label.isEmpty (l : Label) : Bool :=
  l.confidentiality.isEmpty && l.integrity.isEmpty

/-- A principal (access context) for checking if access is allowed -/
structure Principal where
  /-- Current timestamp -/
  now : Timestamp
  /-- Principals/capabilities held -/
  principals : List Atom
  deriving Repr

/-- Check if a principal satisfies a single atom -/
def Principal.satisfiesAtom (p : Principal) (a : Atom) : Bool :=
  match a with
  | .expires t => p.now ≤ t
  | _ => a ∈ p.principals

/-- Check if a principal satisfies a clause (any alternative) -/
def Principal.satisfiesClause (p : Principal) (c : Clause) : Bool :=
  c.any (p.satisfiesAtom ·)

/-- Check if a principal can access data with given label
    (must satisfy at least one alternative in every clause) -/
def Principal.canAccess (p : Principal) (l : Label) : Bool :=
  l.confidentiality.all (p.satisfiesClause ·)

/-- Join confidentiality labels (concatenate clauses) - Section 3.1.2
    This is the CNF join: more clauses = more restrictive -/
def ConfidentialityLabel.join (l₁ l₂ : ConfidentialityLabel) : ConfidentialityLabel :=
  l₁ ++ l₂

/-- Meet integrity labels (intersection) - Section 3.1.6
    Only atoms present in both labels are retained -/
def IntegrityLabel.meet [DecidableEq Atom] (i₁ i₂ : IntegrityLabel) : IntegrityLabel :=
  i₁.filter (fun a => a ∈ i₂)

/-- Join two complete labels - Section 3.1.7
    Confidentiality: concatenate clauses
    Integrity: intersection -/
def Label.join (l₁ l₂ : Label) : Label :=
  { confidentiality := l₁.confidentiality.join l₂.confidentiality
  , integrity := l₁.integrity.meet l₂.integrity }

instance : Append Label where
  append := Label.join

/-- Label ordering: l₁ ⊑ l₂ means l₁ is less restrictive than l₂
    For confidentiality: fewer clauses or more alternatives per clause
    For integrity: more atoms -/
def Label.flowsTo (l₁ l₂ : Label) : Bool :=
  -- Every clause in l₁ must be covered by some clause in l₂
  -- with at least as many alternatives
  l₁.confidentiality.all (fun c₁ =>
    l₂.confidentiality.any (fun c₂ =>
      c₁.all (fun a => a ∈ c₂))) &&
  -- All integrity atoms in l₂ must be in l₁
  l₂.integrity.all (fun a => a ∈ l₁.integrity)

notation:50 l₁ " ⊑ " l₂ => Label.flowsTo l₁ l₂

/-- Add a confidentiality clause to a label -/
def Label.addClause (l : Label) (c : Clause) : Label :=
  { l with confidentiality := l.confidentiality ++ [c] }

/-- Add an integrity atom to a label -/
def Label.addIntegrity (l : Label) (a : Atom) : Label :=
  { l with integrity := if a ∈ l.integrity then l.integrity else l.integrity ++ [a] }

/-- Remove integrity atoms (meet operation result when combining) -/
def Label.removeIntegrity (l : Label) (atoms : List Atom) : Label :=
  { l with integrity := l.integrity.filter (fun a => a ∉ atoms) }

end CFC
