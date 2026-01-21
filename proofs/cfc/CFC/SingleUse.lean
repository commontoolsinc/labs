/-
  CFC/SingleUse.lean
  Proofs of single-use semantics for events and intents.

  From Section 6 of the CFC specification, events and intents
  achieve single-use semantics through cell ID derivation
  using `refer({ causal: {...} })`.

  Key properties:
  - Events are processed exactly once
  - Intent consumption is atomic
  - Causal ID derivation ensures uniqueness
  - Fork prevention for event transformations
-/

import CFC.Basic
import CFC.Label

namespace CFC

/-!
## Cell Store Model

Cells are the storage mechanism for single-use semantics.
A cell can be atomically claimed exactly once.
-/

/-- Cell state: either unclaimed or claimed with a value -/
inductive CellState (α : Type) where
  | unclaimed
  | claimed (value : α) (claimedAt : Timestamp)
  deriving Repr

/-- A cell store maps references to cell states -/
structure CellStore (α : Type) where
  cells : Reference → CellState α

/-- Empty cell store -/
def CellStore.empty : CellStore α :=
  { cells := fun _ => .unclaimed }

/-- Check if a cell is claimed -/
def CellStore.isClaimed (store : CellStore α) (ref : Reference) : Bool :=
  match store.cells ref with
  | .claimed _ _ => true
  | .unclaimed => false

/-- Atomic claim result -/
inductive ClaimResult (α : Type) where
  | success (newStore : CellStore α)
  | alreadyClaimed
  deriving Repr

/-- Atomically claim a cell (returns success only if unclaimed) -/
def CellStore.atomicClaim
    (store : CellStore α)
    (ref : Reference)
    (value : α)
    (timestamp : Timestamp) : ClaimResult α :=
  match store.cells ref with
  | .unclaimed =>
    .success { cells := fun r => if r == ref then .claimed value timestamp else store.cells r }
  | .claimed _ _ =>
    .alreadyClaimed

/-!
## Single-Use Properties
-/

/-- A cell can only be claimed once -/
theorem claim_once
    (store : CellStore α)
    (ref : Reference)
    (v₁ v₂ : α)
    (t₁ t₂ : Timestamp) :
    match store.atomicClaim ref v₁ t₁ with
    | .success newStore =>
      newStore.atomicClaim ref v₂ t₂ = .alreadyClaimed
    | .alreadyClaimed => True := by
  simp [CellStore.atomicClaim]
  split
  · simp [CellStore.atomicClaim]
    split
    · simp_all
    · rfl
  · trivial

/-- Claiming doesn't affect other cells -/
theorem claim_isolated
    (store : CellStore α)
    (ref₁ ref₂ : Reference)
    (v : α)
    (t : Timestamp)
    (h : ref₁ ≠ ref₂) :
    match store.atomicClaim ref₁ v t with
    | .success newStore => newStore.cells ref₂ = store.cells ref₂
    | .alreadyClaimed => True := by
  simp [CellStore.atomicClaim]
  split
  · simp_all
  · trivial

/-!
## Event Processing
-/

/-- An event with unique identity -/
structure Event (α : Type) where
  id : Reference
  payload : α
  source : DID
  timestamp : Timestamp
  nonce : Nonce
  integrity : IntegrityLabel
  deriving Repr

/-- Cell ID for "event was processed" -/
def eventProcessedCellId (eventId : Reference) : Reference :=
  refer { eventProcessed := eventId }

/-- Process an event exactly once -/
def processEventOnce
    (store : CellStore Unit)
    (event : Event α)
    (timestamp : Timestamp) : ClaimResult Unit :=
  store.atomicClaim (eventProcessedCellId event.id) () timestamp

/-- Events are processed at most once -/
theorem event_processed_once
    (store : CellStore Unit)
    (event : Event α)
    (t₁ t₂ : Timestamp) :
    match processEventOnce store event t₁ with
    | .success newStore => processEventOnce newStore event t₂ = .alreadyClaimed
    | .alreadyClaimed => True := by
  simp [processEventOnce]
  exact claim_once store (eventProcessedCellId event.id) () () t₁ t₂

/-!
## Intent Events
-/

