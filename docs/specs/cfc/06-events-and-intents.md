# 6. Events, Intents, and Single-Use Semantics

Events and intents achieve single-use semantics through cell ID derivation using `refer({ causal: {...} })`. Event transformations chain together while preserving consumption guarantees.

## 6.1 Causal ID Derivation with `refer()`

The system uses `refer()` from `merkle-reference` to derive content-addressed IDs from causal structures. This provides:
- Deterministic IDs from structured data
- Cryptographic binding between cause and effect
- Efficient caching via merkle tree structure

```typescript
import { refer } from "@commontools/memory";

// Derive a cell ID that represents "this event was processed"
const cellId = refer({ eventProcessed: { eventId } });
```

All single-use semantics rely on this pattern: derive a cell ID from a structured description, then atomically claim that cell.

---

## 6.2 Event Identity and Single-Use Processing

### 6.2.1 Event Structure

An event is a value with a unique identity derived from its content and context:

```typescript
interface Event<T> {
  // Unique event identity (content-addressed)
  id: Reference;  // refer({ source, timestamp, nonce, payload: refer(payload) })

  // Event payload
  payload: T;

  // Provenance
  source: DID;           // Who/what produced the event
  timestamp: number;
  nonce: string;         // Ensures uniqueness even for identical payloads

  // Integrity
  integrity: IntegrityAtom[];
}
```

### 6.2.2 Single-Use Enforcement via Cells

Event processing is made single-use by atomically claiming a derived cell:

```typescript
// Cell ID derived from event ID
function processedCellId(eventId: Reference): Reference {
  return refer({ eventProcessed: { eventId } });
}

// Process event exactly once
async function processEventOnce<T>(
  event: Event<T>,
  handler: Handler<T>
): Promise<boolean> {
  const cellId = processedCellId(event.id);

  // Atomic claim: write only if cell doesn't exist
  const claimed = await atomicClaimCell(cellId, {
    processedAt: Date.now(),
    handlerHash: refer(handler).toString()
  });

  if (!claimed) {
    // Event already processed
    return false;
  }

  await handler(event.payload);
  return true;
}
```

The `atomicClaimCell` operation:
1. Reads the cell - must be empty/nonexistent
2. Writes the claim marker
3. Commits atomically - fails if cell was written concurrently

### 6.2.3 Processed Cell as Integrity Evidence

The processed cell serves as proof that:
- The event was handled exactly once
- The handler identity is recorded
- The processing timestamp is captured

This can be used as integrity evidence in downstream flows:

```typescript
{
  type: "EventProcessed",
  scope: { valueRef: event.id },
  eventId: event.id.toString(),
  handlerHash: "...",
  processedAt: 1703275200
}
```

---

## 6.2 Intent Events from UI Gestures

### 6.2.1 UI Event to Intent Event

When a user gesture occurs on the VDOM:

```typescript
interface UIGestureEvent {
  id: EventId;                    // H(gesture details)
  kind: "click" | "submit" | "select" | ...;
  targetNodeId: string;           // VDOM node ID
  snapshotDigest: string;         // H(VDOM at gesture time)
  timestamp: number;

  // UI runtime provides this integrity
  integrity: [
    { type: "UIRuntime", hash: "..." },
    { type: "GestureProvenance", snapshot: "...", target: "..." }
  ];
}
```

A declarative condition transforms this into a semantic IntentEvent:

```typescript
interface IntentEvent<T> {
  id: EventId;  // H("intent:" + gestureEventId + conditionHash + paramsDigest)

  // Semantic action
  action: string;           // e.g., "ForwardEmail", "ShareDocument"
  parameters: T;            // Action-specific parameters

  // Provenance chain
  sourceGestureId: EventId;
  conditionHash: string;    // Which condition recognized this

  // Evidence from UI
  evidence: {
    snapshotDigest: string;
    targetNodeId: string;
    boundValueDigests: Record<string, string>;
    labelSummaries: Record<string, Label>;
  };

  // Combined integrity
  integrity: IntegrityAtom[];
}
```

### 6.2.2 Intent ID Derivation

The intent ID is derived from the source gesture, ensuring:
- Same gesture can only produce one intent per condition
- Intent is cryptographically bound to what the user saw and did

```typescript
function deriveIntentId(
  gestureEvent: UIGestureEvent,
  condition: Condition,
  parameters: unknown
): EventId {
  return H(
    "intent:" +
    gestureEvent.id + ":" +
    condition.hash + ":" +
    H(canonicalize(parameters))
  );
}
```

---

## 6.3 Intent Refinement Chain

### 6.3.1 Refinement as Event Transformation

