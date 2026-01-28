import Std

import Cfc.Access
import Cfc.LabelTransitions

namespace Cfc

/-!
Opaque inputs / blind data passing (spec 8.13).

The spec idea:

* Sometimes a handler wants to *route* or *decide* based on a small trusted piece of metadata
  (e.g. `priority`), while still forwarding a large untrusted payload (e.g. `email.body`).
* If the handler can read the payload, then in a classic IFC setting its control-flow and outputs
  become "tainted" by that payload (both confidentiality and integrity concerns).
* The spec solution is an **opaque input** annotation:
    - the handler receives only a reference to the payload,
    - the runtime forbids reading the payload content,
    - but the handler may still *pass the reference through* to outputs.

What we model in Lean:

1. An `OpaqueRef α` carries *only*:
   - a reference id (`ref : Nat`) standing in for a content-addressed reference, and
   - a label (`lbl : Label`) describing who may read the underlying content and what integrity
     evidence it carries.

   Importantly, there is **no field of type `α`**. This is how we model "you cannot read the
   content": there simply is no function `OpaqueRef α → α` to call.

2. A pass-through rule for opaque references:
   - If you copy an opaque reference from input to output, the label should be preserved.
   - As usual in Chapter 8, we still taint by flow-path confidentiality `pc`.

This module intentionally does *not* attempt to model "fatal errors" for illegal reads.
In Lean, the absence of an accessor is a stronger guarantee than a runtime check.
-/

namespace Opaque

/--
An opaque reference to a value of type `α`.

`α` is a *phantom* type parameter: it documents what kind of thing this reference points to, but
it does not give you access to that thing.

This mirrors the spec's `OpaqueRef<T>`: you can carry it around and forward it, but you cannot
inspect the underlying `T`.
-/
structure OpaqueRef (α : Type) where
  /-- Stand-in for a content-addressed reference / digest. -/
  ref : Nat
  /-- The IFC label of the underlying value. -/
  lbl : Label
  deriving Repr

/--
Pass-through for opaque references (spec 8.13.4).

If a handler places an opaque reference in an output position *without reading it*, then the
output is still a reference to the same underlying data. The only additional information is the
flow-path confidentiality `pc` from the control path taken, so we just apply the standard
pass-through label transition to the underlying label.
-/
def passThrough (pc : ConfLabel) (x : OpaqueRef α) : OpaqueRef α :=
  { x with lbl := LabelTransition.passThrough pc x.lbl }

/-!
### Field-level simplification lemmas

These `[simp]` lemmas are "for the computer": they tell Lean's simplifier how to reduce the label
fields of `passThrough` when proving properties later.

They correspond exactly to the prose reading:
- confidentiality gets prefixed by `pc`,
- integrity is unchanged.
-/

@[simp] theorem lbl_passThrough (pc : ConfLabel) (x : OpaqueRef α) :
    (passThrough pc x).lbl = LabelTransition.passThrough pc x.lbl := rfl

@[simp] theorem conf_passThrough (pc : ConfLabel) (x : OpaqueRef α) :
    (passThrough pc x).lbl.conf = pc ++ x.lbl.conf := by
  -- Unfold once, then use the simp lemmas from `Cfc.LabelTransitions`.
  simp [passThrough, LabelTransition.passThrough]

@[simp] theorem integ_passThrough (pc : ConfLabel) (x : OpaqueRef α) :
    (passThrough pc x).lbl.integ = x.lbl.integ := by
  simp [passThrough, LabelTransition.passThrough, LabelTransition.taintPc]

end Opaque

end Cfc

