# Content-Addressed Schemas — Phase 0: Resolution Infrastructure

Executes Phase 0 of
[the content-addressed schemas spec](../specs/content-addressed-schemas.md):
readers learn to handle schema references that nothing yet writes. Everything
here is inert until Phase 1 turns on the writers, so no experimental flag is
needed; the flag (`contentAddressedSchemas`) arrives with Phase 1.

## Scope

In scope: the pure decomposition contract, the session schema registry,
`cid:` ref resolution, traversal that follows references, the memory
walkers, and sync-side registration with cold-miss recovery.

Out of scope (later phases): any writer emitting references — links,
`$alias` bindings, or selectors; the experimental flag; server-side selector
resolution; transport-compression retirement.

## Stages

### Stage 1 — decomposition as a pure library, unwired

- [ ] `decomposeSchema(schema)`: sanitized interned schema in, the set of
      schema documents out — `$defs` reference graph, strongly-connected-
      component condensation, singleton and cyclic-group document forms,
      external-ref rewriting, root document — per the spec's Decomposition
      section. Pure, deterministic, memoized on the interned input. Lives in
      `packages/data-model` beside `schema-hash.ts`, since it is defined
      entirely in terms of schema values and their hashes.
- [ ] `recomposeSchema(rootDocument, lookup)`: inline expansion of a
      document closure back into one self-contained schema. This is the
      reference implementation the resolver is tested against, and the
      recomposition half of the round-trip property test.
- [ ] Property tests: recompose ∘ decompose round-trips to the input;
      decomposition is invariant under key order; SCC grouping pinned on
      fixtures with a self-cycle, a mutual cycle, and a diamond.

Nothing imports these functions outside tests yet. Landing them first pins
the canonical document forms every later stage must accept.

### Stage 2 — session schema registry and ref resolution

- [ ] The registry: a strong `Map` from tagged hash to interned schema,
      session lifetime, hanging off the client `StorageManager` (the server
      resolves from its own storage and does not use the client registry).
      Registration verifies content against the claimed hash — a mismatched
      document is rejected and never enters the registry (the
      `loadSchemaDocument` precedent in `packages/runner/src/cfc/prepare.ts`).
- [ ] `resolveSchemaRefs` (`packages/runner/src/cfc/schema-refs.ts`) and the
      `resolveSchema` entry (`packages/runner/src/schema.ts`) extend from
      `#/$defs/<name>`-only to `cid:` refs with an optional `#/$defs/<name>`
      fragment, resolving through the registry. An unresolvable ref keeps
      the fail-closed contract: `resolveSchema` returns `false`.
- [ ] Cache discipline: a `cid:` resolution **hit** may be memoized (the
      documents are immutable), but a **miss must not be** — a document can
      arrive after the first failed lookup, and a memoized `false` would
      pin the failure. The existing failure-sentinel caches
      (`_resolvedRefCache` in `packages/runner/src/traverse.ts`,
      `resolvedRefCache` in `schema-refs.ts`) memoize unresolvable refs
      today; `cid:` misses either bypass those caches or registration
      invalidates them. This is the subtlest point in the phase — it gets
      its own tests (resolve-fails, document arrives, resolve-succeeds).

### Stage 3 — traversal and the memory walkers

- [ ] Link and selector schema positions holding an external reference
      contribute a synthesized link to the root schema document, extending
      the `cfcMetaToSigilLink` / `loadMetaLinkedDocs` seam in
      `packages/runner/src/traverse.ts`.
- [ ] A schema document's own external refs contribute synthesized links to
      their targets — relaxing the deliberate no-recurse rule for `cid:`
      documents, for schema-document targets only. The scan for external
      refs in a schema document is a plain walk of its value; the DAG
      property plus the existing per-(identity, schema) cycle detection
      bounds the traversal.
- [ ] The three schema-position walkers
      (`mapLinkSchemas`, `findSyncSchemaRef`, `containsSyncSchemaRefString`
      in `packages/memory/v2/schema-table-links.ts` and
      `sync-schema-table.ts`) learn reference-only schema positions in one
      change: transport compression skips them (they are already small),
      and the walker-agreement test in
      `packages/memory/test/v2-sync-schema-table.test.ts` extends to pin
      all three.
- [ ] Confirm the engine's reserved-prefix gate
      (`rejectStoredSyncSchemaRef`, `packages/memory/v2/engine.ts`) does
      not misfire on stored `cid:` refs: `schema-ref@2:` and
      `schema-cas@1:` stay storage-illegal, `cid:` refs inside a stored
      link schema are storage-legal. A test states this boundary
      explicitly.

### Stage 4 — sync registration and cold-miss recovery

- [ ] Documents arriving by sync that are `cid:`-addressed and parse as
      schema documents register into the session registry on arrival
      (`packages/runner/src/storage/v2.ts`, where synced documents are
      already inspected — the `syncCfcSchemaDocument` neighborhood).
      Combined with Stage 3, a client that syncs a document holding
      reference links receives and registers the schema closure in the same
      round trip.
- [ ] A closure-load helper for the cold miss: given a root reference,
      sync `cid:<hash>` and every document reachable from it, then retry
      resolution. Recovery is event-driven — resolution failure triggers
      the load and the arrival re-runs the read, the same shape as any
      not-yet-synced dependency; no polling
      (`docs/development/waiting-in-tests.md` governs the tests here).

## Test plan

Beyond the per-stage tests above:

- End-to-end read: hand-authored (Stage 1-produced) schema documents
  persisted in a space, a document containing a reference link, a fresh
  client session — the link's schema resolves through sync alone, and the
  same run with a cold registry exercises the recovery path.
- Fail closed end-to-end: a forged schema document (content not hashing to
  its id) never enters the registry, and the referencing link reads as
  unmatched rather than wrongly matched.
- All existing suites stay green with nothing writing references — Phase 0
  must be invisible to current behavior.

## Delivery

One PR per stage, in order; each lands green and inert. Stage 2 and Stage 3
touch shared traversal code imported by the memory server — run both
`packages/runner` and `packages/memory` suites for those.

## Exit criteria

Phase 0 is done when a reference-bearing link and a reference-bearing
selector, constructed by tests against hand-persisted schema documents,
read correctly on both the client and the server traversal paths, and every
stage's checkbox above is checked. That unblocks Phase 1 (flag-gated
writers) in the spec.

## Open items

- Where the registry hangs is proposed as `StorageManager` (one per client
  session, visible to the storage layer that registers arrivals); if
  resolution turns out to be needed somewhere without a `StorageManager`
  handle, revisit before Stage 2 lands.
- Whether a fragment ref may point into a singleton document
  (`cid:<hash>#/$defs/<name>` where the document is not a cyclic group) is
  disallowed until something needs it: singleton documents are referenced
  bare, and the decomposition never emits such a fragment.
