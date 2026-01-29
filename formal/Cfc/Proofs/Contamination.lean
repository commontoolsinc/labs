import Std

import Cfc.Contamination

namespace Cfc

/-!
Proofs / examples for contamination scoping (spec 8.14).

This file is intentionally example-driven. The spec calls contamination scoping an "open problem",
so we treat this as a *candidate design* and validate that it has the intended algebraic behavior.

The main thing we want to ensure:

  Evidence minted in step A should not silently "recombine" with evidence minted in step B.

The mechanism is scoped integrity atoms + integrity intersection (`joinIntegrity`).
This is the same core trick used for projection scoping in spec 8.3.
-/

namespace Proofs
namespace Contamination

open Cfc.Contamination

/-!
## Sanity checks for `scopeAtom` / `scopeIntegrity`
-/

example (step : String) :
    scopeIntegrity (stepScope step) [trustedScope, injectionSafe] =
      [trustedScope, scopedInjectionSafe step] := by
  -- `trustedScope` is preserved, other atoms are wrapped in `Atom.scoped`.
  -- Important: do *not* unfold `injectionSafe` here, so that the lemma
  -- `injectionSafe_not_eq_trusted : injectionSafe ≠ trustedScope` matches.
  simp [scopeIntegrity, scopeAtom, stepScope, scopedInjectionSafe,
    injectionSafe_not_eq_trusted]

/-!
## Core regression: recombining two steps drops scoped evidence

Let both steps claim `InjectionSafe`, but with *different* step scopes.
Then the integrity join (intersection) should drop both claims, because they are different atoms:

  scoped(stepA, InjectionSafe)  ≠  scoped(stepB, InjectionSafe)
-/

def Istep (step : String) : IntegLabel :=
  scopeIntegrity (stepScope step) [injectionSafe]

example (a b : String) (h : a ≠ b) :
    Label.joinIntegrity (Istep a) (Istep b) = [] := by
  classical
  -- Expand the definitions. Each `Istep step` is a singleton list containing a scoped atom.
  unfold Istep Contamination.scopeIntegrity Contamination.scopeAtom Contamination.stepScope
  -- `joinIntegrity` is intersection, implemented as a `filter` by membership in the RHS list.
  --
  -- For a singleton list, the result is either `[]` (if the element is not in the RHS)
  -- or `[elem]` (if it is in the RHS). Here we show it is *not* in the RHS, because the
  -- scopes `["step", a]` and `["step", b]` are different when `a ≠ b`.
  simp [Label.joinIntegrity, injectionSafe_not_eq_trusted, h]

/-!
## Within one step, scoped evidence is stable under intersection

If both values carry the same scoped integrity atom (same scope), then intersection keeps it.
-/

example (step : String) :
    scopedInjectionSafe step ∈ Label.joinIntegrity (Istep step) (Istep step) := by
  classical
  -- `joinIntegrity` membership is "in both lists".
  have : scopedInjectionSafe step ∈ Istep step ∧ scopedInjectionSafe step ∈ Istep step := by
    constructor <;> simp [Istep, Contamination.scopeIntegrity, Contamination.scopeAtom,
      scopedInjectionSafe, stepScope, injectionSafe_not_eq_trusted]
  exact (Label.mem_joinIntegrity _ _ _).2 this

end Contamination
end Proofs

end Cfc
