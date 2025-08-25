# Storage Specification

This directory contains the complete specification for the Automerge backend
with spaces, merkle-references for addressing, and a cryptographic transaction
chain.

## Document Structure

- **[01-overview.md](01-overview.md)** - High-level architecture and spaces
  concept
- **[02-schema.md](02-schema.md)** - Core data model and SQLite schema
- **[03-api.md](03-api.md)** - API surface (WebSocket protocol only)
- **[04-tx-processing.md](04-tx-processing.md)** - Transaction semantics and
  validation
- **[05-point-in-time.md](05-point-in-time.md)** - Point-in-time retrieval
  algorithms
- **[06-branching.md](06-branching.md)** - Branching and merging operations
- **[07-snapshots.md](07-snapshots.md)** - Snapshots and chunking policy
- **[08-subscriptions.md](08-subscriptions.md)** - Query-based subscriptions
  overview
- **[09-query-ir.md](09-query-ir.md)** - Query IR (Intermediate Representation)
- **[10-query-evaluation.md](10-query-evaluation.md)** - Query evaluation
  algorithm
- **[11-query-schema.md](11-query-schema.md)** - Query schema extensions
- **[12-query-types.md](12-query-types.md)** - Query system TypeScript types
- **[13-ucan.md](13-ucan.md)** - UCAN invocation binding
- **[14-invariants.md](14-invariants.md)** - Invariants and plugin API
- **[15-errors.md](15-errors.md)** - Error taxonomy
- **[16-operations.md](16-operations.md)** - Operational guidance
- **[17-client-types.md](17-client-types.md)** - Client transaction types
- **[18-migration.md](18-migration.md)** - Migration and bootstrap
- **[19-testing.md](19-testing.md)** - Testing checklist

## Key Concepts

- **Spaces**: Independent, isolated storage domains identified by DIDs
- **Content-addressed storage**: Changes stored once in CAS tables
- **Cryptographic transaction chain**: merkle-reference based digests and
  Ed25519-signed transaction envelopes
- **Point-in-time retrieval**: Access any branch state at any historical point
- **UCAN-based authorization**: Fine-grained capabilities with cryptographic
  verification
- **Invariant system**: Pluggable business rule validation
- **Query-based subscriptions**: Incremental, link-aware, schema-driven queries
  over document graphs
- **Document structure**: All Automerge documents have a standardized structure
  with `value` field for content and optional `source` field for metadata
- **Source synchronization**: Automatic recursive syncing of source documents
  when documents with source links are included in query results

## Implementation Notes

- Runtime: Deno 2
- Web framework: Hono (HTTP + WS)
- Database: SQLite via `npm:better-sqlite3`
- Automerge: `npm:@automerge/automerge`
- Addressing: `npm:merkle-reference` (default for doc ids and digests). Use CIDs
  only where interop requires a specific multihash format.
- Concurrency: Single writer per space, many readers
- Storage: WAL mode with tuned pragmas

## Repository layout (implementation)

The `@commontools/storage` package uses a small number of top-level modules:

- `src/types.ts`: unified type definitions shared by provider, store, and query
- `src/provider.ts`: space-scoped storage API and orchestration
- `src/store/`: SQLite-backed store implementation (previously under `sqlite/`)
  - Re-exports of concrete modules such as `heads`, `pit`, `tx`, `snapshots`,
    `chunks`, `cas`
- `src/query/`: query IR, evaluator, and subscription plumbing; imports shared
  types from `src/types.ts`

The previous `src/sqlite/` folder has been aliased to `src/store/` via re-export
barrels to avoid breaking imports while transitioning. New code should import
from `src/store/*` and shared types from `src/types.ts`.
