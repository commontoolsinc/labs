import Std

import Cfc.Access
import Cfc.Policy

namespace Cfc

/-!
Trusted boundaries and egress checks (spec Chapters 4/5/11).

The spec emphasizes a separation of concerns:

* Untrusted pattern code computes values.
* The trusted runtime propagates labels and enforces policies.
* At **trusted boundaries** (display, network egress, store write), the runtime:
    1) evaluates policy exchange rules (to a fixpoint), using boundary-minted integrity facts, then
    2) checks that the boundary principal can access the (possibly rewritten) label.

This file packages that pattern into a small interface that we can reuse in proofs/examples.
-/

namespace Egress

open Cfc.Policy

/-!
## Boundary model

We model a boundary by:
- `fuel`: how many iterations of exchange-rule evaluation we allow (bounded execution),
- `integrity`: integrity evidence minted/available at the boundary (e.g. AuthorizedRequest, attestation),
- `principal`: the access-context principal for the boundary (e.g. the acting user + capabilities).

This is deliberately tiny. A full runtime would have richer structure (destinations, logging, etc.).
-/

structure Boundary where
  fuel : Nat
  integrity : IntegLabel
  principal : Principal
  deriving Repr

def evalAtBoundary (policies : List PolicyRecord) (b : Boundary) (ℓ : Label) : Label :=
  Policy.evalFixpoint b.fuel policies b.integrity ℓ

def allowed (policies : List PolicyRecord) (b : Boundary) (ℓ : Label) : Prop :=
  canAccess b.principal (evalAtBoundary policies b ℓ)

end Egress

end Cfc

