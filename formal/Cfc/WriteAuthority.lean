import Std

import Cfc.Store

namespace Cfc

/-!
Modification authorization / write authority (spec 8.15).

Chapter 8 mostly discusses *computed outputs*:
inputs -> handler computes -> output.

Section 8.15 adds a different kind of operation: **in-place modification** of persistent state.
Instead of returning a fresh output value, a handler updates an existing stored value.

The core security question becomes:

  "Who is allowed to modify this field?"

In the spec, the unit of authorization is the handler identity (a code hash), and the schema of a
field records a `writeAuthorizedBy` set containing the identities of handlers allowed to modify it.

This file models just enough to write useful lemmas:

* `authorizeWrite` / `authorizeWriteB` checks membership of a handler id in a field's authority set.
* A simple "schema composition via union" operation.
* A tiny store-field update function `modify` that:
    - rejects unauthorized writes, and
    - preserves the write-authority set on success (authority is a schema property, not a value property).

We deliberately keep this separate from confidentiality/integrity label propagation:
write authority is an *additional gate* for modifications; it does not by itself define label joins.
-/

namespace WriteAuthority

/-!
## Identities and schemas

The spec models handler identity as a `CodeHash` principal atom.
For this minimal Lean development, a plain `String` is enough.
-/

abbrev HandlerId := String

structure Handler where
  /-- Stable identity of a handler (spec: code hash). -/
  id : HandlerId
  deriving Repr, DecidableEq

structure FieldSchema where
  /--
  The set (represented as a list) of handler identities authorized to modify this field.

  We use a list instead of a set to keep dependencies minimal.
  All interesting properties are phrased in terms of membership `id ∈ writeAuthorizedBy`.
  -/
  writeAuthorizedBy : List HandlerId
  deriving Repr, DecidableEq

/-!
## Authorization check

`authorizeWrite` is the spec-level proposition:
  "handler.id is in the field's authority set".

`authorizeWriteB` is the executable Boolean check.
We prove that `authorizeWriteB = true` implies the proposition (`authorizeWrite`).
-/

def authorizeWrite (h : Handler) (f : FieldSchema) : Prop :=
  h.id ∈ f.writeAuthorizedBy

def authorizeWriteB (h : Handler) (f : FieldSchema) : Bool :=
  -- An executable check: "does the list contain `h.id`?"
  --
  -- We implement this as `any (fun x => decide (x = h.id))`, which is computable because
  -- equality on `String` is computable.
  f.writeAuthorizedBy.any (fun x => decide (x = h.id))

theorem authorizeWrite_of_authorizeWriteB {h : Handler} {f : FieldSchema} :
    authorizeWriteB h f = true -> authorizeWrite h f := by
  intro hb
  -- Unfold the boolean check and use the standard characterization of `List.any = true`:
  -- it means there exists some list element for which the predicate is true.
  unfold authorizeWriteB at hb
  rcases List.any_eq_true.1 hb with ⟨x, hxMem, hxEq⟩
  have hx : x = h.id := of_decide_eq_true hxEq
  subst hx
  simpa [authorizeWrite] using hxMem

/-!
## Schema composition: union

Spec 8.15.2: when composing a pattern schema from multiple handler schemas, write-authority sets
compose via union.

With lists, "union" is modeled as append. Membership behaves like set union:
`x ∈ (A ++ B)` iff `x ∈ A ∨ x ∈ B`.
-/

def union (f₁ f₂ : FieldSchema) : FieldSchema :=
  { writeAuthorizedBy := f₁.writeAuthorizedBy ++ f₂.writeAuthorizedBy }

theorem authorizeWrite_union_left {h : Handler} {f₁ f₂ : FieldSchema} :
    authorizeWrite h f₁ -> authorizeWrite h (union f₁ f₂) := by
  intro hAuth
  -- Membership in an appended list: left branch.
  exact List.mem_append.2 (Or.inl hAuth)

theorem authorizeWrite_union_right {h : Handler} {f₁ f₂ : FieldSchema} :
    authorizeWrite h f₂ -> authorizeWrite h (union f₁ f₂) := by
  intro hAuth
  exact List.mem_append.2 (Or.inr hAuth)

/-!
## A tiny store-field model with write authority

We reuse the label/join machinery from `Cfc.Store`:
- a store field has a *store label* that must evolve monotonically (spec 8.12),
- a modification may upgrade the label conservatively via `StoreLabel.upgradeLabel` (join).

Write authority adds an orthogonal check: the handler must be authorized by the schema.
We keep the authority set as part of the field structure and prove it is unchanged by `modify`.
-/

structure StoreField (α : Type) where
  value : α
  label : Label
  schema : FieldSchema
  deriving Repr

/--
Attempt an in-place modification (spec 8.15.6).

If the handler is authorized, return the updated field:
- the value is replaced by `newValue`,
- the store label is conservatively upgraded by joining with `dataLbl`,
- the write-authority schema is preserved *unchanged*.

If the handler is not authorized, return `none` (reject).
-/
def modify {α : Type} (h : Handler) (newValue : α) (dataLbl : Label) (field : StoreField α) : Option (StoreField α) :=
  if authorizeWriteB h field.schema then
    some
      { value := newValue
        label := StoreLabel.upgradeLabel field.label dataLbl
        schema := field.schema }
  else
    none

/-!
### "Write authority is stable" lemma

This is the precise Lean version of spec 8.15.3:
the authority set is a property of the schema, and successful modifications do not change it.
-/

theorem schema_modify_eq {α : Type} {h : Handler} {newValue : α} {dataLbl : Label} {field field' : StoreField α} :
    modify h newValue dataLbl field = some field' -> field'.schema = field.schema := by
  intro hMod
  -- Unfold `modify` and split on the boolean authorization check.
  --
  -- If the check is `false`, then `modify` returns `none`, contradicting `some field'`.
  -- If the check is `true`, then `field'` is definitionally the record we construct, whose
  -- `schema` field is exactly `field.schema`.
  cases hb : authorizeWriteB h field.schema <;> simp [modify, hb] at hMod
  cases hMod
  rfl

end WriteAuthority

end Cfc
