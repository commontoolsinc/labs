# Ops

- **Pragmas**: WAL, `synchronous=NORMAL`, `mmap_size=256MB`, etc.
- **Throughput**: single-writer pattern; batch changes per tx when possible.
- **Observability**:
  - Log tx durations, error codes (ReadConflict, StaleBaseHeads,
    MissingDependency, InvariantFailed).
  - Metrics on WS subscriber backlog / acks.
- **Backups**: per-space DB files; WAL-friendly hot backups.
- **Key mgmt**:
  - Server Ed25519 key (rotation via `server_keys` table if desired).
  - Attestation bundle digest stored in `tx.attestation_digest` when available.
- **Transparency log (optional)**:
  - Publish `tx_hash` (or batched Merkle roots) and store returned sequence in
    `xlog_seq`.
