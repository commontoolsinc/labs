import Std

import Cfc.Label

namespace Cfc

/-!
Spec Chapter 8 label transitions.

This is the first place in the repo where we model "label propagation" *as a runtime rule*,
rather than as a property of an evaluator (like the tiny expression language).

The mental model is:

- The handler/pattern code is *untrusted* to correctly propagate labels.
- The trusted runtime propagates labels based on schema annotations.
- Chapter 8 describes several "shapes" of data flow (pass-through, projection, etc.).

We therefore define small, explicit transition functions that compute an *output label*
from one or more *input labels*, plus a separate `pc` argument:

- `pc : ConfLabel` is *flow-path confidentiality* (also called "PC confidentiality").
  It represents information revealed by *control flow* (branching, filtering, selection).
  The spec requires this to be joined onto downstream outputs (8.9).

Concretely, `pc` is a CNF confidentiality label, so "joining it onto an output"
means list concatenation (see `Cfc.Label`).
-/

namespace LabelTransition

/-
`taintPc` is the single most common operation in Chapter 8: it prefixes the output label
with the current flow-path confidentiality `pc`.

In our label algebra (`Cfc.Label`):
- confidentiality is CNF: `ConfLabel = List Clause` and join is `++`
- integrity is a conjunction of atoms: `IntegLabel = List Atom` and join is intersection

So "tainting by pc" means:
  output.conf = pc ++ output.conf
and output.integ is unchanged.
-/
def taintPc (pc : ConfLabel) (ℓ : Label) : Label :=
  { ℓ with conf := pc ++ ℓ.conf }

/-
These `[simp]` lemmas tell Lean's simplifier how to reduce fields of `taintPc`.

`rfl` means: "this is true by definition" (definitional equality).
-/
@[simp] theorem conf_taintPc (pc : ConfLabel) (ℓ : Label) :
    (taintPc pc ℓ).conf = pc ++ ℓ.conf := rfl

@[simp] theorem integ_taintPc (pc : ConfLabel) (ℓ : Label) :
    (taintPc pc ℓ).integ = ℓ.integ := rfl

/-
Pass-through (spec 8.2):

If an output value is just a *reference* to an input value, the label of the underlying data
does not change. The only new information is what was learned by control flow (pc), so the
transition is just `taintPc`.
-/
def passThrough (pc : ConfLabel) (input : Label) : Label :=
  taintPc pc input

/-
Projection scoping (spec 8.3):

When we project a field (e.g. `.lat`) out of a structured value, confidentiality is inherited,
but integrity becomes *scoped* to the field path.

We represent scoping by wrapping every integrity atom `a` as `Atom.scoped path a`.

In the full spec, scoped integrity also carries a reference to the *source* structured value
(the "valueRef"). To support safe recomposition (e.g. `/lat` and `/long` from the *same*
measurement), this file also provides a source-carrying variant:

  `Atom.scopedFrom source path a`

See `scopeIntegrityFrom` / `projectionFrom` / `recomposeFromProjections` below.

Key intuition:
- After projecting `.lat` and `.long`, the integrity atoms are distinct
  (`scoped ["lat"] GPSMeasurement` vs `scoped ["long"] GPSMeasurement`).
- Since integrity join is *intersection*, joining the two projections loses the claim
  that the pair is a valid GPS measurement (because there is no shared integrity atom).
-/
def scopeIntegrity (path : List String) (I : IntegLabel) : IntegLabel :=
  I.map (fun a => Atom.scoped path a)

/-
Source-carrying version of `scopeIntegrity`.

Here `source : Nat` stands in for the spec's `valueRef` / content-addressed reference of the
original structured value. By threading a `source` through scoped integrity, we can later prove
"recompose only if the parts came from the same source".
-/
def scopeIntegrityFrom (source : Nat) (path : List String) (I : IntegLabel) : IntegLabel :=
  I.map (fun a => Atom.scopedFrom source path a)

/-
Projection transition (spec 8.3):

1) Start from the input label.
2) Keep confidentiality the same (projection does not downgrade confidentiality).
3) Replace integrity by its scoped version.
4) Finally taint confidentiality by `pc` (because the *choice* to project can be control-flow).

This corresponds to the "output label is inherited from input, but with scoped integrity" story
in 8.3, plus the general PC-taint rule in 8.9.
-/
def projection (pc : ConfLabel) (input : Label) (path : List String) : Label :=
  taintPc pc { conf := input.conf, integ := scopeIntegrity path input.integ }

@[simp] theorem conf_projection (pc : ConfLabel) (input : Label) (path : List String) :
    (projection pc input path).conf = pc ++ input.conf := rfl

@[simp] theorem integ_projection (pc : ConfLabel) (input : Label) (path : List String) :
    (projection pc input path).integ = scopeIntegrity path input.integ := rfl

/-
Source-carrying projection rule (closer to spec 8.3.2).

This is the same as `projection`, except integrity atoms are scoped with the `source` id:
  scopedFrom source path a
-/
def projectionFrom (pc : ConfLabel) (input : Label) (source : Nat) (path : List String) : Label :=
  taintPc pc { conf := input.conf, integ := scopeIntegrityFrom source path input.integ }

@[simp] theorem conf_projectionFrom (pc : ConfLabel) (input : Label) (source : Nat) (path : List String) :
    (projectionFrom pc input source path).conf = pc ++ input.conf := rfl

@[simp] theorem integ_projectionFrom (pc : ConfLabel) (input : Label) (source : Nat) (path : List String) :
    (projectionFrom pc input source path).integ = scopeIntegrityFrom source path input.integ := rfl

