import Std

import Cfc.Access
import Cfc.Exchange

namespace Cfc

namespace Proofs
namespace Exchange

open Cfc

open Cfc.Exchange

/-
Proofs about exchange rules (`Cfc.Exchange`).

Spec connection:
- Exchange is the trusted mechanism that can rewrite confidentiality at boundaries based on
  integrity evidence.

Most of the proofs here establish *monotonicity*:

  If a principal `p` could access a label before an exchange rewrite,
  then `p` can still access the label after the rewrite.

In other words, these exchange rules never make something *less* accessible to a principal.

This is a useful baseline sanity property, and it also matches the intended use:
exchange rules are "permission widening" (add alternatives / drop guarded constraints),
not "permission narrowing".

The proofs are mostly simple list/CNF reasoning:
- adding an alternative to a clause can only make it easier to satisfy
- dropping clauses can only make it easier to satisfy the CNF
-/

/-
Helper: if `a` is a member of clause `c` and principal satisfies `a`,
then principal satisfies the clause.
-/
theorem clauseSat_of_mem_satisfies {p : Principal} {c : Clause} {a : Atom}
    (ha : a ∈ c) (hs : p.satisfies a) : clauseSat p c := by
  exact ⟨a, ha, hs⟩

/-
For singleton clauses, clause satisfaction is just atom satisfaction.

This is the "OR of one thing" simplification.
-/
theorem clauseSat_singleton_iff (p : Principal) (a : Atom) :
    clauseSat p [a] ↔ p.satisfies a := by
  constructor
  · intro h
    rcases h with ⟨a', ha', hs⟩
    have : a' = a := by
      simpa using ha'
    simpa [this] using hs
  · intro hs
    exact ⟨a, by simp, hs⟩

/-
Similarly, for a singleton CNF `[[a]]` (one clause, one atom),
`canAccessConf` reduces to satisfying `a`.
-/
theorem canAccessConf_singleton_singleton_iff (p : Principal) (a : Atom) :
    canAccessConf p [[a]] ↔ p.satisfies a := by
  constructor
  · intro h
    have hClause : clauseSat p [a] := h [a] (by simp)
    simpa [clauseSat_singleton_iff] using hClause
  · intro hs
    intro c hc
    have : c = [a] := by
      simpa using hc
    subst this
    exact (clauseSat_singleton_iff p a).2 hs

/-
Monotonicity of `clauseInsert`:

If `p` can satisfy clause `c`, then `p` can satisfy `clauseInsert alt c`.

Reason: `clauseInsert` either leaves `c` unchanged (if `alt` already present),
or adds an extra disjunct `alt`. Adding disjuncts cannot break satisfiability.
-/
theorem clauseSat_mono_clauseInsert (p : Principal) (alt : Atom) (c : Clause)
    (h : clauseSat p c) : clauseSat p (clauseInsert alt c) := by
  classical
  by_cases hmem : alt ∈ c
  · simp [clauseInsert, hmem, h]
  ·
    rcases h with ⟨a, ha, hs⟩
    exact ⟨a, by simp [clauseInsert, hmem, ha], hs⟩

/-
Monotonicity of `confAddAltFor`:

Adding an alternative inside clauses cannot reduce accessibility.
We prove this by mapping over the CNF and using `clauseSat_mono_clauseInsert` on each affected clause.
-/
theorem canAccessConf_mono_confAddAltFor (p : Principal) (target alt : Atom) (C : ConfLabel)
    (h : canAccessConf p C) : canAccessConf p (confAddAltFor target alt C) := by
  classical
  intro c hc
  rcases List.mem_map.1 hc with ⟨c0, hc0, rfl⟩
  by_cases htarget : target ∈ c0
  ·
    have : clauseSat p c0 := h c0 hc0
    simpa [confAddAltFor, htarget] using clauseSat_mono_clauseInsert p alt c0 this
  ·
    have : clauseSat p c0 := h c0 hc0
    simpa [confAddAltFor, htarget] using this

/-
Monotonicity of `confDropSingleton`:

Dropping clauses (filtering out `[a]`) can only make a CNF easier to satisfy.
Formally we show `confDropSingleton a C ⊆ C` and use `canAccessConf_of_subset`.
-/
theorem canAccessConf_mono_confDropSingleton (p : Principal) (a : Atom) (C : ConfLabel)
    (h : canAccessConf p C) : canAccessConf p (confDropSingleton a C) := by
  refine canAccessConf_of_subset (p := p) (C₁ := confDropSingleton a C) (C₂ := C) ?_ h
  intro c hc
  exact (List.mem_filter.1 hc).1

/-
Monotonicity of `exchangeAddAltIf`:

If the integrity guard fails, the exchange is the identity, so accessibility is unchanged.
If the guard succeeds, the exchange applies `confAddAltFor`, which we already proved monotone.
-/
theorem canAccessConf_mono_exchangeAddAltIf (p : Principal) (needInteg : List Atom)
    (target alt : Atom) (boundary : IntegLabel) (ℓ : Label)
    (h : canAccess p ℓ) : canAccess p (exchangeAddAltIf needInteg target alt boundary ℓ) := by
  classical
  let avail := availIntegrity ℓ boundary
  cases hNeed : hasAllB needInteg avail with
  | false =>
    simpa [exchangeAddAltIf, avail, hNeed] using h
  | true =>
    have : canAccessConf p (confAddAltFor target alt ℓ.conf) :=
      canAccessConf_mono_confAddAltFor p target alt ℓ.conf h
    simpa [exchangeAddAltIf, avail, hNeed, canAccess] using this

/-
Monotonicity of `exchangeDropSingletonIf`:
same structure as the previous lemma, but using `confDropSingleton`.
-/
theorem canAccessConf_mono_exchangeDropSingletonIf (p : Principal) (needInteg : List Atom)
    (a : Atom) (boundary : IntegLabel) (ℓ : Label)
    (h : canAccess p ℓ) : canAccess p (exchangeDropSingletonIf needInteg a boundary ℓ) := by
  classical
  let avail := availIntegrity ℓ boundary
  cases hNeed : hasAllB needInteg avail with
  | false =>
    simpa [exchangeDropSingletonIf, avail, hNeed] using h
  | true =>
    have : canAccessConf p (confDropSingleton a ℓ.conf) :=
      canAccessConf_mono_confDropSingleton p a ℓ.conf h
    simpa [exchangeDropSingletonIf, avail, hNeed, canAccess] using this

/-
Monotonicity of `exchangeSpaceReader`:

This exchange maps over clauses and sometimes inserts `User(acting)` as an alternative.
In both the "no insert" and "insert" cases, satisfiability is preserved.
-/
theorem canAccessConf_mono_exchangeSpaceReader (p : Principal) (acting : String)
    (boundary : IntegLabel) (ℓ : Label)
    (h : canAccess p ℓ) : canAccess p (exchangeSpaceReader acting boundary ℓ) := by
  classical
  unfold canAccess at h ⊢
  intro c hc
  rcases List.mem_map.1 hc with ⟨c0, hc0, rfl⟩
  have hClause : clauseSat p c0 := h c0 hc0
  cases hRole : clauseHasSpaceReaderB acting (availIntegrity ℓ boundary) c0 with
  | false =>
    simpa [exchangeSpaceReader, availIntegrity, hRole] using hClause
  | true =>
    have : clauseSat p (clauseInsert (.user acting) c0) :=
      clauseSat_mono_clauseInsert p (.user acting) c0 hClause
    simpa [exchangeSpaceReader, availIntegrity, hRole] using this

end Exchange
end Proofs

end Cfc