Intent refinement transforms a high-level intent into a more specific one:

```
UIGestureEvent
    ↓ [Condition: ForwardClicked]
IntentEvent<{emailId, recipients}>
    ↓ [Refiner: Gmail.Forward]
IntentOnce<{endpoint, payload, idempotencyKey}>
```

Each refinement step:
1. Consumes the source intent (marks it as refined)
2. Produces a new intent with derived ID
3. Records the transformation as integrity

### 6.3.2 Refinement Cell Derivation

```typescript
import { refer } from "@commontools/memory";

function refinedCellId(
  sourceIntentId: Reference,
  refinerHash: string
): Reference {
  return refer({
    intentRefined: {
      intentId: sourceIntentId,
      refinerHash
    }
  });
}

async function refineIntent<S, T>(
  sourceIntent: IntentEvent<S>,
  refiner: Refiner<S, T>
): Promise<IntentOnce<T> | null> {
  const cellId = refinedCellId(sourceIntent.id, refiner.hash);

  // Claim: this source intent hasn't been refined by this refiner
  const claimed = await atomicClaimCell(cellId, {
    refinedAt: Date.now(),
    refinerHash: refiner.hash
  });

  if (!claimed) {
    // Already refined
    return null;
  }

  // Derive new intent
  const refinedParams = refiner.transform(sourceIntent.parameters);

  // Derive new intent ID from refinement
  const intentOnceId = refer({
    consumableIntent: {
      sourceIntentId: sourceIntent.id,
      refinerHash: refiner.hash
    }
  });

  return {
    id: intentOnceId,
    operation: refiner.operation,
    parameters: refinedParams,

    // Chain back to source
    sourceIntentId: sourceIntent.id,
    refinerHash: refiner.hash,

    // Integrity accumulates
    integrity: [
      ...sourceIntent.integrity,
      { type: "RefinedBy", refiner: refiner.hash, source: sourceIntent.id }
    ]
  };
}
```

### 6.3.2.1 Refiner Trust and Scoped Endorsement

Refiners are **trusted components** that transform high-level intents into specific, consumable intents. Because they can influence what operations are authorized, they require explicit trust.

Refiner trust uses the general **TrustStatement** mechanism (Section 4.8.2):

1. A **verifier** issues a `TrustStatement` asserting that a refiner code hash implements a concept (e.g., `"gmail-intent-refiner"`)
2. The **concept definition** specifies what the refiner can do (accepted actions, authorized operations, target audiences)
3. The **user** delegates trust to verifiers for specific concept categories (Section 4.8.3)

```typescript
// Example: Trust statement for a Gmail refiner
const gmailRefinerTrust: TrustStatement = {
  concrete: { type: "CodeHash", hash: "sha256:abc123..." },
  implements: {
    type: "Concept",
    uri: "https://commonfabric.org/concepts/gmail-refiner"
  },
  verifier: { type: "Verifier", subject: "did:key:google-api-auditor" },
  scope: { validUntil: 1735689600 },
  signature: "..."
};

// The concept definition (at the URI) specifies:
// - acceptedActions: ["ForwardEmail", "ReplyToEmail", "ComposeEmail"]
// - authorizedOperations: ["Gmail.Forward", "Gmail.Reply", "Gmail.Send"]
// - authorizedAudiences: ["https://gmail.googleapis.com"]
```

**Verification at refinement time:**

```typescript
async function refineIntentWithTrustCheck<S, T>(
  sourceIntent: IntentEvent<S>,
  refiner: Refiner<S, T>,
  userTrust: VerifierDelegation[]
): Promise<IntentOnce<T> | RefinerTrustError> {
  // 1. Find trust statements for this refiner from verifiers the user trusts
  const statements = await findTrustStatements({
    concrete: { type: "CodeHash", hash: refiner.hash },
    trustedVerifiers: userTrust.map(d => d.verifier)
  });

  if (statements.length === 0) {
    return { error: "refiner_not_trusted", refinerHash: refiner.hash };
  }

  // 2. Load concept definition and verify action is in scope
  const concept = await loadConcept(statements[0].implements.uri);
  if (!concept.acceptedActions.includes(sourceIntent.action)) {
    return { error: "action_not_in_scope", action: sourceIntent.action };
  }

  // 3. Perform refinement
  const refined = await refineIntent(sourceIntent, refiner);
  if (!refined) {
    return { error: "refinement_failed" };
  }

  // 4. Verify output is in scope
  if (!concept.authorizedOperations.includes(refined.operation)) {
    return { error: "output_operation_not_in_scope", operation: refined.operation };
  }

  // 5. Add trust verification to integrity
  refined.integrity.push({
    type: "VerifiedImplementation",
    concept: concept.uri,
    codeHash: refiner.hash,
    verifier: statements[0].verifier.subject
  });

  return refined;
}
```

