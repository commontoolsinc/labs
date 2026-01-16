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

## Read Path Analysis

### Current Flow

```typescript
// Production code calls:
tx.readValueOrThrow(address)
    ↓
ExtendedStorageTransaction.readOrThrow()
    ↓
StorageTransaction.read()
    ↓ calls reader()
StorageTransaction.reader(space)
    ↓ creates/caches
TransactionReader (never used as object)
    ↓ delegates to
Journal.read()
    ↓ calls checkout()
Chronicle.read()
    ↓ checks layers:
1. Inline data URIs
2. Novelty (working copy)
3. Replica (heap)
4. Capture in History
5. Merge novelty into result
```

### Chronicle.read() Implementation

**File**: `packages/runner/src/storage/transaction/chronicle.ts:166-225`

```typescript
read(address: IMemoryAddress): Result<IAttestation, ...> {
  // 1. Handle inline data URIs
  if (Address.isInline(address)) {
    return load(address);
  }

  // 2. Check if we previously wrote to this path
  const written = this.#novelty.get(address);
  if (written) {
    return read(written, address);
  }

  // 3. Read from replica (heap)
  const state = this.load(address);
  const loaded = attest(state);

  // 4. Capture in history for commit-time validation
  this.#history.put(loaded);

  // 5. Apply overlapping writes from novelty
  const changes = this.#novelty.select(address);
  const workingCopy = changes?.getWorkingCopy();
  if (workingCopy) {
    return read(workingCopy, address);
  }

  return { ok: loaded };
}
```

**Performance**: Reads are in the hot path. Chronicle.read() is efficient (O(1) map lookups), but getting there involves unnecessary indirection through reader objects.

---

## Write Path Analysis

### Current Flow

```typescript
// Production code calls:
tx.writeValueOrThrow(address, value)
    ↓
ExtendedStorageTransaction.writeOrThrow()
    ↓
StorageTransaction.write()
    ↓ calls writer()
StorageTransaction.writer(space)
    ↓ enforces single writer per tx
    ↓ creates/caches
TransactionWriter (never used as object)
    ↓ delegates to
Journal.write()
    ↓ calls checkout()
Chronicle.write()
    ↓ working copy pattern:
1. Get or create Changes
2. Initialize from replica (once)
3. Apply write to working copy (O(1))
```

### Chronicle.write() Implementation

**File**: `packages/runner/src/storage/transaction/chronicle.ts:122-164`

```typescript
write(address: IMemoryAddress, value?: JSONValue): Result<IAttestation, ...> {
  // Get or create Changes for this document
  const changes = this.#novelty.edit(address);

  // Initialize working copy from replica (only once per document)
  if (!changes.getWorkingCopy()) {
    const state = this.load({ id: address.id, type: address.type });
    changes.initFromReplica(attest(state));
  }

  // Apply write directly to working copy - O(1)
  return changes.applyWrite(address, value);
}
```

**Performance**: Working copy pattern is excellent. O(1) writes instead of O(N) rebase.

---

## Commit Phase Analysis

### Current Flow

```typescript
StorageTransaction.commit()
    ↓
Journal.close()
    ↓ for each Chronicle:
Chronicle.commit()
    ↓
1. Validate read invariants (History)
2. Build transaction from writes (Novelty working copies)
3. Return ITransaction
    ↓
StorageTransaction.commit() continued
    ↓
replica.commit(transaction)
```

### Chronicle.commit() Implementation

**File**: `packages/runner/src/storage/transaction/chronicle.ts:235-293`

```typescript
commit(): Result<ITransaction, IStorageTransactionInconsistent> {
  const edit = Edit.create();

  // Phase 1: Validate read invariants
  for (const invariant of this.history()) {
    const { ok: state, error } = claim(invariant, this.#replica);
    if (error) return { error }; // Another tx modified what we read
    edit.claim(state);
  }

  // Phase 2: Build transaction from writes
  for (const changes of this.#novelty) {
    const loaded = this.load(changes.address);
    const merged = changes.getWorkingCopy(); // Already merged, no rebase!

    if (deepEqual(merged.value, loaded.is)) {
      edit.claim(loaded); // No change
    } else if (merged.value === undefined) {
      edit.retract(loaded); // Deletion
    } else {
      edit.assert({ ...loaded, is: merged.value }); // Update
    }
  }

  return { ok: edit.build() };
}
```

**What commit needs**:
- Access to History (read invariants)
- Access to Novelty working copies
- Access to replica for validation

**What commit doesn't need**: Reader/Writer objects are never referenced.

---

## API Surface Actually Used

### Production Usage

Searched across `/home/user/labs/packages/runner/src/`:

**High Usage (20+ occurrences each)**:
- `tx.readValueOrThrow(address)` - read from /value/... path
- `tx.writeValueOrThrow(address, value)` - write to /value/... path

**Medium Usage (5+ occurrences)**:
- `tx.readOrThrow(address)` - read any path
- `tx.writeOrThrow(address, value)` - write any path

**Low Usage (2-5 occurrences)**:
- `tx.read(address)` - Result-returning read
- `tx.write(address, value)` - Result-returning write
- `tx.commit()` / `tx.abort()`

