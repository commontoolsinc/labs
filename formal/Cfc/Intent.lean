import Std

import Cfc.Atom

namespace Cfc

/-!
Event-scoped consumable intents (spec Sections 6/7; Safety invariant 4).

This is a deliberately tiny model:
- an "IntentOnce" is represented by an `Atom` token,
- an intent store is a list of tokens,
- committing consumes a token at most once.

We keep the definitions small and proof-friendly (Std-only).

How this connects to the spec:

- In the full system, intents are capabilities / user approvals that are scoped to an event
  (e.g. "user clicked confirm"). They should be *single-use* to prevent replay.

- Also, intent consumption must be coupled to an actual commit:
  - if the handler fails, the intent should not be burned ("no-consume-on-failure"),
    so that retry is possible.

This Lean model strips away all runtime machinery (timestamps, ids, deduplication) and keeps only
the essential logical shape needed for proofs:

  store : List Atom
  commitOnce tok store committedFlag : Option store'

where:
- `none` means "token not present, cannot commit",
- `some store'` is the updated store.
-/

abbrev IntentStore := List Atom

namespace Intent

/-
`eraseOnce` removes the first occurrence of `tok` from a store.

We use a list, so "first occurrence" is meaningful.
This is the typical "erase one element" function used to model consumable resources.

Important property (proved elsewhere):
erasing twice is the same as erasing once if there is only one occurrence.
-/
def eraseOnce (tok : Atom) : IntentStore → IntentStore
  | [] => []
  | a :: as =>
      if tok = a then
        as
      else
        a :: eraseOnce tok as

/-
Consume `tok` if present.

This is the simplest "use once" API:
- if the token is in the store, remove it and return the new store (`some ...`)
- otherwise return `none`

We use `Option` here as a minimal way to express failure.
-/
def consumeOnce (tok : Atom) (s : IntentStore) : Option IntentStore :=
  if tok ∈ s then some (eraseOnce tok s) else none

/--
Consume `tok` if and only if the effect is considered committed.

This corresponds to the "no-consume-on-failure" model in the spec:
failures leave the intent unconsumed so retries remain possible.
-/
/-
`commitOnce` is the key operation.

Inputs:
- `tok` : the intent token to consume
- `s` : the current store
- `committed : Bool` : whether the side effect actually committed

Behavior:
- If `tok` is absent, return `none` (cannot commit).
- If `tok` is present:
  - If `committed = true`, remove it (consume once).
  - If `committed = false`, leave the store unchanged but still return `some s`.

This "some s" on failure captures "the handler ran but did not commit".
Returning `none` is reserved for "token not present / invalid".

This is exactly what Safety invariant 4 needs:
you can retry until the commit succeeds, but once it succeeds the token is gone.
-/
def commitOnce (tok : Atom) (s : IntentStore) (committed : Bool) : Option IntentStore :=
  if tok ∈ s then
    if committed then some (eraseOnce tok s) else some s
  else
    none

end Intent

end Cfc
