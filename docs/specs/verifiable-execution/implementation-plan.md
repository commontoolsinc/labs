# CT Protocol Implementation Plan

This document tracks implementation status of the CT Protocol specification.

## Status Legend

- [x] Done
- [ ] Not started
- [~] Partial / in progress

---

## Phase 1: Core Infrastructure (Mostly Complete)

### 1.1 Append-Only Log

- [x] SQLite-based fact storage (`packages/memory/space.ts`)
- [x] Content-addressed facts via `merkle-reference`
- [x] Causal chains via `cause` field linking facts
- [x] Lamport clock sequencing (`since` field)
- [x] Fact table with `{this, the, of, is, cause, since}` schema
- [ ] Merkle inclusion proofs for log entries
- [ ] Log root computation (MMR or equivalent)
- [ ] Checkpoint generation with signed log roots

### 1.2 Identity & Authorization

- [x] DID-based principals (`Principal`, `Signer`, `Verifier` interfaces)
- [x] Space identification via `did:key` (`MemorySpace` type)
- [x] ACL with capability levels (`READ`, `WRITE`, `OWNER`)
- [x] UCAN-based authorization structure
- [x] Signature verification via `Verifier` interface
- [x] Access checking in `packages/memory/access.ts`
- [ ] ACL state stored as receipts in the log
- [ ] Authorization binding in commit records

### 1.3 Transaction System

- [x] Storage transactions (`IStorageTransaction`)
- [x] Read/write tracking via `Journal` and `Chronicle`
- [x] Activity recording (`Activity` type with read/write variants)
- [x] Path-level addressing (`IMemoryAddress` with `{id, type, path}`)
- [x] Consistency checking via attestations
- [x] Commit records with transaction data

---

## Phase 2: Enhanced Receipts (Priority: High)

This is the next major milestone. The goal is to enhance commit/receipt
structure to capture computation metadata for verifiability and reactive
scheduling.

### 2.1 Address-Level Activity in Receipts

Currently, the `Journal` tracks activities with `IMemoryAddress` including
paths, but this is not persisted in the commit structure.

**Required changes:**

- [ ] Extend `CommitData` to include address-level reads/writes:

```typescript
interface CommitData {
  since: number;
  transaction: Transaction;
  labels?: FactSelection;
  // NEW: Activity tracking
  activity?: {
    reads: SerializedAddress[]; // [{id, type, path}]
    writes: SerializedAddress[];
  };
}
```

- [ ] Serialize `IMemoryAddress` in commit creation (`packages/memory/commit.ts`)
- [ ] Capture journal activity when creating commits
- [ ] Add activity to `ITransactionJournal.activity()` serialization

**Files to modify:**

- `packages/memory/interface.ts` - extend `CommitData` type
- `packages/memory/commit.ts` - serialize activity in `create()`
- `packages/runner/src/storage/interface.ts` - activity export
- `packages/runner/src/storage/transaction/journal.ts` - activity serialization

### 2.2 Code Bundle References

Track which code produced each computation.

**Required changes:**

- [ ] Define `CodeBundle` reference type
- [ ] Add `codeCID` field to receipt structure
- [ ] Capture pattern/handler identifier during execution
- [ ] Pass code reference through transaction pipeline

```typescript
interface ComputationContext {
  codeCID: Reference<CodeBundle>; // Hash of code that ran
  handlerId?: string; // Handler name within bundle
  version?: string; // Code version
}
```

**Files to modify:**

- `packages/memory/interface.ts` - add computation context types
- `packages/runner/src/storage/transaction.ts` - capture code context
- `packages/runner/src/runtime/` - pass code identity to transactions

### 2.3 Input Provenance References

Link outputs to their input sources for provenance chains.

**Required changes:**

- [ ] Capture `inputRefs` as references to source facts
- [ ] Distinguish between:
  - Direct reads (facts read during computation)
  - Derived inputs (computed from other sources)
- [ ] Add input references to commit structure

```typescript
interface ProvenanceData {
  inputRefs: Reference<Fact>[]; // Source facts
  inputCommitments?: Hash[]; // H(salt || input) for privacy
}
```

**Files to modify:**

- `packages/memory/interface.ts` - provenance types
- `packages/runner/src/storage/transaction/chronicle.ts` - track input sources

### 2.4 Receipt Serialization

Create a unified receipt format that combines current structures.

**Required changes:**

- [ ] Define `Receipt` type combining Fact + computation metadata
- [ ] Implement receipt creation from transaction + journal
- [ ] Add receipt verification functions

```typescript
interface Receipt {
  // Core fact
  fact: Fact;

  // Computation metadata
  computation?: {
    codeCID: Reference<CodeBundle>;
    activity: { reads: Address[]; writes: Address[] };
    inputRefs: Reference<Fact>[];
  };

  // Signature
  signature: Signature<Receipt>;
  issuer: DID;
}
```

**Files to modify:**

- `packages/memory/receipt.ts` - full receipt implementation (currently minimal)
- `packages/memory/interface.ts` - Receipt type definition

### 2.5 Client State & Commit Validation

Implement the nursery/heap model for client-side state and relaxed commit
validation.

**Required changes:**

- [ ] Define `ClientCommit` structure with confirmed/pending read separation:

```typescript
interface ClientCommit {
  reads: {
    confirmed: Array<{ address: Address; hash: Hash; since: number }>;
    pending: Array<{ address: Address; hash: Hash; fromCommit: Reference<Commit> }>;
  };
  writes: Array<{ address: Address; value: JSONValue; cause: Hash }>;
  codeCID?: Reference<CodeBundle>;
  activity?: ReceiptActivity;
}
```