**Never Used as Separate Objects**:
- `tx.reader(space)` - only called internally in transaction.ts line 226
- `tx.writer(space)` - only called internally in transaction.ts line 276
- `TransactionReader` - instantiated but never stored/used
- `TransactionWriter` - instantiated but never stored/used

**Evidence**:
```bash
$ grep -r "\.reader\(" packages/runner/src --include="*.ts" | grep -v "test"
packages/runner/src/storage/transaction.ts:    const { ok: space, error } = reader(transaction, address.space);
packages/runner/src/storage/extended-storage-transaction.ts:  reader(space: MemorySpace): Result<ITransactionReader, ReaderError> {

$ grep -r "\.writer\(" packages/runner/src --include="*.ts" | grep -v "test"
packages/runner/src/storage/transaction.ts:    const { ok: space, error } = writer(transaction, address.space);
packages/runner/src/storage/extended-storage-transaction.ts:  writer(space: MemorySpace): Result<ITransactionWriter, WriterError> {
```

Only usage is internal delegation in the transaction layer itself.

---

## Over-Engineered Components

### 1. TransactionReader Class

**File**: `packages/runner/src/storage/transaction/journal.ts:297-315`

**Purpose**: Wraps Journal + space DID, delegates read() back to Journal.read()

**Problem**: Never used as a separate object in production code

**Complexity Cost**:
- 18 lines of class definition
- Map maintenance in Journal (line 31)
- Caching logic (lines 187-208)
- Interface definition in interface.ts

**What it does**:
```typescript
class TransactionReader {
  read(address) {
    return read(this.#journal, this.#space, address);
  }
}
```

Just wraps a function call with object syntax.

---

### 2. TransactionWriter Class

**File**: `packages/runner/src/storage/transaction/journal.ts:321-349`

**Purpose**: Wraps Journal + space DID, delegates read()/write() back to Journal

**Problem**: Never used as a separate object in production code

**Complexity Cost**:
- 28 lines of class definition
- Map maintenance in Journal (line 32)
- Caching logic (lines 210-233)
- Write isolation enforcement at wrong layer
- Interface definition in interface.ts

**What it does**:
```typescript
class TransactionWriter {
  read(address) {
    return read(this.#journal, this.#space, address);
  }
  write(address, value) {
    return write(this.#journal, this.#space, address, value);
  }
}
```

Just wraps function calls with object syntax.

---

### 3. Multi-Level Writer Caching

**Problem**: Writer cached at TWO levels for no benefit

**Transaction level** (transaction.ts:46):
```typescript
export type EditableState = {
  status: "ready";
  storage: IStorageManager;
  journal: Journal.Journal;
  writer: ITransactionWriter | null;  // <-- Cache 1
};
```

**Journal level** (journal.ts:32):
```typescript
export interface OpenState {
  status: "open";
  storage: IStorageManager;
  readers: Map<MemorySpace, TransactionReader>;
  writers: Map<MemorySpace, TransactionWriter>;  // <-- Cache 2
}
```

**Why redundant**:
- Write isolation means only ONE writer can exist per transaction
- Transaction.writer() enforces single-space constraint (lines 184-194)
- Second cache serves no purpose

**Consequence**: Write isolation check happens at wrong layer. Should be in Chronicle (where the state lives) not in Transaction (which is just coordination).

---

### 4. Reader Map

**File**: `packages/runner/src/storage/transaction/journal.ts:31`

```typescript
readers: Map<MemorySpace, TransactionReader>;
```

**Problem**:
- Readers have no isolation constraints
- Never used as separate objects
- Map adds overhead without benefit

**Evidence**: Production code never calls `tx.reader(space)` to get a reader object and store it. Always calls `tx.read(address)` directly.

---

### 5. ITransactionReader Interface

**File**: `packages/runner/src/storage/interface.ts`

**Problem**: Only has one method: `read()`. ITransactionWriter extends it with `write()`.

**Simpler alternative**: No interface needed. Transaction.read()/write() methods are the interface.

---

## What's Actually Needed

### For Reads (Hot Path)

```typescript
tx.read(address: IMemorySpaceAddress) -> Result<IAttestation, ReadError>
```

Needs to:
1. Extract space from address
2. Get/create Chronicle for that space
3. Call Chronicle.read(address)
4. Track activity for scheduler

Current unnecessary overhead:
- Creating/caching TransactionReader object
- Two map lookups (readers cache, then branches)

---

### For Writes

```typescript
tx.write(address: IMemorySpaceAddress, value?: JSONValue) -> Result<IAttestation, WriteError>
```

Needs to:
1. Extract space from address
2. Get/create Chronicle for that space
3. Call Chronicle.write(address, value)
4. Track activity for scheduler

Current unnecessary overhead:
- Creating/caching TransactionWriter object
- Write isolation check at wrong layer (Transaction instead of usage site)
- Two-level cache (Transaction.writer + Journal.writers)

---

### For Commit

```typescript
tx.commit() -> Promise<Result<Unit, CommitError>>
```

Needs:
1. Close journal (freezes transaction)
2. For each Chronicle:
   - Validate read invariants (History)
   - Build transaction from writes (Novelty working copies)
