# Storage Specification

This directory contains the complete specification for the Automerge backend
with spaces, CIDs, and cryptographic transaction chain.

## Document Structure

- **[01-overview.md](01-overview.md)** - High-level architecture and spaces
  concept
- **[02-schema.md](02-schema.md)** - Core data model and SQLite schema
- **[03-api.md](03-api.md)** - API surface and endpoints
- **[04-tx-processing.md](04-tx-processing.md)** - Transaction semantics and
  validation
- **[05-point-in-time.md](05-point-in-time.md)** - Point-in-time retrieval
  algorithms
- **[06-branching.md](06-branching.md)** - Branching and merging operations
- **[07-snapshots.md](07-snapshots.md)** - Snapshots and chunking policy
- **[08-subscriptions.md](08-subscriptions.md)** - WebSocket subscriptions and
  delivery
- **[09-ucan.md](09-ucan.md)** - UCAN invocation binding
- **[10-invariants.md](10-invariants.md)** - Invariants and plugin API
- **[11-errors.md](11-errors.md)** - Error taxonomy
- **[12-operations.md](12-operations.md)** - Operational guidance
- **[13-client-types.md](13-client-types.md)** - Client transaction types
- **[14-migration.md](14-migration.md)** - Migration and bootstrap
- **[15-testing.md](15-testing.md)** - Testing checklist

## Key Concepts

- **Spaces**: Independent, isolated storage domains identified by DIDs
- **Content-addressed storage**: Changes stored once in CAS tables
- **Cryptographic transaction chain**: BLAKE3-based, Ed25519-signed transaction
  history
- **Point-in-time retrieval**: Access any branch state at any historical point
- **UCAN-based authorization**: Fine-grained capabilities with cryptographic
  verification
- **Invariant system**: Pluggable business rule validation

## Implementation Notes

- Runtime: Deno 2
- Web framework: Hono (HTTP + WS)
- Database: SQLite via `npm:better-sqlite3`
- Automerge: `npm:@automerge/automerge`
- Concurrency: Single writer per space, many readers
- Storage: WAL mode with tuned pragmas
