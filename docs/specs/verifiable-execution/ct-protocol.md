# CT Protocol: Verifiable State Update & Provenance

**Status:** Draft

**Audience:** Systems implementing verifiable, privacy-preserving state updates
with optional verifiable credentials and optional authenticated latest-pointer
maps.

---

## 1. Introduction: From Asserted Trust to Verifiable Trust

Modern software systems often make claims before they make arguments. We are
told that a model was trained responsibly, that a score reflects genuine
activity, that a message really came from its purported author, that a user gave
meaningful consent. The evidence, when it exists at all, is usually indirect:
dashboards, PDFs, policy pages, institutional reputation. **Trust is asserted,
then defended socially rather than demonstrated structurally.**

This pattern no longer scales. Systems are larger, more automated, and more
intertwined; the consequences of error or misrepresentation are higher; and the
parties asked to trust them are often remote in space, time, and incentives.

The CT Protocol begins from a different premise: **trust should be _derivable_,
not declarative.** A claim should be accompanied by the evidence that produced
it, structured so that an independent verifier can replay the reasoning without
privileged access. Trust, in this view, is not a favor granted by authority, but
a property that emerges from how a system is built.

### 1.1 Core Features

- **Mandatory append-only log** maintained by a single server
- **Multi-signer receipts** with state-based authorization (ACL + delegation)
- **Contextual Flow Control (CFC)** labels on data and computations, enabling
  end-to-end integrity and confidentiality guarantees

### 1.2 Optional Add-ons

- **Authenticated latest pointers** (verifiable entity → latest update mapping)
- **Verifiable Credentials (VCs)** issued on-demand for any data point
- **Trusted Execution Environment (TEE)** attestations for computation integrity
  and (when present) CFC compliance
