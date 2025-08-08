# Overview

## Spaces

- A **space** is a totally separate database keyed by its **space DID**:
  `did:key:...`.
- One SQLite DB **per space** (recommended) for isolation and easier backups.
- The **space DID** is the default **owner**; future delegation is stored in a
  canonical doc.

## Document URIs

- **Automerge docs**: `doc:<BLAKE3-multihash>[/optional_path]`
  - Normal CRDT documents with branches/changes/snapshots.
  - Canonical **delegation doc** for a space is:

    ```json
    { "delegation": "<space DID>" }
    ```

    Its `doc:` ID is `doc:${blake3_multihash(json)}`. The **first tx** in a new
    space should write this doc (client-provided).
- **Immutable blobs**: `cid:<BLAKE3-multihash>`
  - Content-addressed, immutable bytes (no branches, no changes).

## Hashing & Crypto

- **Hash**: Prefer **BLAKE3** everywhere. Only use SHA-256 if an external
  standard forces it.
- **Encodings**:
  - Internal columns store raw 32 bytes (BLOB).
  - URIs use **multihash** (base58btc).
- **Tx chain**:
  - `tx_body_hash = BLAKE3(CBOR(TxBody))`
  - `tx_hash = BLAKE3( prev_tx_hash || tx_body_hash )`
  - Server signs **`tx_hash`** with **Ed25519** → `server_sig`.
- **UCAN invocations**:
  - Client sends a UCAN JWT with a **capability invocation**.
  - UCAN `nb` holds **digests** of the proposed commit (see `07-ucan.md`).
  - Server verifies UCAN and enforces equality between digests and submitted
    bytes.

## Concurrency & Storage

- **Optimistic**: read assertions on **heads** per (doc,branch).
- **CAS changes**:
  - `am_change_blobs(bytes_hash, bytes)` is the **only** copy of raw change
    bytes.
  - `am_change_index` provides per-(doc,branch) **ordering** and links to blobs.
- **Acceleration**:
  - `am_snapshots` store periodic `save()` results.
  - `am_chunks` store `saveIncremental()` deltas per `seq_no` (or batched).
