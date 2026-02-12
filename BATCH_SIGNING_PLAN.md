# Batch Signing Plan for Memory Stack Commits

## Problem

Every memory transaction (cell write) is individually signed with Ed25519 and
wrapped in a UCAN-style envelope. This means each commit requires:

1. Merkle reference computation of the invocation (SHA-256 hash tree)
2. Proof object construction
3. Merkle reference computation of the proof
4. Ed25519 signature over the proof bytes
5. Serialization with DAG-JSON encoded signature

For workloads that produce many rapid transactions (e.g., a pattern updating
multiple cells in sequence), this per-commit signing is a bottleneck.

## Current Architecture

### Wire Format (per invocation)

```
UCAN<Invocation> = {
  invocation: { iss, cmd, sub, args, prf:[], iat, exp },
  authorization: {
    access: { "b...merkle-ref-of-invocation...": {} },
    signature: <Ed25519 over refer(access).bytes>
  }
}
```

### Key Insight: `Access.authorize()` Already Supports Arrays

`access.ts:90` accepts `Reference[]` and builds a single proof containing all
references, signed once. But `consumer.ts:249` always calls it with
`[invocation.refer()]` — a single-element array.

### Flow

```
cache.ts commit() → consumer.transact() → session.invoke()
  → ConsumerInvocation.create()
  → session.execute()
    → Access.authorize([invocation.refer()], signer)  // 1 ref per call
    → send UCAN over WebSocket
```

### No UCANTO Dependency

Despite UCAN-inspired naming, this is a custom implementation. No `@ucanto/*`
packages are imported. The "UCAN" is simply `{ invocation, authorization }`.

## Proposed Design: Batch Authorization with Debounced Accumulation

### Core Idea

Collect invocations over a debounced window (20ms debounce, up to 1s max
accumulation), authorize them all with a single `Access.authorize()` call
producing one signature, then send each invocation paired with the shared
authorization.

### Debounce Strategy

- Each new invocation **resets a 20ms debounce timer**
- If invocations keep arriving, the batch keeps growing (the timer resets)
- A **1s hard ceiling** forces a flush regardless of activity, preventing
  unbounded accumulation under sustained load
- A **max batch size** (50) also forces an immediate flush

This means:

- A burst of 10 invocations over 15ms → 1 signature (debounce kept resetting)
- A sustained stream of 1 invocation/10ms → flushes every 1s (hard ceiling)
- A lone invocation with no followers → flushes after 20ms

### New Wire Format

No new envelope type needed. Each `UCAN<Invocation>` on the wire still contains
`{ invocation, authorization }`, but multiple UCANs now **share the same
authorization object** (same signature, same proof containing all their
references).

```
// Before: N invocations → N signatures
UCAN1 = { invocation: inv1, authorization: { access: { ref1: {} }, sig1 } }
UCAN2 = { invocation: inv2, authorization: { access: { ref2: {} }, sig2 } }

// After: N invocations → 1 signature
shared_auth = { access: { ref1: {}, ref2: {}, ...refN: {} }, signature: sig_batch }
UCAN1 = { invocation: inv1, authorization: shared_auth }
UCAN2 = { invocation: inv2, authorization: shared_auth }
```

**Why this works:** `Access.claim()` (server-side, `access.ts:33`) checks
`authorization.access[claim]` — it only needs the invocation's reference to
exist in the proof object. If the proof contains extra references (for other
invocations), that's fine — the signature still covers them all and each
invocation can be verified independently.

## Implementation Checklist

### Client-side (`packages/memory/consumer.ts`)

- [ ] Add batch state to `MemoryConsumerSession`:
  - `pendingBatch: ConsumerInvocation[]` — accumulator
  - `debounceTimer: ReturnType<typeof setTimeout> | null` — 20ms debounce
  - `batchStartTime: number | null` — tracks when the batch started (for 1s
    ceiling)
- [ ] Replace `execute()` with debounced batching:
  - Push invocation onto `pendingBatch`
  - Record `batchStartTime` if this is the first invocation in the batch
  - If `pendingBatch.length >= batchMaxSize` → flush immediately
  - If `Date.now() - batchStartTime >= batchMaxAccumulateMs` → flush immediately
  - Otherwise reset the 20ms debounce timer
- [ ] Implement `flushBatch()`:
  - Clear debounce timer and `batchStartTime`
  - Snapshot and reset `pendingBatch`
  - Call `Access.authorize(refs, this.as)` once for all refs
  - Iterate batch and call `executeAuthorized()` for each
- [ ] Preserve send queue ordering (existing `sendQueue` mechanism)
- [ ] Handle `cancel()` / `close()` — flush or reject pending batch

### Sketch of the batching logic

