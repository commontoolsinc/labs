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

def evalD (env : Env) (pc : ConfLabel) : ExprD → LVal
  | .lit b =>
      { val := b
        lbl := { conf := pc, integ := [] } }
  | .var x =>
      taint pc (env x)
  | .not e =>
      let v := evalD env pc e
      { val := (!v.val)
        lbl := v.lbl }
  | .and e₁ e₂ =>
      let v₁ := evalD env pc e₁
      let v₂ := evalD env pc e₂
      { val := v₁.val && v₂.val
        lbl := v₁.lbl + v₂.lbl }
  | .ite c t e =>
      let vc := evalD env pc c
      let pc' := pc ++ vc.lbl.conf
      if vc.val then evalD env pc' t else evalD env pc' e
  | .endorseIf tok guard x =>
      let vg := evalD env pc guard
      -- The endorsement decision is control-flow; propagate its flow-path confidentiality.
      let pc' := pc ++ vg.lbl.conf
      let vx := evalD env pc' x
      if vg.val then
        { vx with lbl := Label.endorse vx.lbl [tok] }
      else
        vx
  | .declassifyIf tok guard secret =>
      let vg := evalD env pc guard
      let vs := evalD env pc secret
      if tok ∈ vg.lbl.integ then
        -- Declassify the *data* label, but preserve flow-path confidentiality via `pc`.
        { val := vs.val
          lbl := { conf := pc, integ := vs.lbl.integ } }
      else
        -- No guard => no rewrite (no silent downgrade).
        vs

def evalD0 (env : Env) (e : ExprD) : LVal :=
  evalD env [] e

end Cfc
