# CT Protocol: Verifiable State Update & Provenance

**Status:** Draft

**Audience:** Systems implementing verifiable, privacy-preserving state updates
with optional verifiable credentials and optional authenticated latest-pointer
maps.

---

## 1. Overview

This specification defines a verifiable, append-only system for **state updates
to named entities** with strong provenance, privacy-preserving computation
receipts, and policy-compliant computation.

Core features:

- **Mandatory append-only log** maintained by a single server
- **Multi-signer receipts** with state-based authorization (ACL + delegation)
- **Information Flow Control (IFC)** labels on data and computations, enabling
  end-to-end integrity and confidentiality guarantees

Optional add-ons:

- **Authenticated latest pointers** (verifiable entity → latest update mapping)
- **Verifiable Credentials (VCs)** issued on-demand for any data point
- **Trusted Execution Environment (TEE)** attestations for computation integrity
  and (when present) IFC compliance
- **Verifiable time bounds**, including cryptographic _lower bounds_ ("not before
  t")

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
- **Policy-compliant computation:** IFC labels travel with data, and
  computations can be verified to respect integrity and confidentiality
  constraints.
- **Modular add-ons:** Latest-pointer maps and VCs are optional and orthogonal.
- **Non-equivocation ready:** Equivocation can be detected and constrained via
  checkpoint chains.

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

A **Fact** represents state at a point in time. Facts are either:

- **Assertion**: Current state with value (`{the, of, is, cause}`)
- **Retraction**: Tombstone indicating prior state no longer holds
  (`{the, of, cause}`)

State MAY be represented as:

- Full materialized state (content-addressed via merkle-reference), or
- A patch applied to a prior state

Implementations MUST produce a deterministic hash for every update via the
`merkle-reference` library.

### 3.3 Receipt

A **Receipt** is the atomic, append-only record of a state update.

Receipts are signed objects and form per-entity chains via explicit
back-references (the `cause` field).

Each receipt also serves as a **computation envelope**:

- commits to code and inputs
- commits to output state
- commits to IFC label inputs/outputs and a policy identifier

---

## 4. Receipt Object

### 4.1 UnsignedReceipt

The receipt structure extends the current `Fact` model with computation
metadata:

```typescript
interface UnsignedReceipt {
  // Core fact identity (existing)
  the: MIME; // Media type (e.g., "application/json")
  of: URI; // Entity identifier
  cause: Reference<Fact>; // Previous fact for this entity

  // Computation identity (new)
  codeCID: Reference<CodeBundle>; // Content-addressed code bundle

  // Inputs (new)
  inputCommitments: Hash[]; // H(salt || canonical(input))
  inputRefs?: Reference<Fact>[]; // Optional provenance references
  inputLabelCommitments: Hash[]; // H("CT/IFCLabel" || canonicalLabel)

  // IFC policy (new)
  ifcPolicyCID: Reference<IFCPolicy>; // Policy identifier

  // Result
  is?: JSONValue; // Resulting state (patchCID for patches)
  stateHash: Hash; // Hash of resulting state
  outputLabelCommitment: Hash; // H("CT/IFCLabel" || canonicalLabel)

  // Optional: computation evidence commitments
  ifcResultHash?: Hash; // H("CT/IFCResult" || canonicalResult)
  teeBindingHash?: Hash; // Commitment bound into TEE attestation

  // Metadata
  since: number; // Lamport clock / sequence number
  ts?: number; // Claimed wall-clock time (informational)
  meta?: Record<string, unknown>;
}
```

### 4.2 Address-Level Tracking

The receipt SHOULD include path-level read/write tracking:

```typescript
interface ReceiptActivity {
  // Reads performed during computation
  reads: IMemoryAddress[]; // [{id, type, path}]

  // Writes performed during computation
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

### 4.3 Signature

```
sig = Sign(issuerKey, Hash(DeterministicSerialize(UnsignedReceipt)))
```

The signature is produced using the issuer's `Signer` interface:

```typescript
interface Signer<ID extends DID = DID> {
  sign<T>(payload: AsBytes<T>): AwaitResult<Signature<T>, Error>;
  verifier: Verifier<ID>;
}
```

### 4.4 Receipt Reference

The signed receipt is serialized deterministically and content-addressed using
`merkle-reference`:

```typescript
const receiptRef: Reference<Receipt> = refer(receipt);
```

---

## 5. Receipt Chains and Ordering

- Receipts for a given entity (`of` field) MUST form a linear chain via `cause`.
- `since` (sequence number) MUST increment monotonically per entity.
- Verification of order requires only the chain for that entity.

This provides **per-entity total order** without a global keyspace structure.

The current implementation uses:

```typescript
interface Assertion {
  the: MIME;
  of: URI;
  is: JSONValue;
  cause: Reference<Assertion | Retraction | Unclaimed>;
}
```

---

## 6. Append-Only Log

### 6.1 Mandatory Global Log

All receipts MUST be included in a **single append-only log** maintained by the
server (Space).

The log provides:

- A total order over all receipts
- Efficient inclusion proofs
- A global consistency anchor for time, authorization, and delegation state

The log MAY be implemented as a hash chain, Merkle Mountain Range (MMR), or
equivalent append-only accumulator.

Current implementation uses SQLite with the `fact` table:

```sql
CREATE TABLE fact (
  this    TEXT NOT NULL PRIMARY KEY,  -- Merkle reference (content-addressed ID)
  the     TEXT NOT NULL,              -- MIME type
  of      TEXT NOT NULL,              -- Entity URI
  'is'    TEXT NOT NULL,              -- Merkle reference to datum
  cause   TEXT,                       -- Reference to prior fact
  since   INTEGER NOT NULL,           -- Lamport clock timestamp
);
```

### 6.2 Log Inclusion

For every receipt `R`:

- The server MUST append `R` to the log
- The log root MUST advance monotonically
- Periodic checkpoints MAY commit to the current log root

Log inclusion is **orthogonal** to per-entity ordering, which is established by
receipt chains.

### 6.3 Commit Records

The current implementation creates commit records for audit:

```typescript
interface CommitData {
  since: number; // Starting sequence number
  transaction: Transaction; // Complete transaction args
  labels?: FactSelection; // Classification labels
}
```

---

## 7. Latest Entity Map (Optional)

### 7.1 Purpose

The **Latest Entity Map** enables efficient, verifiable answers to:

> "What is the latest state for entity E _as of checkpoint C_?"

### 7.2 Data Structure

- Implemented as a **Sparse Merkle Tree (SMT)** keyed by `H(of)`
- Each leaf commits to the latest known receipt for that entity

### 7.3 HeadsLeafValue

```typescript
interface HeadsLeafValue {
  since: number; // Sequence number
  head: Reference<Fact>; // Receipt reference
  stateHash: Hash;
  meta?: Record<string, unknown>;
}
```

### 7.4 Optional Inclusion

- The Latest Entity Map is OPTIONAL.
- Even when supported, inclusion in any given checkpoint is OPTIONAL.
- A checkpoint MAY omit `headsRoot` entirely.

Absence of a heads map does not affect receipt validity.

### 7.5 Checkpoint

```typescript
interface UnsignedCheckpoint {
  epoch: number;
  headsRoot?: Hash; // OPTIONAL
  logRoot: Hash; // REQUIRED
  prev?: Reference<Checkpoint>;
  ts: number;
}

// sig = Sign(checkpointKey, Hash(serialize(UnsignedCheckpoint)))
```

### 7.6 Verification (if included)

To verify latest pointer for entity `E` at epoch `C`:

1. Verify checkpoint signature and chain.
2. Verify SMT inclusion proof for `H(E)` against `headsRoot`.
3. Fetch `head` receipt and verify its signature and fields.

The claim is strictly:

> "This was the latest known update for E as of checkpoint C."

---

## 8. Computation Evidence

### 8.1 IFC as a Core Semantic

Information Flow Control (IFC) is a **core part of the framework**.

- Inputs, intermediate artifacts, and outputs MAY carry IFC labels.
- Receipts MUST commit to:
  - input label commitments (`inputLabelCommitments`)
  - output label commitment (`outputLabelCommitment`)
  - the policy identifier (`ifcPolicyCID`)

A verifier can always check that a receipt is _well-formed with respect to IFC_
(i.e., it commits to the relevant labels and policy).

The current implementation has a foundation for labels:

```typescript
type Labels = {
  classification?: string[];
};
```

### 8.2 Attested Enforcement (Optional)

The framework supports making IFC guarantees **strong** by verifying that the
computation actually enforced the policy.

When attested enforcement is used, the computation MUST run in a mechanism that
produces verifiable evidence (a TEE is RECOMMENDED).

### 8.3 Trusted Execution Environment (Optional)

TEEs provide evidence that a receipt was produced by a specific, measured
workload.

- Use an **Entity Attestation Token (EAT)** (JWT or CWT)
- The token MUST bind:
  - code measurement (e.g., enclave hash)
  - a binding derived from the receipt and IFC result

### 8.4 TEE Binding

The workload MUST compute:

```
teeBinding = H(receiptHash || ifcResultHash || context)
```

and place `teeBinding` (or its hash) into the TEE user-data field covered by
attestation.

### 8.5 IFC Result

If attested enforcement is used, the workload SHOULD emit a compact result:

```typescript
interface IFCResult {
  ok: boolean;
  reasonCode?: string;
  policyCID: Reference<IFCPolicy>;
  inputLabelCommitments: Hash[];
  outputLabelCommitment: Hash;
}
```

The receipt SHOULD include `ifcResultHash = H("CT/IFCResult" || canonicalResult)`.

This enables a verifier to treat the computation as not merely _authentic_, but
also _policy-compliant_.

---

## 9. Verifiable Time Bounds (Optional)

### 9.1 Lower Bound ("Not Before t")

To prove a receipt could not have existed before time `t`:

1. Select a **public beacon value** published after `t` (e.g., transparency log
   entry, randomness beacon).
2. Compute:

```
nb = BeaconValue
binding = H(receiptHash || nb)
```

3. Attest `binding` inside the TEE.

Verification of the beacon proves the receipt was created _after_ the beacon
existed.

### 9.2 Upper Bound (Optional)

An RFC 3161 timestamp MAY be applied to:

- `receiptHash`, or
- the VC hash (if a VC is issued)

This proves existence _at or before_ the TSA time.

---

## 10. Verifiable Credentials (Optional Add-On)

### 10.1 Overview

Verifiable Credentials are **not generated by default**.

A VC MAY be requested for **any receipt or derived data point**.

### 10.2 VC Payload

The VC encapsulates:

- References to receipt CID(s)
- Optional latest-pointer inclusion proof
- Optional TEE attestation
- Optional time-bound evidence

### 10.3 VC Semantics

A VC asserts:

> "According to issuer X, the referenced receipt(s) and evidence are valid and
> verified under this policy."

VC issuance does **not** alter the underlying receipt graph.

---

## 11. Verification Summary

A verifier MAY choose any subset of checks:

- Receipt signature and per-entity chain
- Mandatory log inclusion and ordering
- Provenance references
- IFC commitments (labels + policy identifier)
- Attested IFC enforcement (if present)
- Latest-pointer proof (if present)
- Lower and/or upper time bounds (if present)
- VC signature (if a VC is presented)

Security and cost scale with selected checks.

---

## 12. Privacy Properties

- Inputs are hidden behind salted commitments.
- State may be represented only by hashes.
- IFC labels MAY be committed by hash rather than revealed in the clear.
- Latest-pointer maps reveal only committed metadata.
- VCs disclose only what they explicitly include.

---

## 12A. Trusted UI and Interaction Integrity

CT protocol extends integrity guarantees beyond data and computation to **user
interaction**, treating UI-mediated actions as first-class, verifiable inputs.

### 12A.1 Trusted Input UI

A _Trusted Input UI_ is a measured, policy-bound interface that captures user
actions (typing, clicking, submission) and produces integrity-labeled
commitments.

Properties:

- UI code is identified by a `codeCID`
- User actions are captured as inputs with integrity labels (e.g. `user-input`,
  `approved-ui`)
- Programmatic injection or background automation is forbidden by policy

This enables claims such as:

> "This text was typed by the user using the approved UI."

### 12A.2 Trusted Render UI

A _Trusted Render UI_ verifies receipts before displaying content.

Properties:

- Refuses to render unverifiable or policy-violating content
- Displays verification badges derived from receipts and trust profiles
- Enforces IFC disclosure rules at render time

This allows trusted display even inside untrusted host applications.

### 12A.3 Interaction Integrity

By treating UI events as first-class inputs, CT protocol establishes integrity
over **what the user actually did**, not just what data exists or what
computation ran.

Examples:

- User typed a prompt
- User explicitly selected an option
- User submitted consent after viewing required text

---

## 13. Multi-Writer Authorization and Trust Model

### 13.1 Roles

- **Server:**

  - Maintains the append-only log
  - Publishes checkpoints
  - Does NOT determine authorization truth

- **Signers:**

  - Produce receipts
  - May change over time
  - Are authorized by on-chain (receipt-based) ACL state

- **Space:**
  - A logical database/namespace
  - Identified by a `did:key` (`MemorySpace` type)
  - Owns its ACL and delegation state

### 13.2 ACL State

Each space maintains an **ACL state object** stored and evolved via receipts in
this system.

Current implementation:

```typescript
type Capability = "READ" | "WRITE" | "OWNER";

type ACL = {
  [user in DID | "*"]?: Capability;
};
```

Rules:

- Only DIDs with `OWNER` capability MAY modify the ACL state
- Writers MAY submit receipts but MAY NOT change the ACL unless also owners

### 13.3 Genesis Trust

- Each space is itself a `did:key`
- The **initial ACL receipt** for a space MUST be signed by the space DID
- This establishes the root of trust for all future authorization

### 13.4 Delegation via Receipts

Delegations MAY be expressed as ACL updates written through this system.

A delegation receipt:

- Updates `writers` or `delegates`
- Is signed by a DID with `OWNER` capability in the prior ACL state

Because delegation state is part of the append-only log, it is:

- Ordered
- Timestamped
- Verifiable

A sufficiently recent, valid ACL receipt therefore acts as a **delegation
artifact**.

### 13.5 External Delegation (UCANs)

Signers MAY also present **UCANs** proving delegated authority.

Current implementation:

```typescript
type UCAN<Command extends Invocation> = {
  invocation: Command;
  authorization: Authorization<Command>;
};
```

Verification MAY combine:

- UCAN validity
- ACL state at the time of commit

Implementations MAY require that UCAN audience and caveats align with ACL rules.

### 13.6 Binding Authorization at Commit Time

Every receipt MUST bind to the **authorization context** in which it was
created.

The following MUST be included (directly or via commitments) as part of the
receipt inputs:

- The hash or reference of the latest ACL receipt known to the signer
- The signer DID (`iss` field in current implementation)
- Optional UCAN(s)

This binds the receipt to:

> "Signer S was authorized to write to space X under ACL state A at log position
> L."

### 13.7 Verification of Authorization

To verify a receipt `R`:

1. Verify receipt signature
2. Verify log inclusion and ordering
3. Resolve the referenced ACL receipt
4. Verify the ACL receipt chain up to genesis
5. Check that signer DID is authorized under that ACL state
6. If UCANs are present, verify them and ensure consistency with ACL

Authorization is therefore **state-based**, not server-asserted.

---

## 14. Extensibility

Future extensions MAY add:

- Zero-knowledge execution proofs
- Verkle-based latest maps
- Multi-writer conflict resolution
- Capability-based selective disclosure

---

## 15. Non-Goals

- Real-time global consensus
- Mandatory data availability
- Mandatory public indexing

---

## 16. Conclusion

This specification provides a modular foundation for verifiable state updates
with strong provenance, privacy, policy-compliant computation, and optional
credentials—without imposing the operational cost of maintaining a global
mutable keyspace.

---

## 17. Domain and DID Bootstrap (DNS + did:web)

### 17.1 Motivation

CT protocol supports bootstrapping human-meaningful identity and discoverability
by binding **domains** to **spaces** and **servers**, without weakening the
state-based authorization model.

This enables:

- human-friendly naming (e.g. domains)
- decentralized verification (no registry authority)
- alignment with existing Web PKI, DNS, and DID tooling

---

### 17.2 Roles and Identities

This section distinguishes three identities:

- **Space DID** (`did:key`)

  - Root authority for ACL, delegation, and authorization
  - Signs the genesis ACL receipt

- **Server DID** (`did:web`)

  - Represents the server hosting the append-only log, checkpoints, and APIs
  - Publishes signing keys for checkpoints and optional VC issuance

- **Domain** (DNS name)
  - Human-meaningful handle
  - Asserts which Space DID it represents

Domain identity is _naming and discovery only_; authorization always derives
from space state.

---

### 17.3 Domain → Space Binding

A domain MAY assert that it represents a specific Space DID using one or both of
the following mechanisms.

#### 17.3.1 DNS TXT Record

The domain MAY publish a TXT record at a well-known label:

```
_ct.example.com TXT "did=did:key:z6M...SPACE..."
```

This record asserts:

> "The controller of example.com claims association with Space DID X."

#### 17.3.2 HTTPS Well-Known Endpoint

Alternatively or additionally, the domain MAY serve:

```
https://example.com/.well-known/ct-space-did
```

With response body:

```
did:key:z6M...SPACE...
```

Both mechanisms MAY be supported simultaneously. Verifiers SHOULD accept either.

---

### 17.4 Server Identity via did:web

A CT protocol server MUST expose a **did:web DID document** at:

```
https://example.com/.well-known/did.json
```

Corresponding to:

```
did:web:example.com
```

This DID document is the authoritative source for server signing keys and
service endpoints.

---

### 17.5 Required did:web Document Contents

The server DID document MUST include:

#### Verification Methods

Keys used for:

- signing checkpoints and log roots
- optionally issuing Verifiable Credentials

These keys MUST be listed under `verificationMethod` and referenced from
`assertionMethod`.

#### Services

The DID document MUST include a service entry describing CT protocol endpoints:

```typescript
interface CTService {
  api: string; // "https://example.com/ct"
  checkpoints: string; // "https://example.com/ct/checkpoints"
  log: string; // "https://example.com/ct/log"
  receipts: string; // "https://example.com/ct/receipts/{cid}"
}
```

The document SHOULD also include an explicit binding to the space it serves:

```typescript
interface CTSpaceBinding {
  spaceDid: MemorySpace; // "did:key:z6M...SPACE..."
  methods: string[]; // ["dns:_ct", "https:/.well-known/ct-space-did"]
}
```

---

### 17.6 Verification Algorithm (Domain Bootstrap)

Given a domain `example.com`, a verifier MAY establish trust as follows:

1. Resolve domain → Space DID using DNS and/or HTTPS well-known endpoint
2. Resolve `did:web:example.com` to obtain the server DID document
3. Extract checkpoint verification keys and CT protocol service endpoints
4. Verify checkpoints and log roots using server keys
5. Verify receipt inclusion using log proofs
6. Verify authorization using space ACL and delegation state

At no point does the domain or server assert authorization directly.

---

### 17.7 Security Properties

- **Non-equivocation:** Server signatures are verifiable via did:web
- **No naming trust escalation:** Domain bindings do not grant write authority
- **Auditability:** Historical receipts remain valid even if domain bindings
  change
- **Key rotation:** Server keys MAY be rotated by updating the did:web document

---

### 17.8 Relationship to Verifiable Credentials

When issuing VCs, the issuer MAY be:

- the Space DID (for state-rooted claims)
- the Server DID (for publication or availability claims)

VC verification MUST follow the trust semantics of the issuing DID.

Domain bindings MAY be included as auxiliary evidence but MUST NOT be treated as
authorization.

---

## Appendix A: Glossary

**ACL (Access Control List)** State object defining which DIDs may act in a
space, including owners, writers, and delegates.

**Append-Only Log** A global, monotonically growing structure maintained by the
server that establishes total ordering and supports inclusion proofs for
receipts.

**Authorization (State-Based)** The determination of whether a signer was
permitted to act, derived solely from space ACL and delegation state at a
specific log position.

**Beacon** A publicly observable value that did not exist before a certain time,
used to establish verifiable lower bounds on creation time.

**Checkpoint** A signed statement committing to a log root (and optionally a
latest-entity map root) at a specific epoch.

**Computation Receipt** A signed, content-addressed record committing to inputs,
outputs, IFC labels, and policy context for a state update.

**Domain Binding** An assertion by a DNS domain that it represents or is
associated with a specific Space DID, used for naming and discovery only.

**Entity** A named object whose state evolves over time, identified by a URI.

**Fact** An atomic state record in the append-only log, either an Assertion (has
value) or Retraction (tombstone).

**IFC (Information Flow Control)** A policy framework constraining how
information may flow through computations, expressed via confidentiality and
integrity labels.

**IFC Enforcement Evidence** Verifiable proof (typically TEE-backed) that a
computation enforced IFC rules during execution.

**Label Commitment** A domain-separated hash committing to the canonical
representation of an IFC label.

**Space** A logical database namespace identified by a Space DID and governed by
ACL state (`MemorySpace` type: `did:${string}:${string}`).

**Space DID** A `did:key` serving as the root authority for a space's ACL and
delegation state.

**Server DID** A `did:web` identifier representing the server that publishes the
append-only log and checkpoints.

**TEE (Trusted Execution Environment)** A hardware-backed execution environment
capable of producing attestations about code identity and execution context.

**Verifiable Credential (VC)** A cryptographically signed statement asserting
claims about receipts, provenance, policy compliance, or availability.

---

## Appendix B: Threat–Invariant Matrix

This table summarizes major threat classes and the invariants that prevent or
detect them.

| Threat                          | Invariant                                     | Mechanism                          |
| ------------------------------- | --------------------------------------------- | ---------------------------------- |
| Server forges authorization     | Authorization derives from space state        | Receipt signatures + ACL binding   |
| Server reorders commits         | Log is append-only and checkpointed           | Log inclusion proofs + checkpoints |
| Signer writes without authority | Receipt binds to ACL-at-commit-time           | `aclStateHash` + log ordering      |
| Replay of revoked authority     | Authorization evaluated at commit time        | ACL evolution + log ordering       |
| Delegation forgery              | Only owners may modify delegation state       | Signed delegation receipts         |
| Domain hijack escalates         | Domains have no authorization power           | Space DID–rooted ACL               |
| Hidden data flow violation      | IFC labels committed in receipts              | Label commitments + policy CID     |
| False policy compliance         | Enforcement evidence is optional and explicit | TEE attestation + `ifcResultHash`  |
| Tampering with history          | Content-addressed receipts and log            | Hash chaining + signatures         |
| Key compromise (server)         | Keys are scoped and rotatable                 | did:web key rotation               |
| Key compromise (signer)         | Authority scoped by ACL                       | Revocation via ACL update          |
| Time backdating                 | Lower-bound beacon binding                    | Attested beacon commitment         |

---

## Appendix C: Trust Profiles and Verification Semantics

This appendix defines **normative trust profiles** describing what it means to
"trust" an output produced under CT protocol.

Each profile corresponds to a specific set of verification steps and guarantees.

---

### C.1 Profile: Existence & Ordering

**Verifier checks:**

- Receipt signature
- Inclusion in append-only log

**Guarantees:**

- The receipt exists
- The receipt was observed by the server at a specific position in the global
  order

**Non-guarantees:**

- Authorization
- Correctness of computation
- Policy compliance

---

### C.2 Profile: Authorized State Update

**Verifier checks:**

- Receipt signature
- Log inclusion
- ACL binding and verification

**Guarantees:**

- The signer was authorized under space ACL at commit time
- The state update is valid within the space's governance rules

**Non-guarantees:**

- Correctness of computation
- Policy compliance beyond committed labels

---

### C.3 Profile: Provenance-Complete Output

**Verifier checks:**

- Authorized State Update profile
- Verification of all `inputRefs`

**Guarantees:**

- The output is transitively derived from the referenced inputs
- The full provenance chain is intact and ordered

**Non-guarantees:**

- Policy enforcement during computation

---

### C.4 Profile: Policy-Committed Computation

**Verifier checks:**

- Provenance-Complete Output profile
- Presence of IFC commitments (labels + policy identifier)

**Guarantees:**

- The computation committed to a specific IFC policy
- Inputs and outputs are labeled under that policy

**Non-guarantees:**

- That the policy was actually enforced

---

### C.5 Profile: Policy-Enforced Computation

**Verifier checks:**

- Policy-Committed Computation profile
- Verification of IFC enforcement evidence (e.g., TEE attestation)

**Guarantees:**

- The computation enforced IFC rules during execution
- Confidentiality and integrity constraints were mechanically checked

**Non-guarantees:**

- Absolute correctness of the code logic beyond the enforced policy

---

### C.6 Profile: Strong Integrity Output

**Verifier checks:**

- Policy-Enforced Computation profile
- Integrity label validation across the entire provenance chain

**Guarantees:**

- Every dependency in the provenance chain satisfies required integrity
  constraints
- Output integrity is anchored to trusted sources

**Non-guarantees:**

- Completeness of data sources beyond declared provenance

---

### C.7 Profile: Portable Verifiable Claim (VC)

**Verifier checks:**

- Any of the above profiles
- VC signature and issuer semantics

**Guarantees:**

- The verified properties are portable and third-party verifiable
- The issuer's trust domain is explicit

**Non-guarantees:**

- That the issuer is globally trusted; trust is policy-defined

---

### C.8 Profile Selection

Applications SHOULD explicitly state which trust profile they require.

Verifiers MUST NOT assume guarantees beyond those provided by the verified
profile.

---

## Appendix D: Mapping to Current Implementation

This appendix maps CT protocol concepts to the current codebase structures.

| CT Protocol Concept | Current Implementation                          | Package         |
| ------------------- | ----------------------------------------------- | --------------- |
| Entity              | `URI` (`${string}:${string}`)                   | memory          |
| Fact                | `Assertion \| Retraction`                       | memory          |
| Receipt             | `Fact` + `Commit`                               | memory          |
| Space               | `MemorySpace` (`did:${string}:${string}`)       | memory          |
| Append-only log     | SQLite `fact` table                             | memory          |
| ACL                 | `ACL` type with `Capability`                    | memory          |
| Signer              | `Signer` interface                              | memory          |
| Authorization       | UCAN-based `Authorization` type                 | memory          |
| Address tracking    | `IMemoryAddress` (`{id, type, path}`)           | runner          |
| Read/Write tracking | `Activity` type in `ITransactionJournal`        | runner          |
| Transaction         | `IStorageTransaction` with `Journal`/`Chronicle`| runner          |
| Labels              | `Labels` type with `classification`             | runner          |
