import Std

import Cfc.Language

namespace Cfc

/-!
An extension of the tiny expression language with an integrity-guarded declassification.

This is a deliberately small model of CFC's "exchange/declassification requires integrity guard"
story (see `docs/specs/cfc/10-safety-invariants.md` invariants 3 and 7).
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
      let vs := evalD env pc pcI secret
      if tok ∈ vg.lbl.integ then
        if trustedScope ∈ pcI then
          -- Declassify the *data* label, but preserve flow-path confidentiality via `pc` (and any
          -- confidentiality on the evidence itself, which would otherwise create a covert channel).
          { val := vs.val
            lbl := { conf := pc ++ vg.lbl.conf, integ := vs.lbl.integ } }
        else
          vs
      else
        -- No guard => no rewrite (no silent downgrade).
        vs

def evalD0 (env : Env) (e : ExprD) : LVal :=
  evalD env [] [] e

end Cfc