/--
Exact-copy verification (8.4): the runtime checks content-addressed equality.

We model this as a reference equality check on an abstract `Ref` type.

- `Ref` stands in for "content-addressed reference / digest" in the spec.
- We assume `[DecidableEq Ref]` so we can *compute* the `if inputRef = outputRef then ...`.

If the check fails, the runtime rejects the handler output. We represent rejection with `none`,
and acceptance with `some outputLabel`.
-/
def exactCopyOf {Ref : Type} [DecidableEq Ref]
    (pc : ConfLabel) (inputRef outputRef : Ref) (input : Label) : Option Label :=
  if inputRef = outputRef then
    some (passThrough pc input)
  else
    none

/-
Combination (spec 8.6):

If an output depends on multiple inputs, its label is their join:
- confidentiality: CNF conjunction via concatenation
- integrity: intersection (only claims shared by all inputs survive)

We also taint by flow-path confidentiality `pc` at the end, because the act of combining
is still part of control flow.

Implementation detail:
- For a *nonempty* list, we fold `Label.join` (`+`) from the head.
- For an *empty* list, the spec situation is "no data dependency".
  We return `Label.bot` tainted by `pc` (i.e. confidentiality = `pc` and integrity empty).

Note: because integrity join is intersection, there is no real "identity element" that would
preserve arbitrary integrity when folding an empty list; returning `Label.bot` is a conservative,
simple choice for this minimal model.
-/
def combinedFrom (pc : ConfLabel) (inputs : List Label) : Label :=
  match inputs with
  | [] => taintPc pc Label.bot
  | ℓ :: rest =>
      taintPc pc (rest.foldl (fun acc x => acc + x) ℓ)

/-
Transformation (spec 8.7, and the default case in 8.9.2):

If the handler *computes* a new value, the runtime should not blindly preserve the inputs'
integrity claims. Instead it mints fresh integrity evidence of the form `TransformedBy(...)`.

We model this as:
- confidentiality: CNF-join of all input confidentiality, plus `pc` taint
- integrity: a single `Atom.transformedBy codeHash inputRefs`

Notes:
- We do not model actual values here, so `inputRefs : List Nat` is a stand-in for the spec's
  content-addressed references to the concrete input values.
- This is the conceptual dual of `combinedFrom`:
  `combinedFrom` preserves integrity only via intersection (meet),
  while `transformedFrom` discards input integrity and records provenance instead.
-/
def transformedFrom (pc : ConfLabel) (codeHash : String) (inputRefs : List Nat) (inputs : List Label) : Label :=
  taintPc pc
    { conf := inputs.foldl (fun acc ℓ => acc ++ ℓ.conf) []
      integ := [Atom.transformedBy codeHash inputRefs] }

@[simp] theorem conf_transformedFrom (pc : ConfLabel) (codeHash : String) (inputRefs : List Nat) (inputs : List Label) :
    (transformedFrom pc codeHash inputRefs inputs).conf =
      pc ++ (inputs.foldl (fun acc ℓ => acc ++ ℓ.conf) []) := rfl

@[simp] theorem integ_transformedFrom (pc : ConfLabel) (codeHash : String) (inputRefs : List Nat) (inputs : List Label) :
    (transformedFrom pc codeHash inputRefs inputs).integ = [Atom.transformedBy codeHash inputRefs] := rfl

/-
"Safe recomposition" of projections (not explicitly named in the spec, but motivated by 8.3.2).

The spec motivation for scoped integrity has two halves:
1) prevent *unsafe* recombination (mixing pieces from different sources), and
2) allow *safe* recombination when all pieces come from the same source.

We model the second part as a *checked* runtime rule:

- The schema can declare that an output object is a recomposition of several projections.
- The runtime verifies two things for each part:
  1) the part label carries the appropriate `scopedFrom source path base` atom, and
  2) (abstractly) the part value really is the projected field of the source object.

We do not model actual values in Lean, so we represent (2) by two `Nat` references:
`expectedRef` and `outputRef`. Think of them as content hashes; the check is `expectedRef = outputRef`.
- If the check passes, we allow the output to regain the integrity of the whole object,
  represented as `Atom.scopedFrom source [] base` (empty path = "whole object").
- If the check fails, the output is rejected (`none`), like `exactCopyOf`.

This is intentionally minimal: it only restores the *one* integrity atom `base`, and it does not
try to model all possible structured integrity fields from the spec.
-/
structure ProjectionPart where
  /-- The JSON-path-like projection identifier (e.g. `["lat"]`). -/
  path : List String
  /-- Reference (content hash) of the expected source field value. -/
  expectedRef : Nat
  /-- Reference (content hash) of the handler's output value for this part. -/
  outputRef : Nat
  /-- The label attached to the handler's output value for this part. -/
  label : Label
  deriving Repr

def verifyRecomposeProjections (source : Nat) (base : Atom) (parts : List ProjectionPart) : Bool :=
  parts.all (fun p =>
    decide (p.outputRef = p.expectedRef) &&
    decide (Atom.scopedFrom source p.path base ∈ p.label.integ))

def recomposeFromProjections (pc : ConfLabel) (source : Nat) (base : Atom)
    (parts : List ProjectionPart) : Option Label :=
  if verifyRecomposeProjections source base parts then
    let out := combinedFrom pc (parts.map (fun p => p.label))
    some { out with integ := out.integ ++ [Atom.scopedFrom source [] base] }
  else
    none

end LabelTransition

end Cfc