3. Commit to replica

Current unnecessary overhead:
- Reader/Writer objects exist but are never referenced
- Maps maintained but not used

---

## Proposed Simplification

### Option A: Flatten to Two Layers (Recommended)

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

### Option B: Remove Reader/Writer Classes Only (Conservative)

**Keep three layers, remove Reader/Writer abstraction.**

```typescript
// Journal remains, but no Reader/Writer classes
export const read = (
  journal: IJournal,
  space: MemorySpace,
  address: IMemoryAddress,
): Result<IAttestation, ReadError> => {
  const { ok: branch, error } = checkout(journal, space);
  if (error) return { error };

  journal.state.activity.push({ read: { ...address, space } });
  return branch.read(address);
}

export const write = (
  journal: IJournal,
  space: MemorySpace,
  address: IMemoryAddress,
  value?: JSONValue,
): Result<IAttestation, WriteError> => {
  const { ok: branch, error } = checkout(journal, space);
  if (error) return { error };

  journal.state.activity.push({ write: { ...address, space } });
  return branch.write(address, value);
}
```

**Benefits**:
- Removes ~46 lines of Reader/Writer classes
- Removes two map structures
- Simpler API: functions instead of objects
- Keeps three-layer separation if desired for testing/modularity

**Trades**:
- Still have Journal layer (less dramatic simplification)
- Still have checkout() indirection

---

### Option C: Remove Multi-Level Caching (Minimal)

**Keep Reader/Writer, remove redundant caches.**

Remove `writer: ITransactionWriter | null` from EditableState.

Remove `readers` and `writers` maps from OpenState. Create fresh each time.

**Benefits**:
- Removes cache maintenance
- Simplifies state

**Trades**:
- Still have Reader/Writer abstraction
- Minimal improvement

---

## Recommendation

**Use Option A: Flatten to Two Layers**

### Rationale

1. **Aligns with actual usage**: Production code never uses Reader/Writer as separate objects
2. **Optimizes hot path**: Reads are critical, reducing indirection helps
3. **Removes write isolation from wrong layer**: Can move enforcement to usage sites
4. **Simplifies significantly**: ~200 lines removed, 2 fewer classes, 2 fewer maps
5. **Keeps what works**: Chronicle's working copy pattern is excellent, preserve it

### What Chronicle Does Well

**Don't change these**:

- **Working copy pattern** (CT-1123): O(1) writes instead of O(N) rebase
- **History management**: Only stores first read per path for validation
- **Address helpers**: Clean, focused path inclusion/intersection logic
- **Structural sharing**: setAtPath() uses structural sharing instead of deep cloning
- **Layer checking**: Inline data → Novelty → Replica → History

### Migration Path

1. **Phase 1**: Audit all usages of ITransactionReader/ITransactionWriter interfaces
   - Expect: only in transaction.ts and interface.ts
   - If found elsewhere, refactor first

2. **Phase 2**: Remove Reader/Writer from Journal
   - Make read() and write() free functions (already are internally)
   - Update Journal.reader()/writer() to just call read()/write()
   - Remove readers and writers maps

3. **Phase 3**: Flatten Transaction → Journal
   - Move branches map to Transaction
   - Move activity array to Transaction
   - Remove Journal class
   - Update Transaction methods to call Chronicle directly

4. **Phase 4**: Clean up interfaces
   - Remove ITransactionReader, ITransactionWriter
   - Update IStorageTransaction interface

5. **Phase 5**: Update tests
   - Tests that use reader()/writer() directly need updates
   - Most tests should pass with minimal changes

---

## Questions for Discussion

1. **Write isolation**: Currently enforced in Transaction.writer(). Where should it move?
   - Option 1: Remove entirely (user's suggestion: let one tx fail at commit if conflict)
   - Option 2: Keep check but in Chronicle.write()
   - Option 3: Keep check in Transaction (even if no writer object)

2. **Activity tracking**: Currently in Journal. Should it move to:
   - Transaction (simpler)
   - Chronicle (more granular, but duplicated across spaces)

3. **Testing**: Should we preserve reader()/writer() as test-only APIs?
   - Pro: Less test disruption
   - Con: Maintains dead code

4. **Backwards compat**: Is ITransactionReader/ITransactionWriter in public API?
   - Check: Are these exported from runner package index?
   - If yes: Deprecate first, remove in next major version
   - If no: Remove immediately

---

## Appendix: File Line Counts

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

After Option A simplification (estimated):

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

The transaction system's Reader/Writer abstraction is a classic case of premature optimization. It was designed to handle complex concurrent transaction scenarios that rarely occur in practice, while adding overhead to the common case (simple read/write/commit flow).

By flattening to two layers (Transaction → Chronicle) and removing the unused Reader/Writer classes, we can:

- Reduce code by ~24% (500 lines)
- Optimize the hot path (reads)
- Simplify the mental model
- Preserve what works (Chronicle's working copy pattern)
- Align code structure with actual usage patterns

The resulting design would be "as simple as possible, but no simpler" - it would handle the actual usage patterns efficiently without over-engineering for rare edge cases.
