import Std

import Cfc.Opaque

namespace Cfc

/-!
Proofs and examples for opaque inputs (spec 8.13).

The spec claim we want to sanity-check is:

> "Handler integrity is NOT tainted by an opaque input's label."

In this Lean development we do not model full handler execution, but we can still capture the
essential IFC point:

* A computed output (like a routing destination) should depend only on *readable* inputs.
* An opaque input is not readable, so it should not be necessary for access to that computed output.
* Meanwhile, an output that *forwards* the opaque reference must inherit the opaque input's label.

Concretely, we build the canonical example from the spec:
- `priority` (readable metadata) influences a routing decision
- `body` (opaque content) is forwarded but not inspected

Then we prove that there exists a principal who can read the routing decision but cannot read the
opaque body. This is exactly what we want from IFC: the routing decision does not "inherit" the
body's confidentiality requirements.
-/

namespace Proofs
namespace Opaque

open Cfc.Opaque

/-!
## A tiny router model

We model two outputs:

1. `destLabel` is a computed value derived from *readable* metadata only.
   We use `LabelTransition.transformedFrom` to reflect "this is computed code", which mints a
   fresh integrity atom `TransformedBy(...)`.

2. `bodyOut` is a pass-through of the opaque reference.
   The handler does not read the content, but the output still points at the same underlying data,
   so the label must be preserved (up to `pc` confidentiality taint).
-/

def destLabel (pc : ConfLabel) (metaLbl : Label) : Label :=
  LabelTransition.transformedFrom pc "router" [] [metaLbl]

def bodyOut (pc : ConfLabel) (body : OpaqueRef String) : Label :=
  (Cfc.Opaque.passThrough pc body).lbl

/-!
## Access characterization lemmas

Because `canAccess` only depends on the confidentiality CNF, we can characterize access to both
outputs directly in terms of `canAccessConf`.

These lemmas are the "prose proof" of the key spec claim:
- `destLabel` requires satisfying `pc` and the metadata's confidentiality,
  but it does *not* mention the opaque body's confidentiality at all.
- `bodyOut` requires satisfying `pc` and the body's confidentiality (as expected for pass-through).
-/

theorem canAccess_destLabel_iff (p : Principal) (pc : ConfLabel) (metaLbl : Label) :
    canAccess p (destLabel pc metaLbl) ↔ canAccessConf p pc ∧ canAccessConf p metaLbl.conf := by
  -- Unfold the definitions:
  -- - `canAccess` is `canAccessConf` on the `conf` field.
  -- - `destLabel` uses `transformedFrom`, whose confidentiality is `pc ++ meta.conf` for a singleton input.
  --
  -- Then use the general lemma `canAccessConf_append_iff` from `Cfc.Access`.
  simp [destLabel, canAccess, canAccessConf_append_iff]

theorem canAccess_bodyOut_iff (p : Principal) (pc : ConfLabel) (body : OpaqueRef String) :
    canAccess p (bodyOut pc body) ↔ canAccessConf p pc ∧ canAccessConf p body.lbl.conf := by
  -- Same style: pass-through is just `taintPc` on the underlying label.
  simp [bodyOut, Cfc.Opaque.passThrough, LabelTransition.passThrough, LabelTransition.taintPc,
    canAccess, canAccessConf_append_iff]

/-!
## Worked example: read routing decision, but not the opaque body

We now pick concrete labels and a concrete principal.

* The routing decision is derived from `meta = Label.bot`, i.e. public metadata.
* The body label requires satisfying the atom `Atom.user "Alice"`.
* The principal we pick has *no* atoms, so they cannot satisfy `Atom.user "Alice"`.

Result:
- the principal can access `destLabel [] meta`,
- but cannot access `bodyOut [] body`.

This is a small but meaningful "integration test" for the opaque-input story:
opaque content does not become a precondition for seeing the routing decision.
-/

def publicMeta : Label := Label.bot

def secretBodyLabel : Label :=
  { conf := [[Atom.user "Alice"]], integ := [] }

def secretBody : OpaqueRef String :=
  { ref := 0, lbl := secretBodyLabel }

def unauthenticated : Principal :=
  { now := 0, atoms := [] }

example : canAccess unauthenticated (destLabel [] publicMeta) := by
  -- We use the characterization lemma above.
  --
  -- Intuitively:
  -- - `pc = []` means "no control-flow confidentiality taint".
  -- - `publicMeta.conf = []` because `publicMeta = Label.bot`.
  -- So a principal can access `destLabel [] publicMeta` vacuously.
  apply (canAccess_destLabel_iff (p := unauthenticated) (pc := []) (metaLbl := publicMeta)).2
  simp [publicMeta, canAccessConf, Label.bot]

example : ¬ canAccess unauthenticated (bodyOut [] secretBody) := by
  intro hAcc
  -- Use the characterization lemma for the pass-through output.
  have hParts :
      canAccessConf unauthenticated [] ∧ canAccessConf unauthenticated secretBody.lbl.conf :=
    (canAccess_bodyOut_iff (p := unauthenticated) (pc := []) (body := secretBody)).1 hAcc
  -- The `pc` part is irrelevant here (it is `[]`), so focus on the body confidentiality.
  have hClause : clauseSat unauthenticated [Atom.user "Alice"] := by
    -- The only clause in the CNF is `[Atom.user "Alice"]`.
    exact hParts.2 [Atom.user "Alice"] (by simp [secretBody, secretBodyLabel])
  rcases hClause with ⟨a, haMem, haSat⟩
  -- Membership in a singleton list means `a` must be that element.
  have : a = Atom.user "Alice" := by simpa using haMem
  subst this
  -- But `unauthenticated.atoms = []`, so it cannot satisfy `Atom.user "Alice"`.
  simp [Principal.satisfies, unauthenticated] at haSat

end Opaque
end Proofs

end Cfc