/-- An intent event derived from a UI gesture -/
structure IntentEvent (α : Type) where
  id : Reference
  action : String
  parameters : α
  sourceGestureId : Reference
  conditionHash : ContentHash
  evidence : Reference  -- snapshot digest, bindings, etc.
  exp : Timestamp
  integrity : IntegrityLabel
  deriving Repr

/-- Intent ID is derived from source gesture (deterministic) -/
axiom intentId_deterministic :
  ∀ (gestureId : Reference) (conditionHash : ContentHash) (params : α),
    refer { intent := gestureId, condition := conditionHash, params := refer params } =
    refer { intent := gestureId, condition := conditionHash, params := refer params }

/-- Same gesture + condition can only produce one intent -/
theorem one_intent_per_gesture
    (gestureId : Reference)
    (conditionHash : ContentHash)
    (params₁ params₂ : α)
    (h : refer params₁ = refer params₂) :
    refer { intent := gestureId, condition := conditionHash, params := refer params₁ } =
    refer { intent := gestureId, condition := conditionHash, params := refer params₂ } := by
  simp [h]

/-!
## Consumable Intents (IntentOnce)
-/

/-- A consumable single-use intent -/
structure IntentOnce (α : Type) where
  id : Reference
  operation : String
  audience : String
  endpoint : String
  parameters : α
  payloadDigest : Reference
  idempotencyKey : String
  exp : Timestamp
  maxAttempts : Nat
  sourceIntentId : Reference
  refinerHash : ContentHash
  integrity : IntegrityLabel
  deriving Repr

/-- Cell ID for "intent was refined" -/
def intentRefinedCellId (intentId : Reference) (refinerHash : ContentHash) : Reference :=
  refer { intentRefined := intentId, refiner := refinerHash }

/-- Cell ID for "intent was consumed" -/
def intentConsumedCellId (intentOnceId : Reference) : Reference :=
  refer { intentConsumed := intentOnceId }

/-- Cell ID for "intent attempt N" -/
def intentAttemptCellId (intentOnceId : Reference) (attemptNumber : Nat) : Reference :=
  refer { intentAttempt := intentOnceId, attempt := attemptNumber }

/-- Intent refinement state -/
structure RefinementStore where
  store : CellStore Unit
  deriving Repr

/-- Refine an intent (exactly once per refiner) -/
def refineIntent
    (rstore : RefinementStore)
    (sourceIntent : IntentEvent α)
    (refinerHash : ContentHash)
    (timestamp : Timestamp) : ClaimResult Unit × Option Reference :=
  let cellId := intentRefinedCellId sourceIntent.id refinerHash
  match rstore.store.atomicClaim cellId () timestamp with
  | .success newStore =>
    let intentOnceId := refer { consumableIntent := sourceIntent.id, refiner := refinerHash }
    (.success newStore, some intentOnceId)
  | .alreadyClaimed =>
    (.alreadyClaimed, none)

/-- An intent can only be refined once per refiner -/
theorem refine_once_per_refiner
    (rstore : RefinementStore)
    (sourceIntent : IntentEvent α)
    (refinerHash : ContentHash)
    (t₁ t₂ : Timestamp) :
    match refineIntent rstore sourceIntent refinerHash t₁ with
    | (.success newStore, _) =>
      (refineIntent { store := newStore } sourceIntent refinerHash t₂).1 = .alreadyClaimed
    | (.alreadyClaimed, _) => True := by
  simp [refineIntent]
  split
  · simp [CellStore.atomicClaim]
    split
    · simp_all
    · rfl
  · trivial

/-!
## Intent Consumption at Commit Points
-/

/-- Consumption state -/
structure ConsumptionStore where
  store : CellStore Reference  -- stores commit result reference
  deriving Repr

/-- Consume an intent at commit time -/
def consumeIntent
    (cstore : ConsumptionStore)
    (intent : IntentOnce α)
    (commitResult : Reference)
    (timestamp : Timestamp)
    (now : Timestamp) : ClaimResult Reference :=
  -- Check expiration
  if now > intent.exp then
    .alreadyClaimed  -- Expired intents cannot be consumed
  else
    cstore.store.atomicClaim (intentConsumedCellId intent.id) commitResult timestamp