- **Verifiable time bounds**, including cryptographic _lower bounds_ ("not
  before t")

The core system remains lightweight: it does **not** require maintaining a
mutable ordered keyspace (e.g., MST). Optional components are independently
verifiable and can be requested or omitted per use case.

---

## 2. Design Goals

- **Cheap verification:** Proof sizes and verification cost scale with _what is
  checked_, not total history.
- **Privacy by default:** Inputs and intermediate data are not exposed; only
  commitments and proofs are published.
- **Strong provenance:** Every update is cryptographically linked to its
  predecessors and inputs.
- **Policy-compliant computation:** CFC labels travel with data, and
  computations can be verified to respect integrity and confidentiality
  constraints.
- **Modular add-ons:** Latest-pointer maps and VCs are optional and orthogonal.
- **Non-equivocation ready:** Equivocation can be detected and constrained via
  checkpoint chains.
- **No unnecessary authority:** The system resists centralization by ensuring
  that servers order but do not authorize, policies constrain but do not
  execute, and UIs present but do not invent.

---

## 3. Core Concepts

### 3.1 Entity

An **Entity** identifies a named object whose state evolves over time.

- Examples: document URI (`of:ba4jc...`), object handle, dataset name, account
  DID
- Canonical form MUST be deterministic (URI format: `${scheme}:${identifier}`)
- In the current implementation, entities are identified by `URI` type
  (`${string}:${string}`)

### 3.2 Fact

Most systems treat state as something that simply _is_: a set of rows in a
database, a collection of files on disk, a snapshot held in memory. Changes
happen, but the change itself is rarely preserved as a first-class object. At
best, there is an audit log; at worst, only the latest value survives.

**The CT Protocol inverts this perspective.** A state change is not an
incidental side effect; it is the primary event. A **Fact** represents state at
a point in time:

- **Assertion**: Current state with value (`{the, of, is, cause}`)
- **Retraction**: Tombstone indicating prior state no longer holds
  (`{the, of, cause}`)
- **Unclaimed**: The initial/genesis state before any assertion
  (`{the, of}` with no `is` or `cause`)

State MAY be represented as:

- Full materialized state (content-addressed via merkle-reference), or
- A patch applied to a prior state

Implementations MUST produce a deterministic hash for every update via the
`merkle-reference` library.

### 3.3 Receipt

A **Receipt** is the atomic, append-only record of a state update.

Receipts are deliberately precise—and deliberately limited. They bind to the
content they reference via cryptographic hashes and to the actor that produced
them via a signature. **They do not claim semantic correctness, moral
legitimacy, or future validity. They record _what happened_, not _what should
have happened_.** That discipline is what makes receipts composable and
verifiable.

Each receipt also serves as a **computation envelope**:

- commits to code and inputs
- commits to output state
- commits to CFC label commitments (schema-derived, path-granular) and a policy identifier

By treating receipts as the unit of history, the CT Protocol makes the past
inspectable. One can trace not just the current state of a system, but the
sequence of decisions and derivations that led there.

### 3.4 Pattern

A **Pattern** is the universal unit of executable logic in the fabric:
composable, reactive programs that define how state evolves and how users
interact with it. Patterns describe both application behavior and user
interfaces, and they react continuously to changes in fabric state and events.

Patterns are rarely retired; once instantiated they are woven into the fabric
and continue to react over time. Most reactions are pull-based—triggered when
state is observed or consulted—with optional periodic refresh for long-running
processes.

Because trust in the CT Protocol is narrow, explicit, and mechanically enforced,
**patterns do not need to be trusted in order to be run.** They are safe by
construction under Contextual Flow Control: they cannot exfiltrate data,
escalate privileges, or violate context without explicit policy. As a result,
patterns may be instantiated _speculatively_—woven into the fabric and allowed
to react to existing state before any user has explicitly engaged with them.

### 3.5 Space

A **Space** is a logical database/namespace whose state, policies, and
permissions evolve over time:

- Identified by a `did:key` (`MemorySpace` type: `did:${string}:${string}`)
- Owns its ACL and delegation state
- The server maintains the append-only log but does NOT determine authorization

Each user operates a **personal fabric**: a collection of spaces, policies, and
running patterns that reflect their interests and intentions. The cryptographic
keys that anchor authorization ultimately live on the user's own devices.
Providers act only as delegated executors, operating under user-granted
authority that can be renewed or revoked.

---

## 4. Fact Structure

### 4.1 Core Fact Types

The fundamental data model uses `{the, of, is, cause}` tuples:

```typescript
// Media type - adds a dimension for different "views" of an entity
type MIME = `${string}/${string}`; // e.g., "application/json"

// Entity identifier
type URI = `${string}:${string}`; // e.g., "of:ba4jcbvpq3k5..."

// Merkle reference - content-addressed hash
type Reference<T> = { "/": string }; // e.g., { "/": "baedrei..." }

// An assertion - current state with value
interface Assertion {
  the: MIME; // Kind of fact (e.g., "application/json")
  of: URI; // Entity identifier
  is: JSONValue; // The actual state data
  cause: Reference<Fact> | Reference<Unclaimed>; // Prior state reference
}

// A retraction - tombstone for deleted state
interface Retraction {
  the: MIME;
  of: URI;
  is?: undefined; // No value - this is a deletion
  cause: Reference<Assertion>; // Must point to the assertion being retracted
}

// Unclaimed - represents non-existent/genesis state
interface Unclaimed {
  the: MIME;
  of: URI;
  is?: undefined;
  cause?: undefined; // No prior state
}

type Fact = Assertion | Retraction;
type State = Fact | Unclaimed;
```

### 4.2 Causality and Genesis

Every fact has a causal reference to the prior fact. This establishes linear
history of changes for each entity:

1. **Genesis State**: The first assertion for an entity has `cause` pointing to
   the hash of `{the, of}` (the Unclaimed state). This is computed as:
   ```typescript
   const genesisCause = refer({ the, of }); // Hash of unclaimed state
   ```

2. **Subsequent States**: Each subsequent assertion or retraction points to the
   hash of the previous fact, creating a chain.

3. **Compare-and-Swap (CAS)**: The `cause` field enables optimistic concurrency.
   A transaction is rejected if the provided `cause` doesn't match the current
   state.

### 4.3 The `the` Field (Media Type)

The `the` field adds a dimension for storing different "views" of an entity:

- `"application/json"` - Standard JSON data
- `"application/commit+json"` - Commit/audit records
- `"application/meta+json"` - Metadata about an entity
- `"application/acl+json"` - Access control lists

This allows multiple facts about the same entity (`of`) with different types
(`the`), each with its own causal chain.

---

## 5. Commit Structure

### 5.1 What is a Commit?

A **Commit** is a special fact type that records a complete transaction for
audit purposes. Every transaction that modifies state also creates a commit
record.

```typescript
// The commit media type
const COMMIT_LOG_TYPE = "application/commit+json";

// Commit data structure
interface CommitData {
  since: number; // Lamport clock / sequence number
  transaction: Transaction; // The complete transaction that was applied
  labels?: FactSelection; // Optional label facts used for redaction/access control
}

// A commit is stored as a Fact
type CommitFact = Assertion<
  "application/commit+json", // the
  MemorySpace, // of (the space DID)
  CommitData // is
>;
```

### 5.2 Commit Creation

When a transaction is processed:

```typescript
// Create a commit record
const commit = {
  the: "application/commit+json",
  of: space, // The space DID (e.g., "did:key:z6Mk...")
  is: {
    since: nextSequenceNumber,
    transaction: transaction, // Full transaction including all changes
    labels: extractedLabels, // Optional label facts for redaction/access control
  },
  cause: previousCommitReference, // Or unclaimed for first commit
};
```

### 5.3 Genesis Commit

The **first commit** in a space has special significance:

1. Its `cause` field points to the Unclaimed reference for the space:
   ```typescript
   const genesisCause = refer({
     the: "application/commit+json",
     of: spaceDID,
   });
   ```

2. This establishes the **root of trust** for the space. The genesis commit
   effectively bootstraps the space's history.

3. For full trust anchoring, the genesis commit SHOULD be signed by the space
   DID itself (not a delegated signer).

### 5.4 Commit Chain

Commits form a chain just like regular facts:

```
Genesis Commit (cause: unclaimed)
    ↓
Commit #1 (cause: genesis)
    ↓
Commit #2 (cause: commit #1)
    ↓
   ...
```

This chain provides:
- **Total ordering** of all transactions in the space
- **Audit trail** - every transaction is recorded with its full content
- **Consistency anchor** - verifiers can trace the complete history

### 5.5 Wire Format

The commit structure on the wire (e.g., in responses):

```typescript
type Commit<Subject extends MemorySpace> = {
  [space in Subject]: {
    ["application/commit+json"]: {
      [cause: CauseString]: {
        is: CommitData;
      };
    };
  };
};

// Example:
{
  "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi": {
    "application/commit+json": {
      "baedreigv6dnlwjzyyzk2z2ld2kapmu6hvqp46f3axmgdowebqgbts5jksi": {
        "is": {
          "since": 42,
          "transaction": { /* ... */ }
        }
      }
    }
  }
}
```

### 5.6 Transaction Structure (Current Implementation)

The current implementation uses strict CAS (compare-and-swap) semantics at the
entity level:

```typescript
type Transaction = {
  cmd: "/memory/transact";
  sub: MemorySpace; // Space DID
  args: {
    changes: Changes;
  };
};

type Changes = {
  [of: URI]: {
    [the: MIME]: {
      [cause: CauseString]: Assert | Retract | Claim;
    };
  };
};

type Assert = { is: JSONValue }; // Add or update
type Retract = { is?: undefined }; // Delete
type Claim = true; // Verify without modifying
```

**The Claim variant** is key for consistency: it validates that a fact's current
state matches the specified cause *without modifying it*. This enables
STM-style (Software Transactional Memory) transactions where you list all facts
you read to produce an update, ensuring none have changed.

```typescript
// Example: Update user age, but only if name hasn't changed
const transaction = {
  changes: {
    "user:alice": {
      "application/json": {
        // Claim: verify name fact still has this cause (read dependency)
        "baedrei...nameHash": true,
        // Assert: update age fact
        "baedrei...ageHash": { is: { age: 31 } },
      },
    },
  },
};
```

**Relationship to activity tracking:** The `Claim` variant serves transaction
validation (CAS on reads), while activity tracking in commits (see 6.2) serves
scheduling and provenance. Current implementation uses Claims; future path-level
activity enables finer-grained invalidation.

### 5.7 Concurrent Transaction Handling (Current CAS Model)

The current implementation uses strict CAS semantics. When concurrent updates
target the same entity, only one succeeds:

```
Timeline:
─────────────────────────────────────────────────────────────────────

Client A                    Server                    Client B
    │                          │                          │
    │  Read user:alice         │                          │
    │  ───────────────────────>│                          │
    │  {name: 'Alice'}         │                          │
    │  cause: H1               │                          │
    │  <───────────────────────│                          │
    │                          │                          │
    │                          │    Read user:alice       │
    │                          │<─────────────────────────│
    │                          │    {name: 'Alice'}       │
    │                          │    cause: H1             │
    │                          │─────────────────────────>│
    │                          │                          │
    │  Update: add job         │                          │
    │  cause: H1               │                          │
    │  ───────────────────────>│                          │
    │  ✅ Success              │                          │
    │  <───────────────────────│                          │
    │                          │                          │
    │                          │    Update: add age       │
    │                          │    cause: H1             │
    │                          │<─────────────────────────│
    │                          │    ❌ Rejected           │
    │                          │    (cause mismatch)      │
    │                          │─────────────────────────>│
    │                          │                          │
    │                          │    Re-read user:alice    │
    │                          │<─────────────────────────│
    │                          │    {name: 'Alice',       │
    │                          │     job: 'Engineer'}     │
    │                          │    cause: H2             │
    │                          │─────────────────────────>│
    │                          │                          │
    │                          │    Update: add age       │
    │                          │    cause: H2             │
    │                          │<─────────────────────────│
    │                          │    ✅ Success            │
    │                          │─────────────────────────>│
```

**Key points:**
- Each change must reference the current `cause` hash
- If cause doesn't match current state → transaction rejected
- Client must re-read and retry with updated cause
- Non-conflicting updates (different entities) proceed independently

### 5.8 Client State: Nursery and Heap (Current CAS Model)

Clients maintain two areas for tracking state:

- **Heap**: Confirmed state from server (has real `cause` hashes)
- **Nursery**: Pending/unconfirmed writes (optimistic, may be rejected)

With current CAS semantics, the flow is:

```
1. Client reads entity from heap (cause: H1)
2. Client computes update locally → nursery
3. Client sends transaction with cause: H1
4. If accepted: nursery state moves to heap
5. If rejected (cause mismatch): discard nursery, re-read, retry
```

**Stacked pending commits** can reference nursery state:

```
C1 sent → nursery (writes X with cause H1)
C2 created (reads X from nursery) → sent → nursery
C1 confirmed → X moves to heap
C2 depends on C1's success
```

If C1 fails (cause mismatch), C2 also fails. The client must re-read and rebuild
both transactions.

### 5.9 Server Processing (Current CAS Model)

When the server processes a transaction:

1. **Validate all cause references**: Each must match current state
2. **If any mismatch**: Reject entire transaction
3. **If all match**: Apply atomically, assign next `since`, record commit

```typescript
// Server validation pseudocode
for (const [of, types] of Object.entries(changes)) {
  for (const [the, revisions] of Object.entries(types)) {
    for (const [cause, change] of Object.entries(revisions)) {
      const current = getCurrentFact(of, the);
      if (hash(current) !== cause) {
        return { error: "cause_mismatch", of, the, expected: cause };
      }
    }
  }
}
// All causes match - apply transaction atomically
```

---

## 5.10 Future: Enhanced Commit Model

The following sections describe planned enhancements to support offline
operation, stacked commits, and relaxed validation. These build on the current
CAS model.

### 5.10.1 Client Commit Structure (Enhanced)

Future commits explicitly track confirmed vs pending references:

```typescript
interface ClientCommit {
  reads: {
    // From heap - confirmed, has real since
    confirmed: Array<{
      address: Address;
      hash: Hash;
      since: number;
    }>;

    // From nursery - pending, referenced by commit hash
    pending: Array<{
      address: Address;
      hash: Hash; // Provisional (may change)
      fromCommit: Reference<Commit>;
    }>;
  };

  writes: Array<{
    address: Address;
    value: JSONValue;
    cause: Hash;
  }>;

  codeCID?: Reference<CodeBundle>;
  activity?: ReceiptActivity;
}
```

### 5.10.2 Relaxed Validation Rules (Future)

**Relaxed validation** allows `since`-based comparison instead of strict CAS:

1. **For reads**: Record hash AND `since` of what was read
2. **For writes**: CAS only when causally dependent on prior value

**Validation rule:**

```
A commit is valid if for all overlapping entities:
  new_commit.reads[entity].since >= prior_commit.writes[entity].since
```

This means: "my inputs are at least as fresh as whatever the current state was
based on." Freshness is determined by `since`, not hash ancestry.

### 5.10.3 Commit Log Entry Structure (Future)

The commit log preserves both original submission and server resolution:

```typescript
interface CommitLogEntry {
  original: SignedClientCommit;
  resolution: {
    since: number;
    commitResolutions: Map<Reference<Commit>, number>;
    hashMappings?: Map<Hash, Hash>; // provisional → final
  };
}
```

**Why hashes can differ:** The hash of a fact includes its `cause`. If the cause
was provisional (from nursery), the final hash changes when resolved.

### 5.11 Document → Commit Provenance

Clients must always know which commit produced any document they receive. This
enables:

- **Auditability**: Trace how any data was computed
- **Verification**: Check the authorization and code that produced the data
- **Reactivity**: Know when upstream data has changed

**The `since` field as provenance link:**

All facts produced by a commit share the same `since` value. This creates a
direct relationship:

```
Document (fact) → since=N → Commit with since=N
```

Given any fact, the client can find the producing commit by querying for the
commit fact with matching `since`:

```sql
SELECT * FROM fact
WHERE the = 'application/commit+json' AND since = :fact_since
```

**Subscription and query protocol:**

The existing subscription/query API ensures that when data is returned, the
client also receives the commits that produced it:

- **Query responses** include commits for all returned facts
- **Subscription updates** deliver the producing commit alongside data changes
- If a fact was produced by an older commit the client hasn't seen, that commit
  is included in the response

This guarantee means clients always have provenance for any data they receive
without needing a separate commit-fetching API.

**Scheduler staleness detection:**

The scheduler uses commit activity (path-level reads/writes) to determine
whether data is current:

1. **Path-level `since` tracking**: The scheduler tracks `since` for each path
   it reads. When a commit arrives with writes to a specific path, only
   computations reading that exact path are invalidated.

2. **Compare `since` values**: If the scheduler has data at path P with
   `since=N`, and sees a commit with `since=M` where `M > N` that writes to
   path P, only that path is stale.

3. **Efficient invalidation**: Without path-level granularity, any change to
   entity X would invalidate ALL computations touching ANY part of X. Path
   tracking enables precise, minimal re-computation.

This works with the current CAS-based commit semantics. The key requirement is
activity tracking in commits (address-level reads/writes) to know which paths
changed.

**Client verification:**

For any document received, the client can:

1. Look up the commit by `since`
2. Verify the commit's signature and authorization
3. Check the `codeCID` to see what code produced it
4. Examine the commit's `reads` to trace input provenance

This gives clients end-to-end visibility into how their data was computed.

### 5.12 Efficient Commit Lookup

To efficiently find commits by `since`, the storage layer should maintain:

1. **Index on `(the, since)`**: For fast commit lookup by sequence number
2. **Or a dedicated commit table**: Mapping `since → commit reference`

Current implementation uses SQLite with an index on `since`. Adding a compound
index optimizes the common query pattern:

```sql
-- Fast commit lookup
CREATE INDEX fact_the_since ON fact (the, since);
```

This enables O(log n) lookup of any commit by its `since` value.

---

## 6. Capabilities API

The Memory protocol defines capabilities as UCAN invocations. Each capability
requires a valid delegation chain rooted in the space's `did:key`.

### 6.1 `/memory/transact`

Atomically assert, retract, or claim facts in a space.

**Request:**

```typescript
type TransactInvocation = {
  iss: DID; // Issuer (who is invoking)
  sub: MemorySpace; // Subject (space DID)
  cmd: "/memory/transact";
  args: {
    changes: Changes;
  };
  prf: Reference<Delegation>[]; // Proof chain to space owner
  exp: number; // Expiration
  nonce: Bytes;
};
```

**Processing:**

1. Verify UCAN delegation chain to space DID
2. Validate all cause references (CAS)
3. Apply all changes atomically or reject entirely
4. Record commit in transaction log
5. Return success with new `since` value, or error

**Response:**

```typescript
type TransactResult =
  | { ok: { since: number } }
  | { error: "cause_mismatch"; of: URI; the: MIME; expected: Hash }
  | { error: "unauthorized" };
```

### 6.2 `/memory/query`

Retrieve facts from a space, optionally at a specific logical time.

**Request:**

```typescript
type QueryInvocation = {
  iss: DID;
  sub: MemorySpace;
  cmd: "/memory/query";
  args: {
    select: Selector;
    since?: number; // Optional: only facts after this time
  };
  prf: Reference<Delegation>[];
  exp: number;
  nonce: Bytes;
};

type Selector = {
  [of: URI]: {
    [the: MIME]: {
      [cause: CauseString]: { is?: {} }; // Empty object = include value
    };
  };
};
```

**Wildcards:** The RFC uses `'_'` to match any value. For example:
- `{ "_": { "_": {} } }` - all facts
- `{ "user:alice": { "_": {} } }` - all facts for user:alice
- `{ "_": { "application/json": {} } }` - all JSON facts

**Response:**

```typescript
type QueryResult = {
  ok: {
    facts: FactSelection;
    commit: Commit; // The commit at query time
    since: number; // Logical time of snapshot
  };
};
```

All results represent a consistent snapshot at a specific `since` value.

**CFC note:** When CFC/IFC is enabled, implementations MAY redact classified
values (including at path granularity, as defined by schemas) by omitting `is`
fields and/or returning a filtered value.

### 6.3 `/memory/subscribe`

Receive push-based updates when facts change.

**Request:**

```typescript
type SubscribeInvocation = {
  iss: DID;
  sub: MemorySpace;
  cmd: "/memory/subscribe";
  args: {
    select: Selector;
    since?: number; // Start from this logical time
  };
  prf: Reference<Delegation>[];
  exp: number;
  nonce: Bytes;
};
```

**Updates pushed to client:**

```typescript
type SubscriptionUpdate = {
  facts: FactSelection; // Changed facts matching selector
  commit: Commit; // The commit that made these changes
  since: number; // New logical time
};
```

**Key properties:**

- Push-based complement to poll-based `/memory/query`
- Reduces latency vs polling
- Enables reactive applications and real-time replication
- Subscription includes producing commit for provenance

**CFC note:** Subscription payloads MUST respect the subscriber's CFC/IFC
context (e.g., via redaction of classified values as defined by schemas).

---

## 7. Receipt Object (Future Enhancement)

### 7.1 UnsignedReceipt

The receipt structure extends the current `Fact` model with computation
metadata:

```typescript
interface UnsignedReceipt {
  // Core fact identity (existing)
  the: MIME;
  of: URI;
  cause: Reference<Fact>;

  // Computation identity (new)
  codeCID: Reference<CodeBundle>; // Content-addressed code bundle

  // Inputs (new)
  inputCommitments: Hash[]; // H(salt || canonical(input))
  inputRefs?: Reference<Fact>[]; // Optional provenance references
  inputLabelCommitments: Hash[]; // H("CT/CFCLabelMap" || canonical(labelMap))

  // CFC policy (new)
  cfcPolicyCID: Reference<CFCPolicy>; // Content-addressed policy identifier

  // Result
  is?: JSONValue;
  stateHash: Hash; // Hash of resulting state
  outputLabelCommitment: Hash; // H("CT/CFCLabelMap" || canonical(labelMap))

  // Optional: computation evidence commitments
  cfcResultHash?: Hash; // H("CT/CFCResult" || canonicalResult)
  teeBindingHash?: Hash; // Commitment bound into TEE attestation

  // Metadata
  since: number;
  ts?: number; // Claimed wall-clock time (informational)
  meta?: Record<string, unknown>;
}
```

### 7.2 Address-Level Tracking

The receipt SHOULD include path-level read/write tracking:

```typescript
interface ReceiptActivity {
  reads: IMemoryAddress[]; // [{id, type, path}]
  writes: IMemoryAddress[]; // [{id, type, path}]
}

interface IMemoryAddress {
  id: URI; // Entity identifier (corresponds to `of`)
  type: MIME; // Media type (corresponds to `the`)
  path: readonly string[]; // JSON path within the value
}
```

This enables:
- Fine-grained dependency tracking for reactive scheduling
- Minimal invalidation on upstream changes
- Audit trail of exact data accessed

---

## 8. Append-Only Log

### 8.1 Mandatory Global Log

All facts MUST be included in a **single append-only log** maintained by the
server (Space).

The log provides:
- A total order over all facts
- Efficient inclusion proofs
- A global consistency anchor for time, authorization, and delegation state

### 8.2 Server Role

The server's role is **intentionally constrained**: it establishes order and
publishes checkpoints. It does not decide who is authorized or whether a fact is
correct; it merely records that a fact was observed at a particular position in
history.

This separation is fundamental: **servers order but do not authorize.**

### 8.3 Storage Schema

Current implementation uses SQLite:

```sql
-- JSON data (deduplicated by content hash)
CREATE TABLE datum (
  this    TEXT NOT NULL PRIMARY KEY,  -- Merkle reference
  source  JSON                        -- The actual JSON
);

-- Fact history (append-only)
CREATE TABLE fact (
  this    TEXT NOT NULL PRIMARY KEY,  -- Merkle reference for {the, of, is, cause}
  the     TEXT NOT NULL,              -- Media type
  of      TEXT NOT NULL,              -- Entity URI
  'is'    TEXT NOT NULL,              -- Reference to datum (or "undefined")
  cause   TEXT,                       -- Reference to prior fact (NULL for genesis)
  since   INTEGER NOT NULL            -- Lamport clock
);

-- Current state (mutable pointer to latest fact)
CREATE TABLE memory (
  the     TEXT NOT NULL,
  of      TEXT NOT NULL,
  fact    TEXT NOT NULL,              -- Reference to current fact
  PRIMARY KEY (the, of)
);
```

### 8.4 Why Ordering Matters

Receipts gain much of their power from ordering. Authorization changes over
time. Delegations are granted and revoked. Policies evolve. By anchoring each
receipt to a position in an immutable sequence, the CT Protocol allows verifiers
to answer time-sensitive questions precisely:

- _Was this signer authorized at the moment this change occurred?_
- _Which policy was in force when this computation ran?_

Without temporal grounding, trust collapses into a perpetual present, where past
actions are judged by current rules. With it, history becomes a stable reference
against which claims can be evaluated.

---

## 9. Authorization Emerges from State

### 9.1 The Problem with External Authorization

In most systems, authorization floats above the system as a separate concern—
configuration files, database tables hidden behind an API, or out-of-band
settings. This creates several problems:

- Authorization changes are not auditable events
- Verifying historical actions requires institutional memory
- Retroactive policy changes can rewrite the meaning of past actions

### 9.2 ACLs as Evolving State

In the CT Protocol, authorization does not float above the system. **It lives
_inside_ the same historical record as everything else.**

Access-control lists are state, expressed as facts like any other. Adding a
writer, removing a delegate, or transferring ownership produces a new fact that
commits to the updated ACL.

```typescript
type Capability = "READ" | "WRITE" | "OWNER";

type ACL = {
  [user in DID | "*"]?: Capability;
};
```

This design has two consequences:

1. **Delegation and revocation become auditable events.** One can trace when
   authority was granted, by whom, and when it was withdrawn.

2. **Authorization becomes inherently time-sensitive.** A fact that modifies
   state binds itself to the ACL that existed _at the moment it was appended to
   the log_.

### 9.3 Authorization at Commit Time

This notion—_authorization at commit time_—is central. When verifying a
historical action, the CT Protocol does not ask whether the signer is authorized
now. **It asks whether they were authorized then.**

The answer is determined mechanically by replaying facts in order. There is no
need to consult current configuration, no ambiguity about retroactive policy
changes, and no reliance on institutional memory.

### 9.4 Genesis Trust

- Each space is itself a `did:key`
- The **initial commit** for a space establishes the root of trust
- For full trust anchoring, the genesis commit SHOULD be signed by the space DID

### 9.5 Verification of Authorization

To verify a fact `F`:

1. Verify receipt signature
2. Verify log inclusion and ordering
3. Resolve the referenced ACL fact
4. Verify the ACL fact chain up to genesis
5. Check that signer DID is authorized under that ACL state
6. If UCANs are present, verify them and ensure consistency with ACL

Authorization is therefore **state-based**, not server-asserted.

---

## 10. Contextual Flow Control (CFC)

### 10.1 Beyond Access Control

Traditional access control answers the question "who may read or write this
resource?" but it is largely silent on what happens _after_ access is granted.
Once computation is treated as a first-class event, the question of _policy_
becomes unavoidable.

### 10.2 What is CFC?

**Contextual Flow Control (CFC)** is an opinionated application of Information
Flow Control (IFC), aligned with the idea of _contextual integrity_: data should
flow in ways that match the user's expectations for a given context.

CFC treats external inputs—including those produced by AI models—as **untrusted
by default**, requiring explicit policy to allow them to influence
higher-integrity state.

### 10.3 Labels

Inputs and outputs carry labels that describe confidentiality and integrity
constraints:

- **Confidentiality label**: Where information is allowed to flow
- **Integrity label**: What sources of information are considered trustworthy

The current implementation has a foundation:

```typescript
type Labels = {
  // Coarse/legacy label summary. Full IFC labels are schema-driven and may
  // vary by JSON path (via `ifc` annotations in schemas).
  classification?: string[];
};
```

### 10.4 Policy as Content-Addressed Artifact

Policies are themselves content-addressed and referenced by receipts. A
computation does not merely claim compliance with a policy; **it commits to a
specific, immutable policy definition.**

---

## 11. Policy Commitment vs Policy Enforcement

### 11.1 The Distinction

**Policy commitment** records that a computation declared its intent to operate
under a particular policy. This alone is valuable:

- Makes assumptions explicit
- Prevents silent policy drift
- Allows downstream systems to reason about compatibility

**Policy enforcement** concerns evidence. It asks whether the rules were
mechanically applied during execution.

### 11.2 Why the Distinction Matters

The CT Protocol does not force a single answer. A system can choose to accept
commitment alone, or it can require proof of enforcement, depending on context.

By separating declaration from demonstration, the CT Protocol avoids the false
dichotomy between blind trust and maximal proof.

### 11.3 Trusted Execution Environments (TEEs)

When enforcement evidence is required, TEEs can attest that specific code ran in
a measured environment. The attestation links:

- The identity of the code
- The receipt describing the computation
- The outcome of policy checks

TEEs are treated as _optional strengthening_, not as a foundation on which
everything else rests.

---

## 12. Trust Profiles

### 12.1 The Problem

Different audiences mean different things when they say they "trust" an
artifact. Trust profiles provide a vocabulary for precise communication.

### 12.2 Profile: Existence & Ordering

**Checks:** Receipt signature, log inclusion

**Guarantees:** The receipt exists and was ordered

**Non-guarantees:** Authorization, correctness, policy compliance

### 12.3 Profile: Authorized State Update

**Checks:** Signature, log inclusion, ACL verification

**Guarantees:** The signer was authorized at commit time

### 12.4 Profile: Provenance-Complete Output

**Checks:** Authorized + verification of all `inputRefs`

**Guarantees:** Output is transitively derived from referenced inputs

### 12.5 Profile: Policy-Committed Computation

**Checks:** Provenance + presence of CFC commitments

**Guarantees:** The computation committed to a specific CFC policy

### 12.6 Profile: Policy-Enforced Computation

**Checks:** Policy-Committed + TEE attestation verification

**Guarantees:** The computation mechanically enforced CFC rules

### 12.7 Profile Selection

Applications SHOULD explicitly state which trust profile they require.
Verifiers MUST NOT assume guarantees beyond the verified profile.

---

## 13. Trusted UI and Interaction Integrity

### 13.1 Why UI Is Part of the Trusted Computing Base

Many failures of trust occur at the boundary between system and human. Messages
are spoofed, prompts injected, consent manufactured.

The CT Protocol addresses this by extending verifiability to **interaction
itself**: if user actions materially affect system behavior, then those actions
belong in the provenance chain.

### 13.2 Trusted Input UI

A **Trusted Input UI** is a measured interface whose code identity is known.
When a user types, clicks, or submits, the event is captured as an input with
explicit integrity labels.

This reframes familiar acts as verifiable events. A receipt can support:

> "This message was typed by the user using the approved UI."

The goal is not surveillance, but provenance.

### 13.3 Trusted Render UI

A **Trusted Render UI** verifies receipts before displaying content:

- Refuses to render unverifiable content
- Displays verification badges derived from receipts
- Enforces CFC disclosure rules at render time

---

## 14. Verifiable Credentials

### 14.1 From Receipts to Claims

Receipts are precise but low-level. **Verifiable Credentials (VCs)** summarize
them into portable objects.

A VC does not replace receipts; it packages one or more receipts with inclusion
proofs, policy identifiers, and optional enforcement evidence.

### 14.2 The Critical Constraint

A CT Protocol–backed credential must not invent facts. Every assertion must be
reducible to receipts and verification steps that can be replayed.

### 14.3 Replayable Verification

A verifier need not trust the issuer's word. Given the credential, the verifier
can extract referenced receipts, check signatures, confirm log inclusion, and
verify policies.

---

## 15. Latest Entity Map (Optional)

### 15.1 Purpose

The **Latest Entity Map** enables efficient, verifiable answers to:

> "What is the latest state for entity E _as of checkpoint C_?"

### 15.2 Data Structure

- Implemented as a **Sparse Merkle Tree (SMT)** keyed by `H(of)`
- Each leaf commits to the latest known fact for that entity

### 15.3 Checkpoint

```typescript
interface UnsignedCheckpoint {
  epoch: number;
  headsRoot?: Hash; // OPTIONAL
  logRoot: Hash; // REQUIRED
  prev?: Reference<Checkpoint>;
  ts: number;
}
```

---

## 16. Domain and DID Bootstrap (DNS + did:web)

### 16.1 Three Identities

- **Space DID** (`did:key`): Root authority for ACL and authorization
- **Server DID** (`did:web`): Represents the server hosting the log
- **Domain** (DNS name): Human-meaningful handle for discovery only

### 16.2 Domain → Space Binding

```
_ct.example.com TXT "did=did:key:z6M...SPACE..."
```

Or:
```
https://example.com/.well-known/ct-space-did
```

### 16.3 Security Properties

- **No naming trust escalation:** Domain bindings do not grant write authority
- **Auditability:** Historical facts remain valid even if bindings change

---

## 17. Philosophy: Dissolving Unnecessary Authority

The CT Protocol is not neutral about power. It begins from the observation that
many failures of trust are also failures of balance.

### 17.1 The Shift

Instead of replacing one authority with another, the CT Protocol seeks to
**dissolve unnecessary authority** by making evidence portable and verification
repeatable.

When claims are grounded in receipts, policies, and logs that anyone can
inspect:

- A server can order events without deciding what they mean
- An application can render information without inventing facts
- An issuer can package claims without inflating their scope
- A user can carry evidence without depending on a platform's memory

### 17.2 What This Enables

Authority becomes specific, bounded, and accountable to structure. No component
is asked to be omniscient. No component is allowed to be unquestionable.

---

## Appendix A: Glossary

**ACL (Access Control List)** State object defining which DIDs may act in a
space.

**Append-Only Log** A global, monotonically growing structure that establishes
total ordering.

**CFC (Contextual Flow Control)** An opinionated application of IFC treating
external inputs as untrusted by default.

**Commit** A special fact type (`application/commit+json`) recording a complete
transaction for audit purposes.

**Entity** A named object whose state evolves over time, identified by a URI.

**Fact** An atomic state record: Assertion (has value), Retraction (tombstone),
or Unclaimed (genesis).

**Genesis** The initial state of an entity or space, before any assertions.

**Pattern** A composable, reactive program defining how state evolves.

**Receipt** A signed, content-addressed record with computation metadata.

**Space** A logical database namespace identified by a DID.

**Trust Profile** A named bundle of verification steps and guarantees.

---

## Appendix B: Threat–Invariant Matrix

| Threat                          | Invariant                              | Mechanism                          |
| ------------------------------- | -------------------------------------- | ---------------------------------- |
| Server forges authorization     | Authorization derives from space state | Receipt signatures + ACL binding   |
| Server reorders commits         | Log is append-only and checkpointed    | Log inclusion proofs + checkpoints |
| Signer writes without authority | Fact binds to ACL-at-commit-time       | `cause` chain + log ordering       |
| Replay of revoked authority     | Authorization evaluated at commit time | ACL evolution + log ordering       |
| Delegation forgery              | Only owners may modify delegation      | Signed delegation facts            |
| Domain hijack escalates         | Domains have no authorization power    | Space DID–rooted ACL               |
| Hidden data flow violation      | CFC label maps committed in receipts   | Label commitments + policy CID     |
| False policy compliance claim   | Enforcement evidence is explicit       | TEE attestation + `cfcResultHash`  |
| Tampering with history          | Content-addressed facts and log        | Hash chaining + signatures         |

---

## Appendix C: Mapping to Current Implementation

| CT Protocol Concept   | Current Implementation                           | Package |
| --------------------- | ------------------------------------------------ | ------- |
| Entity                | `URI` (`${string}:${string}`)                    | memory  |
| Fact                  | `Assertion \| Retraction`                        | memory  |
| Unclaimed             | `{the, of}` with no `is` or `cause`              | memory  |
| Commit                | Fact with `the: "application/commit+json"`       | memory  |
| CommitData            | `{since, transaction, labels?}`                  | memory  |
| Space                 | `MemorySpace` (`did:${string}:${string}`)        | memory  |
| Append-only log       | SQLite `fact` table                              | memory  |
| Current state         | SQLite `memory` table                            | memory  |
| ACL                   | `ACL` type with `Capability`                     | memory  |
| Signer                | `Signer` interface                               | memory  |
| Authorization         | UCAN-based `Authorization` type                  | memory  |
| Address tracking      | `IMemoryAddress` (`{id, type, path}`)            | runner  |
| Read/Write tracking   | `Activity` type in `ITransactionJournal`         | runner  |
| Transaction           | `IStorageTransaction` with `Journal`/`Chronicle` | runner  |
| Labels                | `Labels` type with `classification` (coarse)     | runner  |
| Genesis cause         | `refer({the, of})` - hash of unclaimed state     | memory  |
