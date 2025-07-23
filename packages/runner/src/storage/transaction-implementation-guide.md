# Storage Transaction Implementation Guide

This guide provides detailed implementation knowledge for developers working on
the storage transaction system. It covers state machines, error handling, and
key implementation details.

## State Machines

### Transaction State Machine

The `StorageTransaction` class manages three distinct states:

```typescript
// packages/runner/src/storage/transaction.ts:35-57
type EditableState = {
  status: "ready";
  storage: IStorageManager;
  journal: Journal.Journal;
  writer: ITransactionWriter | null; // Cached writer instance
};

type SumbittedState = {
  status: "pending";
  journal: Journal.Journal;
  promise: Promise<Result<Unit, StorageTransactionFailed>>;
};

type CompleteState = {
  status: "done";
  journal: Journal.Journal;
  result: Result<Unit, StorageTransactionFailed>;
};
```

**State Transitions:**

```
ready → pending → done
  ↓        ↓       
  └──────→ done (with error)
```

### Journal State Machine

The `Journal` class has two states:

```typescript
// packages/runner/src/storage/transaction/journal.ts:28-43
interface OpenState {
  status: "open";
  storage: IStorageManager;
  branches: Map<MemorySpace, Chronicle.Chronicle>;
  readers: Map<MemorySpace, TransactionReader>;
  writers: Map<MemorySpace, TransactionWriter>;
  activity: Activity[];
}

interface ClosedState {
  status: "closed";
  reason: Result<
    JournalArchive,
    IStorageTransactionAborted | IStorageTransactionInconsistent
  >;
  branches: Map<MemorySpace, Chronicle.Chronicle>;
  activity: Activity[];
}
```

## Critical Implementation Details

### 1. State Mutation Pattern

The codebase uses a specific pattern for state management:

```typescript
// packages/runner/src/storage/transaction.ts:64-69
class StorageTransaction {
  static mutate(transaction: StorageTransaction, state: State) {
    transaction.#state = state;
  }
  static use(transaction: StorageTransaction): State {
    return transaction.#state;
  }
}
```

This pattern ensures controlled state access and makes state transitions
explicit.

### 2. Writer Isolation Enforcement

The writer isolation is enforced at two levels:

**Transaction Level** (`packages/runner/src/storage/transaction.ts:163-206`):

- Caches a single writer reference in `EditableState.writer`
- Returns cached writer for same space
- Fails with `WriteIsolationError` for different space

**Journal Level**
(`packages/runner/src/storage/transaction/journal.ts:209-232`):

- Maintains `writers` Map but effectively allows only one
- First writer creation succeeds, stored in map
- Subsequent requests for same space return cached instance

### 3. Chronicle's Dual Storage

Each `Chronicle` maintains two separate data structures:

```typescript
// packages/runner/src/storage/transaction/chronicle.ts:225-353
class History {
  #model: Map<string, IAttestation> = new Map();
  // Stores read invariants for consistency checking
}

class Novelty {
  #model: Map<string, Changes> = new Map();
  // Stores uncommitted writes
}
```

**Key insight**: History uses overlapping detection to maintain minimal set of
invariants, while Novelty merges writes to avoid redundancy.

### 4. Address Handling

Memory addresses have three components:

- `id`: Entity URI
- `type`: Media type (e.g., "application/json")
- `path`: JSON path within the value

Special handling for data URIs:

```typescript
// packages/runner/src/storage/transaction/chronicle.ts:102-104
if (Address.isInline(address)) {
  return { error: new ReadOnlyAddressError(address) };
}
```

## Error States and Handling

### 1. Transaction-Level Errors

**InactiveTransactionError** - Base type for operations on inactive
transactions:

- `TransactionCompleteError`: Transaction already committed/aborted
- `TransactionAborted`: Transaction was explicitly aborted
- `StorageTransactionInconsistent`: Invariant violation detected

**WriteIsolationError** (`packages/runner/src/storage/transaction.ts:317-331`):

```typescript
// Triggered when attempting to write to different space
if (writer.did() !== space) {
  return {
    error: new WriteIsolationError({ open: writer.did(), requested: space }),
  };
}
```

### 2. Chronicle-Level Errors

**StorageTransactionInconsistent**:

- Detected during invariant validation
- Compares expected vs actual values at overlapping addresses
- Critical for maintaining consistency guarantees
- Indicates underlying state changed - retry needed

**NotFoundError**:

- Document or path doesn't exist
- Returned when writing to nested path of non-existent document
- Transient error - would succeed if document existed

**TypeMismatchError**:

- Attempting to access properties on non-objects
- E.g., reading `"string".property` or `null.field`
- Persistent error - will always fail unless data type changes

**ReadOnlyAddressError**:

- Prevents writes to `data:` URIs
- Checked early in write path

### 3. Error Handling Strategy

The error types follow a clear strategy:

1. **Transient Errors** (may succeed on retry):
   - `NotFoundError`: Create the missing document/path
   - `StorageTransactionInconsistent`: Retry with updated state