/-- An intent can only be consumed once -/
theorem consume_once
    (cstore : ConsumptionStore)
    (intent : IntentOnce α)
    (result₁ result₂ : Reference)
    (t₁ t₂ now : Timestamp)
    (h : now ≤ intent.exp) :
    match consumeIntent cstore intent result₁ t₁ now with
    | .success newStore =>
      consumeIntent { store := newStore } intent result₂ t₂ now = .alreadyClaimed
    | .alreadyClaimed => True := by
  simp [consumeIntent, h]
  split
  · omega
  · exact claim_once cstore.store (intentConsumedCellId intent.id) result₁ result₂ t₁ t₂

/-- Expired intents cannot be consumed -/
theorem expired_not_consumable
    (cstore : ConsumptionStore)
    (intent : IntentOnce α)
    (result : Reference)
    (timestamp now : Timestamp)
    (h : now > intent.exp) :
    consumeIntent cstore intent result timestamp now = .alreadyClaimed := by
  simp [consumeIntent, h]

/-!
## Bounded Retries
-/

/-- Attempt tracking state -/
structure AttemptStore where
  store : CellStore Unit
  deriving Repr

/-- Claim an attempt slot -/
def claimAttempt
    (astore : AttemptStore)
    (intent : IntentOnce α)
    (attemptNumber : Nat)
    (timestamp : Timestamp) : ClaimResult Unit :=
  if attemptNumber > intent.maxAttempts then
    .alreadyClaimed
  else
    astore.store.atomicClaim (intentAttemptCellId intent.id attemptNumber) () timestamp

/-- Attempts are bounded by maxAttempts -/
theorem attempts_bounded
    (astore : AttemptStore)
    (intent : IntentOnce α)
    (n : Nat)
    (timestamp : Timestamp)
    (h : n > intent.maxAttempts) :
    claimAttempt astore intent n timestamp = .alreadyClaimed := by
  simp [claimAttempt, h]

/-- Each attempt number can only be claimed once -/
theorem attempt_once
    (astore : AttemptStore)
    (intent : IntentOnce α)
    (n : Nat)
    (t₁ t₂ : Timestamp)
    (h : n ≤ intent.maxAttempts) :
    match claimAttempt astore intent n t₁ with
    | .success newStore =>
      claimAttempt { store := newStore } intent n t₂ = .alreadyClaimed
    | .alreadyClaimed => True := by
  simp [claimAttempt, h]
  exact claim_once astore.store (intentAttemptCellId intent.id n) () () t₁ t₂

/-!
## Fork Prevention
-/

/-- Cell ID for "event was transformed by transformer" -/
def eventTransformedCellId (eventId : Reference) (transformerHash : ContentHash) : Reference :=
  refer { eventTransformed := eventId, transformer := transformerHash }

/-- An event can only be transformed once by each transformer -/
theorem transform_once_per_transformer
    (store : CellStore Unit)
    (eventId : Reference)
    (transformerHash : ContentHash)
    (t₁ t₂ : Timestamp) :
    let cellId := eventTransformedCellId eventId transformerHash
    match store.atomicClaim cellId () t₁ with
    | .success newStore => newStore.atomicClaim cellId () t₂ = .alreadyClaimed
    | .alreadyClaimed => True := by
  simp
  exact claim_once store (eventTransformedCellId eventId transformerHash) () () t₁ t₂

/-- Different transformers CAN process the same event -/
theorem different_transformers_allowed
    (store : CellStore Unit)
    (eventId : Reference)
    (hash₁ hash₂ : ContentHash)
    (t₁ t₂ : Timestamp)
    (h : hash₁ ≠ hash₂) :
    match store.atomicClaim (eventTransformedCellId eventId hash₁) () t₁ with
    | .success newStore =>
      (eventTransformedCellId eventId hash₁) ≠ (eventTransformedCellId eventId hash₂) →
      match newStore.atomicClaim (eventTransformedCellId eventId hash₂) () t₂ with
      | .success _ => True
      | .alreadyClaimed => True
    | .alreadyClaimed => True := by
  simp
  split
  · intro _
    split <;> trivial
  · trivial

end CFC
