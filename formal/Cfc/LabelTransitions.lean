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

Key intuition:
- After projecting `.lat` and `.long`, the integrity atoms are distinct
  (`scoped ["lat"] GPSMeasurement` vs `scoped ["long"] GPSMeasurement`).
- Since integrity join is *intersection*, joining the two projections loses the claim
  that the pair is a valid GPS measurement (because there is no shared integrity atom).
-/
def scopeIntegrity (path : List String) (I : IntegLabel) : IntegLabel :=
  I.map (fun a => Atom.scoped path a)

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

end LabelTransition

end Cfc
