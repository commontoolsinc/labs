# UCAN Invocations (Auth + Binding)

We use UCAN **invocations** to both authorize and bind to the exact commit
payload.

## Binding digests (per write)

- `baseHeadsRoot = BLAKE3(CBOR(sorted baseHeads))`
- `changesRoot   = BLAKE3( concat( BLAKE3(change_bytes_i) ) )`
- `changeCount   = number of changes in this write`

These go into UCAN `cap.nb` **and** the server's `TxBody`.

### UCAN `cap` example (JSON-ish)

```json
{
  "with": "doc:<mh>/branch/main",
  "can": "commit",
  "nb": {
    "baseHeadsRoot": "b3:<hex>", // or multihash
    "changesRoot": "b3:<hex>",
    "changeCount": 5
  }
}
```

### Server verification

- Verify the UCAN signature and delegation chain.
- Recompute roots from **request bytes** and assert equality with `nb`.
- Use the UCAN signer as `client_pubkey`. You **don't** need an extra client
  signature.

> If you later encode per-path read digests, include a `readsRoot` in `nb` and
> verify similarly.