**Why scoped trust matters:**

1. **Limits blast radius**: A bug in the Gmail refiner cannot produce Dropbox operations
2. **Enables auditing**: Clear record of what each refiner is authorized to do
3. **Supports delegation**: Users can trust different verifiers for different domains
4. **Prevents scope creep**: Refiners cannot expand their authority over time without re-verification

**Open problem (Section 10)**: Full semantic verification that a refiner's output correctly represents the user's intent remains an open problem. Scoped trust mitigates but doesn't eliminate the risk of buggy refiners.

### 6.3.3 IntentOnce Structure

The final consumable intent:

```typescript
interface IntentOnce<T> {
  id: Reference;

  // What operation is authorized
  operation: string;        // e.g., "Gmail.Forward"
  audience: string;         // e.g., "https://gmail.googleapis.com"
  endpoint: string;         // e.g., "messages.send"

  // Bound parameters
  parameters: T;
  payloadDigest: Reference; // refer(parameters)
  idempotencyKey: string;   // For safe retries

  // Expiration and duration class
  exp: number;
  maxAttempts: number;
  duration: "short" | "long";

  // Provenance
  sourceIntentId: Reference;
  refinerHash: string;

  // Integrity chain
  integrity: IntegrityAtom[];
}
```

### 6.3.4 Intent Duration Classes

Intents fall into two duration classes with different security properties:

**Short intents** (max 5 seconds):
- For immediate actions (button clicks, form submissions)
- Expire quickly to limit replay window
- No UI persistence required
- Example: "Send this email now"

**Long intents** (minutes to hours):
- For operations that take time (file uploads, batch processing)
- **Must be displayed in UI** so user can track and cancel
- User can cancel at any time before consumption
- Requires additional integrity: `UIDisplayed` evidence
- Example: "Upload these 100 photos"

```typescript
interface LongIntent<T> extends IntentOnce<T> {
  duration: "long";

  // Required for long intents
  uiDisplayRequirement: {
    // What must be shown to the user
    displayTemplate: string;
    // User can cancel via this action
    cancellationAction: string;
  };

  // Cancellation state
  cancelledAt?: number;
  cancelledBy?: DID;
}

// Short intent verification
function verifyShortIntent(intent: IntentOnce<unknown>): boolean {
  if (intent.duration !== "short") return false;
  const maxShortDuration = 5000; // 5 seconds
  return (intent.exp - Date.now()) <= maxShortDuration;
}

// Long intent verification
function verifyLongIntent(
  intent: LongIntent<unknown>,
  uiEvidence: UIEvidence
): boolean {
  if (intent.duration !== "long") return false;

  // Must have UI display evidence
  if (!uiEvidence.intentDisplayed?.includes(intent.id.toString())) {
    return false;
  }

  // Must not be cancelled
  if (intent.cancelledAt !== undefined) {
    return false;
  }

  return true;
}
```

**Cancellation semantics for long intents**:

1. User can cancel any time before consumption
2. Cancellation is recorded atomically
3. Cancelled intents cannot be consumed
4. UI must reflect cancellation state

```typescript
async function cancelLongIntent(
  intent: LongIntent<unknown>,
  cancelledBy: DID
): Promise<boolean> {
  const cellId = refer({ intentCancelled: { intentId: intent.id } });

  const claimed = await atomicClaimCell(cellId, {
    cancelledAt: Date.now(),
    cancelledBy
  });

  if (claimed) {
    // Mark the intent itself as cancelled
    intent.cancelledAt = Date.now();
    intent.cancelledBy = cancelledBy;
  }

  return claimed;
}
```

---

## 6.4 Intent Consumption at Commit Points

### 6.4.1 Consumption Cell Derivation

When an IntentOnce is used at a commit point:

```typescript
import { refer } from "@commontools/memory";

function consumedCellId(intentOnceId: Reference): Reference {
  return refer({
    intentConsumed: { intentOnceId }
  });
}

async function consumeIntent<T>(
  intent: IntentOnce<T>,
  commitAction: () => Promise<CommitResult>
): Promise<CommitResult> {
  // Verify not expired
  if (Date.now() > intent.exp) {
    return { success: false, error: "intent_expired" };
  }

  const cellId = consumedCellId(intent.id);

  // Attempt the commit
  const result = await commitAction();

  if (result.success) {
    // Only consume on successful commit
    const claimed = await atomicClaimCell(cellId, {
      consumedAt: Date.now(),
      commitResult: result
    });

    if (!claimed) {
      // Race condition: someone else consumed it
      // The commit already happened, so this is idempotent via idempotencyKey
      return { success: true, deduplicated: true };
    }
  }

  return result;
}
```

