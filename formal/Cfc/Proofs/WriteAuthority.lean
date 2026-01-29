import Std

import Cfc.WriteAuthority
import Cfc.Proofs.Store

namespace Cfc

/-!
Proofs and examples for write authority (spec 8.15).

This file is meant as an "executable spec test" in Lean:
we model the core checks from 8.15 and then walk through the canonical counter example.

The key points from the spec we validate here:

1. Authorization is keyed by handler identity (a code hash).
2. Pattern-level schemas compose write-authority sets via union.
3. Write authority is stable: successful modifications do not change the authority set.
4. Write authority is orthogonal to store-label monotonicity: on an authorized write, we still
   upgrade the store label conservatively (Spec 8.12).
-/

namespace Proofs
namespace WriteAuthority

open Cfc.WriteAuthority

/-!
## Concrete handler identities

We use short strings for identities. In the real system these would be code hashes.
-/

def inc : Handler := { id := "sha256:increment-handler" }
def dec : Handler := { id := "sha256:decrement-handler" }
def reset : Handler := { id := "sha256:reset-handler" }

/-!
## Counter field schema (pattern-composed)

This corresponds to spec 8.15.7:
`count` may be modified by Increment and Decrement, but not by Reset.
-/

def countSchema : FieldSchema :=
  { writeAuthorizedBy := [inc.id, dec.id] }

example : authorizeWriteB inc countSchema = true := by
  -- `authorizeWriteB` is just `decide (inc.id ∈ writeAuthorizedBy)`.
  simp [authorizeWriteB, countSchema, inc]

example : authorizeWriteB reset countSchema = false := by
  simp [authorizeWriteB, countSchema, reset, inc, dec]

/-!
## Composition via union

Handlers declare `"writes": true` independently; pattern compilation collects those declarations.
As in the spec, we model this as a union of authority sets.

With lists, union is append, and membership in an append is an OR.
-/

def incOnly : FieldSchema := { writeAuthorizedBy := [inc.id] }
def decOnly : FieldSchema := { writeAuthorizedBy := [dec.id] }

example : authorizeWrite inc (union incOnly decOnly) := by
  apply authorizeWrite_union_left
  simp [authorizeWrite, incOnly, inc]

example : authorizeWrite dec (union incOnly decOnly) := by
  apply authorizeWrite_union_right
  simp [authorizeWrite, decOnly, dec]

/-!
## In-place modification: authorization + store-label monotonicity

We now connect write authority to the tiny store model from `Cfc.Store`.

We build a `StoreField Nat` for `count`, initialized to `0` with a public label.
Then:
- an authorized handler can modify it (result is `some ...`),
- an unauthorized handler is rejected (`none`),
- on success, the schema is preserved (write authority is stable),
- on success, the store label update is a valid store-label update (spec 8.12).
-/

def countField : StoreField Nat :=
  { value := 0
    label := Label.bot
    schema := countSchema }

example : modify inc 1 Label.bot countField ≠ none := by
  -- The check reduces to `decide (inc.id ∈ [inc.id, dec.id])`.
  unfold Cfc.WriteAuthority.modify
  simp [authorizeWriteB, countField, countSchema, inc, dec]

example : modify reset 1 Label.bot countField = none := by
  unfold Cfc.WriteAuthority.modify
  simp [authorizeWriteB, countField, countSchema, reset, inc, dec]

example {field' : StoreField Nat} :
    modify inc 1 Label.bot countField = some field' ->
      field'.schema = countField.schema := by
  intro hMod
  -- This is the formal "authority is stable" property (spec 8.15.3).
  simpa [countField] using (schema_modify_eq (h := inc) (newValue := (1 : Nat)) (dataLbl := Label.bot) (field := countField) (field' := field') hMod)

/-!
Finally, we show that the label update performed by `modify` is a valid store-label update.

This uses the lemma from `Cfc.Proofs.Store`:
`upgradeLabel` (join) always satisfies the monotonicity predicate `canUpdateStoreLabel`.

This connects the write-authority mechanism back to the core IFC store invariants (spec 8.12).
-/

example :
    StoreLabel.canUpdateStoreLabel countField.label (StoreLabel.upgradeLabel countField.label Label.bot) := by
  -- Reuse the already-proved lemma about `upgradeLabel`.
  simpa [countField] using Cfc.Proofs.StoreLabel.canUpdateStoreLabel_upgradeLabel countField.label Label.bot

end WriteAuthority
end Proofs

end Cfc
