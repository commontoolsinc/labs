import Std

import Cfc.Label

namespace Cfc

/-!
Spec Chapter 8 label transitions.

This file models the trusted-runtime label propagation rules (not handler code):
- pass-through / reference preservation
- projection scoping (8.3)
- exact copy verification (8.4)

We thread `pc` (flow-path confidentiality) explicitly; the spec requires it to be joined onto
downstream outputs (8.9).
-/

namespace LabelTransition

/-- Join flow-path confidentiality onto a label (spec 8.9). -/
def taintPc (pc : ConfLabel) (ℓ : Label) : Label :=
  { ℓ with conf := pc ++ ℓ.conf }

@[simp] theorem conf_taintPc (pc : ConfLabel) (ℓ : Label) :
    (taintPc pc ℓ).conf = pc ++ ℓ.conf := rfl

@[simp] theorem integ_taintPc (pc : ConfLabel) (ℓ : Label) :
    (taintPc pc ℓ).integ = ℓ.integ := rfl

/-- Pass-through: preserve the input label (8.2), plus flow-path confidentiality. -/
def passThrough (pc : ConfLabel) (input : Label) : Label :=
  taintPc pc input

/-- Scope integrity atoms to a projection path (8.3.2). -/
def scopeIntegrity (path : List String) (I : IntegLabel) : IntegLabel :=
  I.map (fun a => Atom.scoped path a)

/-- Projection transition: confidentiality inherited, integrity scoped (8.3). -/
def projection (pc : ConfLabel) (input : Label) (path : List String) : Label :=
  taintPc pc { conf := input.conf, integ := scopeIntegrity path input.integ }

@[simp] theorem conf_projection (pc : ConfLabel) (input : Label) (path : List String) :
    (projection pc input path).conf = pc ++ input.conf := rfl

@[simp] theorem integ_projection (pc : ConfLabel) (input : Label) (path : List String) :
    (projection pc input path).integ = scopeIntegrity path input.integ := rfl

/--
Exact-copy verification (8.4): the runtime checks content-addressed equality.

We model this as a reference equality check on an abstract `Ref` type.
If the check fails, the output is rejected (`none`).
-/
def exactCopyOf {Ref : Type} [DecidableEq Ref]
    (pc : ConfLabel) (inputRef outputRef : Ref) (input : Label) : Option Label :=
  if inputRef = outputRef then
    some (passThrough pc input)
  else
    none

/-- Combine multiple input labels (8.6): CNF concatenation, integrity intersection, plus flow taint. -/
def combinedFrom (pc : ConfLabel) (inputs : List Label) : Label :=
  match inputs with
  | [] => taintPc pc Label.bot
  | ℓ :: rest =>
      taintPc pc (rest.foldl (fun acc x => acc + x) ℓ)

end LabelTransition

end Cfc
