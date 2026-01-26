import Std

import Cfc.Intent

namespace Cfc

namespace Proofs
namespace Intent

open Cfc

theorem not_mem_eraseOnce_of_nodup {tok : Atom} {s : IntentStore}
    (hs : s.Nodup) :
    tok ∉ Cfc.Intent.eraseOnce tok s := by
  induction s with
  | nil =>
    simp [Cfc.Intent.eraseOnce]
  | cons a as ih =>
    cases hs with
    | cons ha hsTail =>
      by_cases hEq : tok = a
      · -- We remove `a`, so show `a` isn't in the tail (Nodup premise).
        subst hEq
        have : tok ∉ as := by
          intro hmem
          exact (ha tok hmem) rfl
        simpa [Cfc.Intent.eraseOnce] using this
      ·
        -- We keep `a`; reduce to the tail.
        have ht : tok ∉ Cfc.Intent.eraseOnce tok as := ih hsTail
        simp [Cfc.Intent.eraseOnce, hEq, ht]

theorem consumeOnce_eq_none_iff {tok : Atom} {s : IntentStore} :
    Cfc.Intent.consumeOnce tok s = none ↔ tok ∉ s := by
  by_cases h : tok ∈ s <;> simp [Cfc.Intent.consumeOnce, h]

theorem tok_not_mem_of_consumeOnce_some {tok : Atom} {s s' : IntentStore}
    (hs : s.Nodup)
    (h : Cfc.Intent.consumeOnce tok s = some s') :
    tok ∉ s' := by
  by_cases hmem : tok ∈ s
  ·
    -- `consumeOnce` returns `eraseOnce` in the `tok ∈ s` case.
    have hs' : s' = Cfc.Intent.eraseOnce tok s := by
      simpa [Cfc.Intent.consumeOnce, hmem] using h.symm
    subst hs'
    exact not_mem_eraseOnce_of_nodup (tok := tok) hs
  ·
    -- Contradiction: `consumeOnce` would be `none`.
    have : Cfc.Intent.consumeOnce tok s = none := (consumeOnce_eq_none_iff (tok := tok) (s := s)).2 hmem
    simp [this] at h

theorem commitOnce_no_consume_on_failure (tok : Atom) (s : IntentStore) :
    Cfc.Intent.commitOnce tok s false = some s := by
  simp [Cfc.Intent.commitOnce]

theorem commitOnce_single_use {tok : Atom} {s s' : IntentStore}
    (hs : s.Nodup)
    (hCommit : Cfc.Intent.commitOnce tok s true = some s') :
    Cfc.Intent.commitOnce tok s' true = none := by
  have hConsumed : Cfc.Intent.consumeOnce tok s = some s' := by
    simpa [Cfc.Intent.commitOnce] using hCommit
  have hNotMem : tok ∉ s' := tok_not_mem_of_consumeOnce_some (tok := tok) (s := s) (s' := s') hs hConsumed
  have : Cfc.Intent.consumeOnce tok s' = none :=
    (consumeOnce_eq_none_iff (tok := tok) (s := s')).2 hNotMem
  simp [Cfc.Intent.commitOnce, this]

end Intent
end Proofs

end Cfc
