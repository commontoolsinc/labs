import Std

import Cfc.Language

namespace Cfc

/-!
An extension of the tiny expression language with an integrity-guarded declassification.

This is a deliberately small model of CFC's "exchange/declassification requires integrity guard"
story (see `docs/specs/cfc/10-safety-invariants.md` invariants 3, 7, and 9).

Relationship to `Cfc.Language`:

- `Cfc.Language` models flow-path confidentiality (PC confidentiality) but has no declassification
  or endorsement. It is the setting for the classic non-interference theorem.

- This file adds two new constructs:
  - `endorseIf` (transparent endorsement)
  - `declassifyIf` (robust declassification)

and it refines the semantics by threading both:
- `pc : ConfLabel`  (flow-path confidentiality)
- `pcI : IntegLabel` (control integrity / trusted-control evidence)

Intuition:

- PC confidentiality (`pc`) says "what secrets influenced the control path?"
  It must be joined onto downstream values to avoid implicit-flow leaks.

- PC integrity (`pcI`) says "what integrity evidence supports believing this control path happened?"
  It blocks endorsement/declassification when the control decision is not trusted.

This is a simplified, proof-friendly version of the spec's robust declassification / transparent
endorsement story.
-/

inductive ExprD where
  | lit (b : Bool)
  | var (x : String)
  | not (e : ExprD)
  | and (e₁ e₂ : ExprD)
  | ite (c t e : ExprD)
  | endorseIf (tok : Atom) (guard : ExprD) (x : ExprD)
  | declassifyIf (tok : Atom) (guard : ExprD) (secret : ExprD)
  deriving Repr

/--
Evaluate an expression under:
- `pc` : flow-path confidentiality (program counter confidentiality)
- `pcI`: control integrity (what must be trusted to believe this control path occurred)

This is a tiny model of spec Sections 3.4 (PC integrity), 3.8.6 (robust declassification),
and 3.8.7 (transparent endorsement).
-/
/-
Semantics overview:

The evaluation function returns an `LVal` (boolean + label).

For most constructs, it behaves like `Cfc.Language.eval`:
- compute boolean value
- propagate labels via join, and propagate pc via branching

Two important differences:

1) We thread `pcI : IntegLabel` in addition to `pc : ConfLabel`.
   - Reading a variable joins the variable's integrity into `pcI`.
     (If a control decision depends on an input with low integrity, then that control decision is low-integrity.)

2) We model two policy-relevant operations:
   - `endorseIf tok guard x` can *add* integrity `tok` to the result,
     but only if the guard is true AND the updated pc-integrity is trusted (`TrustedScope ∈ pcI'`).
   - `declassifyIf tok guard secret` can *rewrite* confidentiality of the result,
     but only if the guard carries integrity token `tok` AND the ambient pc-integrity is trusted.

Notice the asymmetry:
- endorsement checks `TrustedScope ∈ pcI'` (which includes guard integrity),
  because endorsement depends on the guard decision.
- declassification checks `TrustedScope ∈ pcI` (pre-guard),
  because declassification is supposed to be robust to attacker influence on the guard.

The proofs in `Cfc.Proofs.*` connect these checks to the spec's safety invariants.
-/
def evalD (env : Env) (pc : ConfLabel) (pcI : IntegLabel) : ExprD → LVal
  | .lit b =>
      { val := b
        lbl := { conf := pc, integ := pcI } }
  | .var x =>
      let v := taint pc (env x)
      { v with
        lbl := { v.lbl with integ := Label.joinIntegrity (env x).lbl.integ pcI } }
  | .not e =>
      let v := evalD env pc pcI e
      { val := (!v.val)
        lbl := v.lbl }
  | .and e₁ e₂ =>
      let v₁ := evalD env pc pcI e₁
      let v₂ := evalD env pc pcI e₂
      { val := v₁.val && v₂.val
        lbl := v₁.lbl + v₂.lbl }
  | .ite c t e =>
      let vc := evalD env pc pcI c
      let pc' := pc ++ vc.lbl.conf
      let pcI' := Label.joinIntegrity pcI vc.lbl.integ
      if vc.val then evalD env pc' pcI' t else evalD env pc' pcI' e
  | .endorseIf tok guard x =>
      let vg := evalD env pc pcI guard
      -- The endorsement decision is control-flow; propagate its flow-path confidentiality.
      let pc' := pc ++ vg.lbl.conf
      let pcI' := Label.joinIntegrity pcI vg.lbl.integ
      let vx := evalD env pc' pcI' x
      if vg.val then
        if trustedScope ∈ pcI' then
          { vx with lbl := Label.endorse vx.lbl [tok] }
        else
          vx
      else
        vx
  | .declassifyIf tok guard secret =>
      let vg := evalD env pc pcI guard
      -- The declassification decision is still control-flow; propagate its flow-path confidentiality.
      let pc' := pc ++ vg.lbl.conf
      let vs := evalD env pc' pcI secret
      if tok ∈ vg.lbl.integ then
        if trustedScope ∈ pcI then
          -- Declassify the *data* label, but preserve flow-path confidentiality via `pc` (and any
          -- confidentiality on the evidence itself, which would otherwise create a covert channel).
          { val := vs.val
            lbl := { conf := pc', integ := vs.lbl.integ } }
        else
          vs
      else
        -- No guard => no rewrite (no silent downgrade).
        vs

/-
Convenience: evaluate with empty pc and empty pc-integrity.
This corresponds to "top-level" evaluation with no prior control-flow taint.
-/
def evalD0 (env : Env) (e : ExprD) : LVal :=
  evalD env [] [] e

end Cfc
