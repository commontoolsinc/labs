import Std

import Cfc.Store

namespace Cfc

/-!
Proofs for store label monotonicity (spec 8.12).

This file is intentionally "prose heavy": the goal is to make the Lean statements line up with the
spec's claims and to explain why the proofs are straightforward once the right relations are
defined.

What we want to capture from the spec:

1) Store labels can only get stricter in confidentiality (CNF becomes harder to satisfy).
2) Store labels can only get weaker in integrity (fewer claims over time).
3) Therefore: if a principal can read a store after an update, they could also have read it before
   the update (no new readers are introduced by label evolution).

The core relations and lemmas live in `Cfc.Store`:
- `StoreLabel.ConfLe`: CNF "more restrictive" relation
- `StoreLabel.IntegLe`: integrity subset
- `StoreLabel.canUpdateStoreLabel`: the combined store-label update predicate
- `StoreLabel.canAccess_mono_of_canUpdateStoreLabel`: the main access monotonicity lemma

Here we add two extra pieces:
- show that the conservative "upgrade by join" operation is always a valid store-label update, and
- add a small `expires` example to sanity-check the special time-based ordering.
-/

namespace Proofs
namespace StoreLabel

open Cfc.StoreLabel

/-!
## Upgrading a store label by joining in the data label is always safe

The spec's store-label rule is permissive: you can tighten labels in many ways.
One very simple safe strategy is:

  newStoreLabel := oldStoreLabel + dataLabel

Because:
- confidentiality join is CNF conjunction (append clauses), which can only add restrictions
- integrity join is intersection, which can only remove claims

This lemma is the bridge between the abstract monotonicity condition and a concrete update policy.
-/

theorem ConfLe_append_left (C D : ConfLabel) : ConfLe C (C ++ D) := by
  intro c hc
  refine ⟨c, ?_, ?_⟩
  · exact List.mem_append.2 (Or.inl hc)
  · exact ClauseLe_refl c

theorem IntegLe_joinIntegrity_left (I₁ I₂ : IntegLabel) : IntegLe (Label.joinIntegrity I₁ I₂) I₁ := by
  intro a ha
  have : a ∈ I₁ ∧ a ∈ I₂ := (Label.mem_joinIntegrity a I₁ I₂).1 ha
  exact this.1

theorem canUpdateStoreLabel_upgradeLabel (storeLbl dataLbl : Label) :
    canUpdateStoreLabel storeLbl (upgradeLabel storeLbl dataLbl) := by
  constructor
  · -- confidentiality: `storeLbl.conf` is a prefix of `(storeLbl + dataLbl).conf`
    simpa [upgradeLabel, Label.join] using ConfLe_append_left storeLbl.conf dataLbl.conf
  · -- integrity: intersection is a subset of the original integrity list
    simpa [upgradeLabel, Label.join, IntegLe] using IntegLe_joinIntegrity_left storeLbl.integ dataLbl.integ

/-!
## `expires` sanity check

The spec allows store labels to get stricter by tightening expiration:
`expires tNew` is stricter than `expires tOld` when `tNew <= tOld`.

Our `AtomLe` relation bakes that in, so the CNF monotonicity checker can accept:

  current.conf  = [[expires 10]]
  proposed.conf = [[expires 5]]

because `expires 5` implies `expires 10`.
-/

def lblExpires (t : Nat) : Label :=
  { conf := [[Atom.expires t]], integ := [] }

example : canUpdateStoreLabelB (lblExpires 10) (lblExpires 5) = true := by
  -- This is a "regression test": it should reduce by computation to `true`.
  -- The key step is `decide (5 <= 10) = true`.
  simp [lblExpires, canUpdateStoreLabelB, confLeB, clauseLeB, atomLeB, integLeB]

example (p : Principal) :
    canAccess p (lblExpires 5) -> canAccess p (lblExpires 10) := by
  intro hAcc
  have hUp : canUpdateStoreLabel (lblExpires 10) (lblExpires 5) := by
    apply canUpdateStoreLabel_of_canUpdateStoreLabelB
    simpa using (show canUpdateStoreLabelB (lblExpires 10) (lblExpires 5) = true from by
      simp [lblExpires, canUpdateStoreLabelB, confLeB, clauseLeB, atomLeB, integLeB])
  exact canAccess_mono_of_canUpdateStoreLabel (p := p) hUp hAcc

end StoreLabel
end Proofs

end Cfc
