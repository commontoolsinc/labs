# Invariants (Plugin API)

Invariants are **pluggable validators** that run **after** heads/dependency validation but **before** the transaction commits.
They can enforce **business rules, security constraints, and integrity checks** across all docs in a transaction.

## Interface

```ts
type Invariant = (ctx: {
  txIdPreview: number | null; // Assigned if commit proceeds
  reads: ReadSet[];
  writes: WriteSet[]; // includes decoded change metadata
  loadDocAt: (docId: string, branch: string, epoch?: number) => Promise<AutomergeDoc>;
  project: (doc: AutomergeDoc, paths: string[]) => any;
}) => Promise<void>;
```

* `loadDocAt` can retrieve a doc at:

  * Current heads.
  * A prior epoch.
* `project` returns a JSON projection of selected paths.

If any invariant throws an error, the transaction **fails closed** with:

```json
{ "code": "InvariantFailed", "name": "PolicyName", "message": "Details..." }
```

## Examples

* **Information Flow Control** — Ensure writes don't downgrade confidentiality labels.
* **Schema Validation** — Confirm updated doc conforms to server-side schema.
* **Temporal Constraints** — E.g., `timestamp` in doc can't move backward.
* **Cross-Doc Integrity** — Ensure derived data is based on equal-or-newer source data.

## Digest-Based Read Assertions (Optional)

For high-integrity claims about "what was read":

1. **Client** includes:

   * Heads observed for each `(doc, branch)` in `reads`.
   * Optional `path_digests` = `{ path: digest }` for selected subtrees.
2. **Server**:

   * Loads doc at those heads.
   * Projects each path, recomputes digest (e.g., BLAKE3 over CBOR encoding).
   * Compares with asserted digest.
3. Invariant passes only if all digests match.

## Execution & Fail-Closed Policy

* All invariants must pass for the transaction to commit.
* Failures abort the entire transaction atomically — no partial writes.
* Invariants run inside the same DB transaction to ensure **read consistency**.
