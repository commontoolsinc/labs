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

end Exchange
end Proofs

end Cfc
