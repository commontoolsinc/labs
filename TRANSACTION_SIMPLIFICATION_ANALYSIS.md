# Transaction System Simplification Analysis

## Executive Summary

The runner package's transaction system has a three-layer architecture (Transaction → Journal → Chronicle) that is over-engineered for the common case. The system optimizes for concurrent overlapping transactions, but in practice:

- Clients rarely create overlapping concurrent transactions
- It's acceptable for one transaction to fail at commit if it reads a document another wrote to
- The Reader/Writer abstraction adds complexity but is never used as separate objects in production

**Key Finding**: The actual API surface used in production is much simpler than the provided abstraction layer, indicating significant opportunity for simplification.

---

## Current Architecture

### Three-Layer Design

```
StorageTransaction (transaction.ts)
    ↓ delegates to
Journal (transaction/journal.ts)
    ↓ manages
Chronicle (transaction/chronicle.ts) [one per MemorySpace]
```

#### Layer 1: StorageTransaction
- **File**: `packages/runner/src/storage/transaction.ts:70-116`
- **Role**: Thin state machine wrapper (ready → pending → done)
- **Caches**: Single writer reference in `EditableState` (line 46)
- **Delegates**: All operations to Journal

#### Layer 2: Journal
- **File**: `packages/runner/src/storage/transaction/journal.ts:52-100`
- **Role**: Coordinates multiple memory spaces
- **Maintains**:
  - `Map<MemorySpace, Chronicle>` - per-space transaction state
  - `Map<MemorySpace, TransactionReader>` - cached readers (line 31)
  - `Map<MemorySpace, TransactionWriter>` - cached writers (line 32)
  - `Activity[]` - for scheduler reactivity tracking (line 25)

#### Layer 3: Chronicle
- **File**: `packages/runner/src/storage/transaction/chronicle.ts:56-294`
- **Role**: Transaction state for a single memory space
- **Maintains**:
  - `History` - read invariants for commit-time validation
  - `Novelty` - pending writes (working copy pattern)
  - `Changes` - per-document merged state

**Chronicle is well-designed**. The working copy pattern (CT-1123) eliminated O(N²) behavior.

---

## Proposed Simplification

### Flatten to Two Layers (Recommended)

**Remove Journal entirely. Merge into Transaction.**

```typescript
class StorageTransaction {
  #state: State;
  #storage: IStorageManager;
  #branches: Map<MemorySpace, Chronicle>;  // Direct Chronicle access
  #activity: Activity[];

  read(address: IMemorySpaceAddress): Result<IAttestation, ReadError> {
    const chronicle = this.#getOrCreateChronicle(address.space);
    this.#activity.push({ read: address });
    return chronicle.read(address);
  }

  write(address: IMemorySpaceAddress, value?: JSONValue): Result<IAttestation, WriteError> {
    const chronicle = this.#getOrCreateChronicle(address.space);
    this.#activity.push({ write: address });
    return chronicle.write(address, value);
  }

  async commit(): Promise<Result<Unit, CommitError>> {
    // Validate and commit each chronicle
    for (const [space, chronicle] of this.#branches) {
      const { ok: transaction, error } = chronicle.commit();
      if (error) return { error };

      const replica = this.#storage.open(space).replica;
      await replica.commit(transaction);
    }
  }

  #getOrCreateChronicle(space: MemorySpace): Chronicle {
    let chronicle = this.#branches.get(space);
    if (!chronicle) {
      const replica = this.#storage.open(space).replica;
      chronicle = Chronicle.open(replica);
      this.#branches.set(space, chronicle);
    }
    return chronicle;
  }
}
```

**Benefits**:
- Eliminates ~200 lines of Reader/Writer code
- Removes two map structures (readers, writers)
- Clearer flow: Transaction → Chronicle (one hop instead of two)
- Reads optimized: single map lookup instead of reader cache + branch lookup

**Keeps**:
- Chronicle (well-designed, working copy pattern is excellent)
- History and Novelty (core transaction state)
- Activity tracking (needed for scheduler)

---

## Migration Path

1. **Phase 1**: Copy analysis document and create implementation plan
2. **Phase 2**: Merge Journal functionality into Transaction
   - Move branches map to Transaction
   - Move activity array to Transaction
   - Remove Journal class and Reader/Writer classes
   - Update Transaction methods to call Chronicle directly
3. **Phase 3**: Clean up interfaces
   - Remove ITransactionReader, ITransactionWriter
   - Update IStorageTransaction interface
   - Remove reader()/writer() methods
4. **Phase 4**: Update tests
   - Tests should pass with minimal changes
   - Remove any tests that specifically test reader()/writer()

---

## File Line Counts

Current transaction layer:

```
transaction.ts:              378 lines
transaction/journal.ts:      365 lines
transaction/chronicle.ts:    622 lines
transaction/address.ts:       80 lines
transaction/attestation.ts:  478 lines
transaction/edit.ts:         120 lines
-------------------------------------------
Total:                      2043 lines
```

After simplification (estimated):

```
transaction.ts:              ~250 lines (merged with journal, no reader/writer)
transaction/chronicle.ts:     622 lines (unchanged)
transaction/address.ts:        80 lines (unchanged)
transaction/attestation.ts:   478 lines (unchanged)
transaction/edit.ts:          120 lines (unchanged)
-------------------------------------------
Total:                       ~1550 lines (-500 lines, -24%)
```

---

## Conclusion

By flattening to two layers (Transaction → Chronicle) and removing the unused Reader/Writer classes, we can:

- Reduce code by ~24% (500 lines)
- Optimize the hot path (reads)
- Simplify the mental model
- Preserve what works (Chronicle's working copy pattern)
- Align code structure with actual usage patterns
