# CT Protocol: Receipt Object (Section 7)

See `docs/specs/verifiable-execution/README.md` for navigation.

## 7. Receipt Object (Future Enhancement)

**Current implementation note:** Today, the system’s “receipt-like” artifact is
the `application/commit+json` fact produced by a transaction. This section
describes a richer receipt envelope intended for future enhancements (policy
commitments, provenance commitments, optional TEEs).

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

**Label maps:** In this document, a “label map” is a canonical, path-addressed
representation of IFC labels (often derived from schema annotations such as
`ifc`). Receipts commit to label maps so verifiers can check policy/label
reasoning without requiring disclosure of the labeled values.

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

Prev: `docs/specs/verifiable-execution/03-capabilities-api.md`  
Next: `docs/specs/verifiable-execution/05-log-and-authorization.md`
