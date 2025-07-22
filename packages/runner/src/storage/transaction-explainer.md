# Storage Transaction Abstraction Explainer

The storage transaction system provides ACID-like guarantees for reading and
writing data across memory spaces. Think of it as a database transaction but for
a distributed, content-addressed memory system.

## Core Architecture

The transaction system is built in three layers:

1. **StorageTransaction**
   (`packages/runner/src/storage/transaction.ts:63-107`) - The main API surface
   that manages transaction lifecycle
2. **Journal** (`packages/runner/src/storage/transaction/journal.ts:52-100`) -
   Tracks all reads/writes and enforces consistency
3. **Chronicle**
   (`packages/runner/src/storage/transaction/chronicle.ts:51-223`) - Manages
   changes per memory space with conflict detection

## How It Works

### Transaction Lifecycle

A transaction moves through three states:

1. **Ready** - Active and accepting reads/writes
2. **Pending** - Commit initiated, waiting for storage confirmation
3. **Done** - Completed (successfully or with error)

```typescript
// Create a new transaction
const transaction = create(storageManager);

// Read and write operations
const readResult = transaction.read({
  space: "user",
  id: "123",
  type: "application/json",
  path: ["name"],
});
const writeResult = transaction.write({
  space: "user",
  id: "123",
  type: "application/json",
  path: ["age"],
}, 25);

// Commit changes
const commitResult = await transaction.commit();
```

### Key Design Principles

**1. Write Isolation**: A transaction can only write to one memory space. This
prevents distributed consistency issues:

```typescript
// First write locks the transaction to "user" space
transaction.write({ space: "user", ... }, data);  

// This will fail with WriteIsolationError
transaction.write({ space: "project", ... }, data);
```

**2. Read Consistency**: All reads capture "invariants" - assumptions about the
state when read. If any invariant is violated before commit, the transaction
fails:

```typescript
// Transaction reads age = 30
const age = transaction.read({ ...address, path: ["age"] });

// Another client changes age to 31

// This transaction's commit will fail due to inconsistency
```

**3. Optimistic Updates**: Writes within a transaction see their own changes
immediately:

```typescript
transaction.write({ ...address, path: ["name"] }, "Alice");
const name = transaction.read({ ...address, path: ["name"] }); // Returns "Alice"
```

## Internal Mechanics

### Journal (`packages/runner/src/storage/transaction/journal.ts`)

The Journal manages transaction state and coordinates between readers/writers:

- Maintains separate Chronicle instances per memory space
- Tracks all read/write activity for debugging and replay
- Enforces single-writer constraint
- Handles transaction abort/close lifecycle

### Chronicle (`packages/runner/src/storage/transaction/chronicle.ts`)

Each Chronicle manages changes for one memory space:

- **History**: Tracks all read invariants to detect conflicts
- **Novelty**: Stores pending writes not yet committed
- **Rebase**: Merges overlapping writes intelligently

Key operations:

1. **Read** - Checks novelty first (uncommitted writes), then replica, captures
   invariant
2. **Write** - Validates against current state, stores in novelty
3. **Commit** - Verifies all invariants still hold, builds final transaction

### Attestation System

All reads and writes produce "attestations" - immutable records of observed or
desired state:

```typescript
interface IAttestation {
  address: IMemoryAddress; // What was read/written
  value?: JSONValue; // The value (undefined = deleted)
}
```

## Error Handling

The system uses Result types extensively with specific errors:

- **TransactionCompleteError** - Operation on finished transaction
- **WriteIsolationError** - Attempting to write to second space
- **StateInconsistency** - Read invariant violated
- **ReadOnlyAddressError** - Writing to data: URIs

## Advanced Features

**1. Data URIs**: Read-only inline data using `data:` URLs

**2. Path-based Access**: Read/write nested JSON paths:

```typescript
transaction.read({ ...address, path: ["user", "profile", "name"] });
```

**3. Activity Tracking**: All operations recorded for debugging:

```typescript
for (const activity of transaction.journal.activity()) {
  // Log reads and writes
}
```

**4. Consistency Validation**: Chronicle's commit method
(`packages/runner/src/storage/transaction/chronicle.ts:176-222`) carefully
validates that all read invariants still hold before building the final
transaction.

This architecture ensures strong consistency guarantees while allowing
optimistic updates within a transaction boundary, making it suitable for
collaborative editing scenarios where multiple clients may be modifying data
concurrently.