2. **Persistent Errors** (will always fail):
   - `TypeMismatchError`: Data structure incompatibility
   - `ReadOnlyAddressError`: Immutable addresses
   - `WriteIsolationError`: Transaction design constraint

3. **State Errors** (transaction unusable):
   - `TransactionCompleteError`: Already finished
   - `TransactionAborted`: Explicitly cancelled

### 4. Commit Failure Modes

The commit process (`packages/runner/src/storage/transaction.ts:260-299`) can
fail at multiple stages:

1. **Pre-commit validation**:
   - Transaction not in "ready" state
   - Journal close fails due to inconsistency

2. **During commit**:
   - Replica commit fails (network, authorization)
   - Upstream conflicts detected

3. **State update on failure**:

   ```typescript
   mutate(transaction, {
     status: "done",
     journal: ready.journal,
     result: { error },
   });
   ```

## Key Algorithms

### 1. Consistency Checking

Chronicle's History class
(`packages/runner/src/storage/transaction/chronicle.ts:287-344`) implements
sophisticated invariant management:

```typescript
claim(attestation: IAttestation): Result<IAttestation, IStorageTransactionInconsistent> {
  const obsolete = new Set<IAttestation>();
  
  for (const candidate of this) {
    if (Address.intersects(attestation.address, candidate.address)) {
      // Check consistency at more specific path
      const address = longerPath(attestation, candidate);
      
      if (!valuesMatch(attestation, candidate, address)) {
        return { error: new StateInconsistency(...) };
      }
      
      // Remove redundant invariants
      if (isParentOf(attestation, candidate)) {
        obsolete.add(candidate);
      }
    }
  }
  
  // Update invariant set
  this.put(attestation);
  obsolete.forEach(inv => this.delete(inv));
}
```

### 2. Write Merging

Novelty class (`packages/runner/src/storage/transaction/chronicle.ts:383-420`)
intelligently merges overlapping writes.

**Important**: When writing to a nested path, Chronicle first checks if novelty
contains a write that would create the document before returning NotFoundError.
This allows operations like:

```typescript
// Create document
tx.write({ id: "doc:1", path: [] }, { items: ["a", "b", "c"] });
// Modify nested path in same transaction
tx.write({ id: "doc:1", path: ["items", "1"] }, "B");
```

The write algorithm:

```typescript
claim(invariant: IAttestation): Result<IAttestation, IStorageTransactionInconsistent> {
  const candidates = this.edit(invariant.address);
  
  // Try to merge into existing parent
  for (const candidate of candidates) {
    if (Address.includes(candidate.address, invariant.address)) {
      return write(candidate, invariant.address, invariant.value);
    }
  }
  
  // Remove obsolete children
  for (const candidate of candidates) {
    if (Address.includes(invariant.address, candidate.address)) {
      candidates.delete(candidate);
    }
  }
  
  candidates.put(invariant);
}
```

### 3. Rebase Operation

The rebase operation
(`packages/runner/src/storage/transaction/chronicle.ts:475-496`) applies pending
writes to a source attestation:

```typescript
rebase(source: IAttestation): Result<IAttestation, IStorageTransactionInconsistent> {
  let merged = source;
  
  for (const change of this.#model.values()) {
    if (Address.includes(source.address, change.address)) {
      const { error, ok } = write(merged, change.address, change.value);
      if (error) return { error };
      merged = ok;
    }
  }
  
  return { ok: merged };
}
```

## Performance Considerations

1. **Chronicle Lazy Initialization**: Chronicles are created on-demand per space
   (`packages/runner/src/storage/transaction/journal.ts:158-167`)

2. **Address String Keys**: Uses `${id}/${type}` for efficient lookups

3. **Minimal Invariant Set**: History actively prunes redundant invariants

4. **Single Writer Cache**: Avoids map lookups for common case

## Testing Considerations

When testing changes:

1. **State Transition Coverage**: Ensure all state transitions are tested,
   especially error paths

2. **Concurrency Scenarios**: Test invariant violations from concurrent
   modifications

3. **Address Edge Cases**:
   - Empty paths vs nested paths
   - Overlapping reads/writes
   - Data URI handling

4. **Error Recovery**: Verify transaction state after each error type

## Common Pitfalls

1. **Forgetting State Updates**: Always use `mutate()` to update transaction
   state

2. **Missing Error Propagation**: Chronicle errors must bubble up through
   Journal to Transaction

3. **Invariant Comparison**: Use `JSON.stringify` for deep equality (see
   `packages/runner/src/storage/transaction/chronicle.ts:307`)

4. **Resource Cleanup**: Ensure Chronicles are properly closed even on error
   paths

## Extension Points

To add new functionality:

1. **New Error Types**: Extend error interfaces in `interface.ts`

2. **Additional Metadata**: Extend `Activity` type for new tracking needs

3. **Custom Validation**: Hook into Chronicle's `commit()` method

4. **State Observers**: Subscribe to `IStorageSubscriptionCapability`
   notifications