- [ ] Define `CommitLogEntry` structure preserving original + resolution:

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

- [ ] Implement `since`-based validation (not hash-chain validation):
  - Reads must record `since` of what was read
  - Validation: `new_commit.reads[entity].since >= prior_commit.writes[entity].since`

- [ ] Track hash mappings when provisional hashes differ from final

- [ ] Implement server-side commit processing:
  - Validate confirmed reads against current `since`
  - Resolve pending reads via `fromCommit` → assigned `since`
  - Assign next `since` to commit
  - Compute final hashes and record mappings
  - Store both original and resolution

**Files to modify:**

- `packages/memory/interface.ts` - `ClientCommit`, `CommitLogEntry` types
- `packages/memory/commit.ts` - commit processing with validation
- `packages/memory/space.ts` - commit log storage with original + resolution
- `packages/runner/src/storage/transaction.ts` - client-side commit building

---

## Phase 3: Reactive Scheduling Integration

The activity tracking from Phase 2 enables intelligent reactive scheduling.

### 3.1 Dependency Graph

- [ ] Build dependency graph from receipt activity
- [ ] Track which addresses each computation reads/writes
- [ ] Compute transitive dependencies

### 3.2 Minimal Invalidation

- [ ] On fact change, identify affected computations via read addresses
- [ ] Use path-level granularity for precise invalidation
- [ ] Only re-run computations whose inputs changed

### 3.3 Scheduler Hooks

- [ ] Integrate with pull-based scheduler (see `docs/specs/pull-based-scheduler/`)
- [ ] Provide activity data to scheduler for dependency tracking
- [ ] Support partial re-execution based on changed paths

---

## Phase 4: IFC Labels (Future)

### 4.1 Label Infrastructure

- [~] Basic label type exists (`Labels` with `classification`)
- [ ] Full IFC label model (confidentiality + integrity)
- [ ] Label commitment hashing
- [ ] Policy CID references

### 4.2 Label Propagation

- [ ] Track labels through computations
- [ ] Verify label constraints at commit time
- [ ] Label-based access control

### 4.3 Attested Enforcement

- [ ] TEE integration for policy enforcement
- [ ] IFC result generation
- [ ] Attestation binding

---

## Phase 5: Merkle Proofs & Checkpoints (Future)

### 5.1 Log Proofs

- [ ] Merkle tree or MMR for log structure
- [ ] Inclusion proof generation
- [ ] Proof verification API

### 5.2 Checkpoints

- [ ] Checkpoint generation (periodic or on-demand)
- [ ] Signed checkpoint structure
- [ ] Checkpoint chain verification

### 5.3 Latest Entity Map

- [ ] Sparse Merkle Tree for heads
- [ ] Heads inclusion proofs
- [ ] Efficient latest-state queries

---

## Phase 6: Verifiable Credentials (Future)

- [ ] VC issuance from receipts
- [ ] Trust profile verification
- [ ] VC serialization (JWT/CBOR)

---

## Phase 7: Domain Bootstrap (Future)

- [ ] DNS TXT record support (`_ct.domain.com`)
- [ ] Well-known endpoint (`/.well-known/ct-space-did`)
- [ ] did:web document generation
- [ ] Domain verification algorithm

---

## Phase 8: Time Bounds (Future)

- [ ] Beacon integration for lower bounds
- [ ] RFC 3161 timestamp support for upper bounds
- [ ] Time-bound verification

---

## Implementation Priority

### Immediate (Phase 2)

1. **Activity in receipts** - Highest priority
   - Extend `CommitData` with activity
   - Serialize journal activity to commits
   - This unlocks reactive scheduling benefits

2. **Client state & commit validation**
   - Nursery/heap model for pending vs confirmed commits
   - `since`-based validation rules
   - CommitLogEntry with original + resolution
   - Hash mapping for provisional → final resolution
   - This enables offline operation and stacked commits

3. **Code bundle references**
   - Track which code produced each output
   - Essential for reproducibility and auditing

4. **Input provenance**
   - Link outputs to input sources
   - Enables provenance chain verification

### Near-term (Phase 3)

4. **Scheduler integration**
   - Use activity data for dependency tracking
   - Minimal invalidation on changes

### Medium-term (Phases 4-5)

5. **IFC labels** - Build on existing `Labels` type
6. **Merkle proofs** - Enable verification without full log

### Long-term (Phases 6-8)

7. **VCs, Domain bootstrap, Time bounds** - Optional add-ons

---

## Key Files Reference

| Area | Primary Files |
|------|---------------|
| Fact/Receipt types | `packages/memory/interface.ts` |
| Commit creation | `packages/memory/commit.ts` |
| Fact operations | `packages/memory/fact.ts` |
| Merkle hashing | `packages/memory/reference.ts` |
| Transaction interface | `packages/runner/src/storage/interface.ts` |
| Transaction impl | `packages/runner/src/storage/transaction.ts` |
| Journal | `packages/runner/src/storage/transaction/journal.ts` |
| Chronicle | `packages/runner/src/storage/transaction/chronicle.ts` |
| Address operations | `packages/runner/src/storage/transaction/address.ts` |
| Attestation | `packages/runner/src/storage/transaction/attestation.ts` |
| ACL | `packages/memory/acl.ts`, `packages/memory/access.ts` |
| Space/SQLite | `packages/memory/space.ts` |