```typescript
// New batch state on MemoryConsumerSession
private pendingBatch: ConsumerInvocation[] = [];
private debounceTimer: ReturnType<typeof setTimeout> | null = null;
private batchStartTime: number | null = null;

// Configurable
private batchDebounceMs: number = 20;       // debounce window
private batchMaxAccumulateMs: number = 1000; // hard ceiling
private batchMaxSize: number = 50;           // size cap

async execute(invocation: ConsumerInvocation) {
  this.pendingBatch.push(invocation);

  // Record when batch started
  if (this.batchStartTime === null) {
    this.batchStartTime = Date.now();
  }

  // Flush immediately if size cap hit or accumulation ceiling reached
  const elapsed = Date.now() - this.batchStartTime;
  if (
    this.pendingBatch.length >= this.batchMaxSize ||
    elapsed >= this.batchMaxAccumulateMs
  ) {
    return this.flushBatch();
  }

  // Otherwise reset debounce timer (each new invocation resets the 20ms window)
  if (this.debounceTimer !== null) {
    clearTimeout(this.debounceTimer);
  }
  this.debounceTimer = setTimeout(() => this.flushBatch(), this.batchDebounceMs);
}

private async flushBatch() {
  if (this.debounceTimer !== null) {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }
  this.batchStartTime = null;

  const batch = this.pendingBatch;
  this.pendingBatch = [];
  if (batch.length === 0) return;

  // Single authorize call for entire batch
  const refs = batch.map(inv => inv.refer());
  const authResult = await Access.authorize(refs, this.as);

  for (const invocation of batch) {
    this.executeAuthorized(authResult, invocation);
  }
}
```

### Settings (`packages/memory/settings.ts`)

- [ ] Add `batchDebounceMs` default (20)
- [ ] Add `batchMaxAccumulateMs` default (1000)
- [ ] Add `batchMaxSize` default (50)

### No changes needed (verification already works)

- [ ] Verify `Access.authorize()` (`access.ts`) — already handles arrays, no
      changes
- [ ] Verify `Access.claim()` (`access.ts`) — already handles multi-ref proofs,
      no changes
- [ ] Verify `MemoryProviderSession.invoke()` (`provider.ts`) — transparent, no
      changes
- [ ] Verify `ucan.ts` serialization — unchanged format, no changes
- [ ] Verify WebSocket transport (`socket.ts`) — still sends one UCAN at a time,
      no changes

### Tests

- [ ] Unit: batch of 1 produces identical UCAN to current code
- [ ] Unit: batch of N produces N UCANs with shared authorization
- [ ] Unit: all N UCANs verify correctly via `Access.claim()`
- [ ] Unit: debounce resets on each new invocation (batches grow during bursts)
- [ ] Unit: 1s hard ceiling forces flush under sustained load
- [ ] Unit: max batch size forces immediate flush
- [ ] Unit: `cancel()` / `close()` rejects pending batch invocations
- [ ] Integration: multiple rapid `transact()` calls batch together
- [ ] Integration: server processes batched UCANs correctly
- [ ] Integration: subscription notifications still work after batched commits
- [ ] Regression: all existing memory tests pass (batch of 1 = old behavior)

## Migration

This is a **backward-compatible, client-only change**:

- [ ] Server needs zero changes — verification already handles multi-reference
      proofs
- [ ] Old clients continue to work — single-reference proofs are a special case
- [ ] New clients are backward-compatible — a batch of 1 is identical to old
      behavior
- [ ] No protocol version negotiation needed

## Risks and Tradeoffs

### Latency

- **Best case (burst)**: 10 invocations over 15ms → single signature after the
  debounce settles. Net latency = last invocation + 20ms.
- **Typical case (lone invocation)**: 20ms added latency from debounce.
  Acceptable for most workloads; the signing cost saved over bursts more than
  compensates.
- **Sustained load**: 1s ceiling means worst-case 1s of accumulated latency
  before the batch flushes. Invocations at the start of the window wait up to
  1s.

### Batch Failure

- If `Access.authorize()` fails for the batch, all invocations in the batch
  fail. Same as current behavior — the signer is the same for all invocations in
  a session.

### Proof Size

- A proof with 50 entries is ~3KB of JSON (50 base32 strings x ~60 chars each).
  Negligible compared to transaction payloads.

### Ordering

- The send queue already ensures ordering. Batching doesn't change this — all
  invocations within a batch are sent in the order they were enqueued.

## Abandoned Alternatives

### New Batch Envelope

A new wire type `BatchUCAN = { invocations: Invocation[], authorization }` was
considered but rejected — requires server-side protocol changes and new
serialization logic. The shared-authorization approach achieves the same goal
with zero server changes.

### Abandoning UCAN Style

Unnecessary. The current UCAN-style envelope supports batch signing natively via
the multi-reference proof. Keeping the UCAN style preserves the existing
verification infrastructure and future extensibility for delegation chains.
