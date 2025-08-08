# UCAN Invocation Binding

Each transaction request is bound to a UCAN capability that specifies **exactly what the client is allowed to commit**.

## Example Capability

**Example capability (`cap`):**

```json
{
  "with": "doc:<mh>/branch/main",
  "can": "commit",
  "nb": {
    "baseHeadsRoot": "mr:<...>",   // merkle-reference over sorted base heads
    "changesRoot": "mr:<...>",     // merkle-reference over per-change refs
    "changeCount": 5               // number of changes in this commit
  }
}
```

## Server Validation Pipeline

**Server validation pipeline:**

1. **Recompute digests** from the request:

   * `baseHeadsRoot` from sorted `baseHeads`.
   * `changesRoot` from each change blob in the write set (`am_change_blobs`).
   * `changeCount` from number of changes submitted.
2. **Compare** computed values to those in UCAN `nb` — must match exactly.
3. **Verify UCAN**:

   * Signature and delegation chain.
   * `aud` matches the space DID or service DID.
   * Not expired and within validity window.
4. **Extract `client_pubkey`** from UCAN for audit logging into `tx` row.
5. If all UCAN checks pass, proceed to **invariant validation** (see §10).