### 6.4.2 Linearizable Consumption

Intent consumption must be **linearizable**. The key insight: **consume first, then act**. Because external effects cannot be rolled back, we commit the consumption before attempting the action. If the action fails, privileged runtime code issues a retry intent.

The consumption flow:

1. **Consume intent**: Atomically mark the intent as consumed and commit
2. **Attempt effect**: Make the network call or perform the action
3. **On success**: Done—intent was already consumed
4. **On failure**: Privileged code issues a retry intent (a new consumable)

```typescript
async function linearizableConsume<T>(
  intent: IntentOnce<T>,
  action: () => Promise<ActionResult>
): Promise<ConsumeResult<T>> {
  // Step 1: Consume the intent FIRST (atomic, committed before action)
  const consumeResult = await atomicClaimCell(consumedCellId(intent.id), {
    consumedAt: Date.now(),
    status: "consumed"
  });

  if (!consumeResult) {
    return { success: false, error: "already_consumed" };
  }

  // Step 2: Now perform the external effect
  // The intent is already consumed—no race condition
  const actionResult = await action();

  if (actionResult.success) {
    // Record success (non-critical, for observability)
    await updateCell(consumedCellId(intent.id), {
      status: "completed",
      result: actionResult
    });
    return { success: true, result: actionResult };
  }

  // Step 3: Action failed—issue retry intent if allowed
  if (intent.retriesRemaining > 0) {
    // Privileged runtime code mints a new consumable for retry
    const retryIntent = await mintRetryIntent(intent, actionResult.error);
    return { success: false, retryIntent };
  }

  // No retries left
  await updateCell(consumedCellId(intent.id), {
    status: "failed",
    error: actionResult.error
  });
  return { success: false, error: actionResult.error };
}
```

**Why consume-first is correct**: External actions cannot participate in transactions—they're outside the system. By consuming first:
- The intent is definitively used (no double-spend)
- If the action fails, a new retry intent provides authorization to try again
- The retry intent is a fresh consumable with its own single-use semantics

### 6.4.3 Retry Intent Tokens

When an external effect fails, privileged runtime code issues a **retry intent**—a tightly-scoped token that authorizes retry attempts for the same operation. The original intent is already consumed; the retry intent is a new consumable.

```typescript
interface RetryIntent<T> {
  id: Reference;  // refer({ retryIntent: { sourceIntentId, attemptNumber } })

  // Bound to the same operation as source
  sourceIntentId: Reference;
  operation: string;
  audience: string;
  parameters: T;
  payloadDigest: Reference;
  idempotencyKey: string;  // Same as original - external idempotency

  // Retry-specific constraints
  attemptNumber: number;
  maxAttempts: number;     // Remaining attempts
  retryDeadline: number;   // Tighter than original expiration

  // Provenance
  failureReason: string;
  issuedAt: number;

  // Only privileged runtime code may mint these
  integrity: [
    { type: "MintedByRuntime", runtimeHash: string },
    { type: "RetryOf", sourceIntentId: Reference }
  ];
}
```

**Key constraints**:

1. **Privileged minting**: Only the trusted runtime (not pattern code) may issue retry intents
2. **Same operation**: Retry intents are bound to the exact same operation, audience, and idempotency key
3. **Tighter scope**: Retry deadline is shorter than original expiration
4. **Traceable**: Full provenance chain from original intent through retries
5. **Bounded**: Each retry decrements `maxAttempts`; no infinite retries

### 6.4.4 Retry Execution

```typescript
async function executeWithRetry<T>(
  intent: IntentOnce<T>,
  action: () => Promise<ActionResult>
): Promise<FinalResult<T>> {
  let currentIntent: IntentOnce<T> | RetryIntent<T> = intent;

  while (true) {
    const result = await linearizableConsume(currentIntent, action);

    if (result.success) {
      return { success: true, result: result.result };
    }

    if (result.retryIntent) {
      // Got a retry token - continue
      currentIntent = result.retryIntent;
      await backoff(result.retryIntent.attemptNumber);
      continue;
    }

    // No retry available - final failure
    return { success: false, error: result.error };
  }
}
```

### 6.4.5 Idempotency Key Flow

The idempotency key ensures external services handle retries correctly:

