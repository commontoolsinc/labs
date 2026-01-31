import Std

import Cfc.Label

namespace Cfc

/-!
Contamination scoping (spec 8.14, "open problem").

The spec frames "contamination" (e.g. prompt injection risk) as *absence of integrity evidence*:

  - Data starts with *no* integrity claims (unknown safety).
  - Trusted validators can *add* integrity atoms such as `InjectionSafe(...)`.

The open problem is *ergonomics* in reactive pipelines:

  If one step reads low-integrity data, that "contamination" can cascade and poison subsequent
  steps unless you either:
  - re-validate constantly, or
  - introduce some notion of "blast radius" / scoping.

This file proposes a minimal, formalizable core for "blast radius isolation" that reuses an
existing mechanism already present in the spec and this repo: **scoped integrity atoms**.

High-level idea:

* Every pipeline step has a scope identifier (a list of strings, like a JSON-path).
* When a step produces integrity evidence, we scope it:

      a  becomes  scoped stepScope a

  so that evidence from step A cannot be accidentally reused as if it applied in step B.

* Because integrity "join" in CFC is intersection, scoped evidence from *different* scopes will
  not survive recombination. This prevents "recombination" of trust across steps by accident.

This is intentionally conservative and does not claim to be the final design from the spec.
It is a concrete starting point that we can test with Lean lemmas and examples.
-/

namespace Contamination

/-- A scope identifier, represented like other "paths" in the repo. -/
abbrev Scope := List String

/--
Scope a single integrity atom.

We treat `trustedScope` specially: it represents trusted runtime control-flow evidence.
If we scoped it, then robust declassification / endorsement checks that rely on
`trustedScope ∈ pcI` would stop working across steps.

So the rule is:
- scope everything *except* `trustedScope`.
-/
def scopeAtom (scope : Scope) (a : Atom) : Atom :=
  if a = trustedScope then a else Atom.scoped scope a

/--
Scope an integrity label for a particular step.

This is the core "blast radius" operation: it turns unscoped evidence into step-scoped evidence.
-/
def scopeIntegrity (scope : Scope) (I : IntegLabel) : IntegLabel :=
  I.map (scopeAtom scope)

@[simp] theorem scopeAtom_trusted (scope : Scope) :
    scopeAtom scope trustedScope = trustedScope := by
  simp [scopeAtom]

@[simp] theorem scopeAtom_nontrusted {scope : Scope} {a : Atom} (h : a ≠ trustedScope) :
    scopeAtom scope a = Atom.scoped scope a := by
  simp [scopeAtom, h]

/-!
## Core property: scoping prevents accidental reuse across scopes

The key observation is purely algebraic:

* Integrity join is intersection (`Label.joinIntegrity`).
* `Atom.scoped s a` is a *different atom* from `Atom.scoped s' a` if `s ≠ s'`.
* Therefore, scoped claims from different scopes do not survive intersection.

This is the exact same mechanism used for projection scoping (spec 8.3).
-/

theorem not_mem_joinIntegrity_of_scoped_mismatch
    {a : Atom} {s₁ s₂ : Scope} (h : s₁ ≠ s₂)
    (I₁ I₂ : IntegLabel) :
    Atom.scoped s₁ a ∉ Label.joinIntegrity (scopeIntegrity s₁ I₁) (scopeIntegrity s₂ I₂) := by
  classical
  -- Suppose it *were* in the intersection. Then it would have to appear in the second list.
  intro hMem
  have hBoth : Atom.scoped s₁ a ∈ scopeIntegrity s₁ I₁ ∧ Atom.scoped s₁ a ∈ scopeIntegrity s₂ I₂ :=
    (Label.mem_joinIntegrity _ _ _).1 hMem
  -- But membership in the second scoped list means it must be equal to `scopeAtom s₂ x` for some `x`,
  -- i.e. either `trustedScope` or `Atom.scoped s₂ x`.
  --
  -- In either case, it cannot equal `Atom.scoped s₁ a` unless `s₁ = s₂`.
  --
  -- We discharge this by rewriting membership in a `map` into an existential over the source list.
  rcases List.mem_map.1 hBoth.2 with ⟨x, hxMem, hxEq⟩
  -- Unfold what `scopeAtom` did.
  by_cases hx : x = trustedScope
  · subst hx
    -- `scopeAtom s₂ trustedScope = trustedScope`, so we'd get `trustedScope = Atom.scoped s₁ a`, impossible.
    have : trustedScope = Atom.scoped s₁ a := by
      simpa [scopeAtom] using hxEq
    cases this
  ·
    -- In the non-trusted case, `scopeAtom s₂ x = Atom.scoped s₂ x`.
    have : Atom.scoped s₂ x = Atom.scoped s₁ a := by
      -- Rewrite the left-hand side of `hxEq` (which is `scopeAtom s₂ x`) using `hx`.
      simpa [scopeAtom, hx] using hxEq
    -- Two `scoped` atoms are equal only if both the scope and the inner atom are equal.
    -- From this equality we extract `s₂ = s₁`, contradicting `h`.
    have hs : s₂ = s₁ := by
      injection this with hs _
    exact h (hs.symm)

/-!
## A tiny "pipeline step" interface

To make the scoping story concrete, we define a helper for producing step-scoped evidence.

This is not a full FRP semantics; it is just enough structure to state "step A's evidence is not
mistaken for step B's evidence".
-/

def stepScope (stepName : String) : Scope :=
  ["step", stepName]

def injectionSafe : Atom :=
  Atom.integrityTok "InjectionSafe"

def scopedInjectionSafe (stepName : String) : Atom :=
  Atom.scoped (stepScope stepName) injectionSafe

theorem injectionSafe_not_eq_trusted : injectionSafe ≠ trustedScope := by
  -- They are different constructors (`integrityTok` with different strings).
  decide

theorem scopedInjectionSafe_eq_scopeAtom (stepName : String) :
    scopedInjectionSafe stepName = scopeAtom (stepScope stepName) injectionSafe := by
  simp [scopedInjectionSafe, scopeAtom, injectionSafe_not_eq_trusted]

end Contamination

end Cfc
