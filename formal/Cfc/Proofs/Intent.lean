import Std

import Cfc.Intent

namespace Cfc

namespace Proofs
namespace Intent

open Cfc

/-
Proofs about the minimal intent-store model (`Cfc.Intent`).

Spec connection:
- Safety invariant 4: "IntentOnce is consumed at most once and only on commit".

We model intents as tokens in a list. The proofs here establish:
- erasing a token removes it (under `Nodup` assumptions),
- consuming/committing behaves as expected,
- committing successfully is single-use when the store has no duplicates.

Why the `Nodup` assumption?

If the store could contain duplicate tokens, then "consume once" could remove one copy but leave
another, violating the intended single-use semantics. In the full system, tokens are unique.
-/

/-
If the store has no duplicates (`Nodup`), then after `eraseOnce tok s` the token `tok` is not in the result.

Proof is by induction on the list `s`:
- empty list: trivial
- cons case: split on whether the head equals `tok`
  * if yes, we drop the head and use `Nodup` to show `tok` is not in the tail
  * if no, we keep the head and apply the IH to the tail
-/
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

/-
Characterize `consumeOnce` failure:

`consumeOnce tok s` returns `none` iff `tok` is not in `s`.

This is just unfolding the definition (`if tok ∈ s then ... else none`).
-/
theorem consumeOnce_eq_none_iff {tok : Atom} {s : IntentStore} :
    Cfc.Intent.consumeOnce tok s = none ↔ tok ∉ s := by
  by_cases h : tok ∈ s <;> simp [Cfc.Intent.consumeOnce, h]

/-
If `consumeOnce tok s = some s'` and the store is `Nodup`, then `tok` is not in `s'`.

Proof:
- If `tok ∈ s`, then `consumeOnce` returns `eraseOnce tok s`, and we use `not_mem_eraseOnce_of_nodup`.
- If `tok ∉ s`, then `consumeOnce` would be `none`, contradiction.
-/
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

/-
"No consume on failure" for `commitOnce`:

If `tok` is present but `committed = false`, then the store is unchanged (but we still return `some`).
-/
theorem commitOnce_no_consume_on_failure (tok : Atom) (s : IntentStore)
    (h : tok ∈ s) :
    Cfc.Intent.commitOnce tok s false = some s := by
  simp [Cfc.Intent.commitOnce, h]

/-
If the token is absent, `commitOnce` fails (`none`) regardless of the committed flag.
-/
theorem commitOnce_eq_none_of_not_mem (tok : Atom) (s : IntentStore) (committed : Bool)
    (h : tok ∉ s) :
    Cfc.Intent.commitOnce tok s committed = none := by
  simp [Cfc.Intent.commitOnce, h]

/-
Single-use property:

Assume `s` has no duplicates and committing succeeds once:
  commitOnce tok s true = some s'
Then committing again with the new store fails:
  commitOnce tok s' true = none

Proof sketch:
- In the `committed=true` case, `commitOnce` is equivalent to `consumeOnce`.
- Use `tok_not_mem_of_consumeOnce_some` to show `tok ∉ s'`.
- Then `commitOnce` fails on `s'` by `commitOnce_eq_none_of_not_mem`.
-/
theorem commitOnce_single_use {tok : Atom} {s s' : IntentStore}
    (hs : s.Nodup)
    (hCommit : Cfc.Intent.commitOnce tok s true = some s') :
    Cfc.Intent.commitOnce tok s' true = none := by
  have hConsumed : Cfc.Intent.consumeOnce tok s = some s' := by
    simpa [Cfc.Intent.commitOnce, Cfc.Intent.consumeOnce] using hCommit
  have hNotMem : tok ∉ s' := tok_not_mem_of_consumeOnce_some (tok := tok) (s := s) (s' := s') hs hConsumed
  exact commitOnce_eq_none_of_not_mem (tok := tok) (s := s') (committed := true) hNotMem

end Intent
end Proofs

end Cfc