```
IntentOnce.idempotencyKey = refer({ idempotencyKey: { sourceIntentId, operation } })
    ↓
RequestSemantics.idempotencyKey = IntentOnce.idempotencyKey
    ↓
HTTP Header: X-Idempotency-Key: <base64(key)>
    ↓
External service deduplicates by key
```

---

## 6.5 Event Transformation Chains

### 6.5.1 Transformation as Derived Events

Any event can be transformed into a new event, creating a provenance chain:

```typescript
interface DerivedEvent<T> extends Event<T> {
  // Link to source
  sourceEventId: Reference;
  transformerHash: string;

  // Derivation is part of ID:
  // id = refer({ derivedEvent: { sourceEventId, transformerHash, payload: refer(payload) } })
}
```

### 6.5.2 Fork Prevention

A source event can only be transformed once per transformer:

```typescript
import { refer } from "@commontools/memory";

function transformationCellId(
  sourceEventId: Reference,
  transformerHash: string
): Reference {
  return refer({
    eventTransformed: {
      eventId: sourceEventId,
      transformerHash
    }
  });
}
```

This prevents:
- Processing the same event twice with the same transformer
- Forking an event into multiple outputs from the same logic

### 6.5.3 Multiple Transformers

Different transformers CAN process the same event:

```
Event A
  ├── [Transformer 1] → Event B
  └── [Transformer 2] → Event C
```

Each transformation claims a different cell:
- `refer({ eventTransformed: { eventId: A.id, transformerHash: T1.hash } })`
- `refer({ eventTransformed: { eventId: A.id, transformerHash: T2.hash } })`

This is intentional - an email can both trigger a calendar event AND a notification.

### 6.5.4 Chained Transformations

Transformations can chain:

```
UIGesture
    ↓ [Condition: ForwardClicked]
IntentEvent<ForwardParams>
    ↓ [Refiner: Gmail.Forward]
IntentOnce<GmailSendParams>
    ↓ [Commit: fetch]
CommitResult
```

Each step claims its own cell, ensuring:
- Each transformation happens exactly once
- The full chain is traceable
- Integrity accumulates through the chain

---

## 6.6 Integrity Through the Chain

### 6.6.1 Integrity Accumulation

As events transform, integrity atoms accumulate:

```typescript
import { refer } from "@commontools/memory";

function accumulateIntegrity(
  source: Event<any>,
  transformation: { type: string; hash: string }
): IntegrityAtom[] {
  return [
    ...source.integrity,
    {
      type: "TransformedBy",
      scope: { valueRef: refer(source) },
      transformer: transformation.hash,
      sourceEventId: source.id
    }
  ];
}
```

### 6.6.2 Final Intent Integrity

An IntentOnce carries the full chain:

```typescript
{
  integrity: [
    // From UI gesture
    { type: "UIRuntime", hash: "ui-runtime-v1" },
    { type: "GestureProvenance", snapshot: "...", target: "btn:forward" },

    // From condition recognition
    { type: "ConditionMatched", condition: "ForwardClicked", ... },

    // From refinement
    { type: "RefinedBy", refiner: "Gmail.Forward", source: "intent:abc" },

    // Scope binding
    { type: "BoundTo", scope: { emailId: "...", recipients: [...] } }
  ]
}
```

### 6.6.3 Verification at Commit

The commit point verifies the integrity chain:

```typescript
function verifyIntentIntegrity(intent: IntentOnce<any>): boolean {
  // 1. Check UI runtime is trusted
  const uiAtom = intent.integrity.find(a => a.type === "UIRuntime");
  if (!isTrustedUIRuntime(uiAtom?.hash)) return false;

  // 2. Check condition is from trusted library
  const condAtom = intent.integrity.find(a => a.type === "ConditionMatched");
  if (!isTrustedCondition(condAtom?.condition)) return false;

  // 3. Check refiner is authorized for this operation
  const refineAtom = intent.integrity.find(a => a.type === "RefinedBy");
  if (!isAuthorizedRefiner(refineAtom?.refiner, intent.operation)) return false;

  // 4. Check parameter integrity (robust declassification)
  // ... scope parameters must have sufficient integrity

  return true;
}
```

---

## 6.7 Cell ID Summary

| Purpose | Reference Structure |
|---------|---------------------|
| Event processed | `refer({ eventProcessed: { eventId } })` |
| Event transformed | `refer({ eventTransformed: { eventId, transformerHash } })` |
| Intent refined | `refer({ intentRefined: { intentId, refinerHash } })` |
| Intent consumed | `refer({ intentConsumed: { intentOnceId } })` |

All single-use semantics are enforced by atomic claim of the derived cell. The `refer()` function from `@commontools/memory` produces content-addressed references from structured data.
