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
-/

abbrev IntentStore := List Atom

namespace Intent

/-- Remove the first occurrence of `tok` from the store. -/
def eraseOnce (tok : Atom) : IntentStore → IntentStore
  | [] => []
  | a :: as =>
      if tok = a then
        as
      else
        a :: eraseOnce tok as

/-- Consume `tok` if present. -/
def consumeOnce (tok : Atom) (s : IntentStore) : Option IntentStore :=
  if tok ∈ s then some (eraseOnce tok s) else none

/--
Consume `tok` if and only if the effect is considered committed.

This corresponds to the "no-consume-on-failure" model in the spec:
failures leave the intent unconsumed so retries remain possible.
-/
def commitOnce (tok : Atom) (s : IntentStore) (committed : Bool) : Option IntentStore :=
  if committed then consumeOnce tok s else some s

end Intent

end Cfc

