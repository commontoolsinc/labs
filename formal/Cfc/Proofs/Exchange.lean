import Std

import Cfc.Access
import Cfc.Exchange

namespace Cfc

namespace Proofs
namespace Exchange

open Cfc

open Cfc.Exchange

theorem clauseSat_of_mem_satisfies {p : Principal} {c : Clause} {a : Atom}
    (ha : a ∈ c) (hs : p.satisfies a) : clauseSat p c := by
  exact ⟨a, ha, hs⟩

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

theorem clauseSat_mono_clauseInsert (p : Principal) (alt : Atom) (c : Clause)
    (h : clauseSat p c) : clauseSat p (clauseInsert alt c) := by
  classical
  by_cases hmem : alt ∈ c
  · simp [clauseInsert, hmem, h]
  ·
    rcases h with ⟨a, ha, hs⟩
    exact ⟨a, by simp [clauseInsert, hmem, ha], hs⟩

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

theorem canAccessConf_mono_confDropSingleton (p : Principal) (a : Atom) (C : ConfLabel)
    (h : canAccessConf p C) : canAccessConf p (confDropSingleton a C) := by
  refine canAccessConf_of_subset (p := p) (C₁ := confDropSingleton a C) (C₂ := C) ?_ h
  intro c hc
  exact (List.mem_filter.1 hc).1

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
