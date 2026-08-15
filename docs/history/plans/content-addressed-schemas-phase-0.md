---
status: historical
created: 2026-08-14
archived: 2026-08-15
reason: "Executed plan; content-addressed schemas Phase 0 (readers-first resolution infrastructure) shipped, registry-lifetime decision included."
---

# Content-Addressed Schemas — Phase 0: Resolution Infrastructure

Executes Phase 0 of
[the content-addressed schemas spec](../../specs/content-addressed-schemas.md):
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

- [x] `decomposeSchema(schema)`: sanitized interned schema in, the set of
      schema documents out — `$defs` reference graph, strongly-connected-
      component condensation, singleton and cyclic-group document forms,
      external-ref rewriting, root document — per the spec's Decomposition
      section. Pure, deterministic, memoized on the interned input. Lives at
      `packages/runner/src/schema-decompose.ts`: the walks must be complete
      over the subschema-keyword vocabulary, whose single source of truth is
      `packages/runner/src/schema-walk.ts`, and `data-model` cannot depend
      on the runner.
- [x] `recomposeSchema(rootRef, lookup)`: inline expansion of a document
      closure back into one self-contained schema. This is the reference
      implementation the resolver is tested against, and the recomposition
      half of the round-trip property test.
- [x] Property tests: decompose ∘ recompose ∘ decompose reaches a fixpoint
      (singleton documents are name-free, so recomposition assigns derived
      names and byte-exact round-tripping is not the contract — the fixpoint
      on document sets is); decomposition is invariant under key order and
      under a singleton definition's name; SCC grouping pinned on fixtures
      with a self-cycle, a mutual cycle, and a diamond.

Nothing imports these functions outside tests yet. Landing them first pins
the canonical document forms every later stage must accept.

### Stage 2 — session schema registry and ref resolution

- [x] The registry (`packages/runner/src/schema-registry.ts`): a strong
      `Map` from tagged hash to interned schema, module-level rather than
      hanging off `StorageManager` — resolution happens in pure schema code
      (`resolveCfcSchemaRef`) with no storage handle, and content
      addressing makes realm-wide sharing safe: registration verifies every
      document against its claimed hash, on every call, so a mismatched
      document throws and never enters the registry (the
      `loadSchemaDocument` precedent in `packages/runner/src/cfc/prepare.ts`).
- [x] `resolveCfcSchemaRef` (`packages/runner/src/cfc/schema-refs.ts`) and
      through it the `resolveSchema` entry (`packages/runner/src/schema.ts`)
      extend from `#/$defs/<name>`-only to `cid:` refs with an optional
      `#/$defs/<name>` fragment, resolving through the registry. An
      external target owns its definition scope (the embedded-schema
      precedent); a fragment ref resolves to the member with the group's
      `$defs` attached when the member carries local refs, so the existing
      scope-switching handles the rest. An unresolvable ref keeps the
      fail-closed contract: `resolveSchema` returns `false`.
- [x] Cache discipline: a `cid:` resolution **hit** may be memoized (the
      documents are immutable), but a **miss must not be** — a document can
      arrive after the first failed lookup, and a memoized `false` would
      pin the failure. External refs bypass the per-root cache in
      `resolveCfcSchemaRef` entirely, and the failure-sentinel caches
      (`resolvedRefsCache` in `schema-refs.ts`, `_resolvedRefCache` in
      `packages/runner/src/traverse.ts`) skip memoizing a failure whenever
      `containsExternalSchemaRef` sees an external ref in the input. Tested
      by resolve-fails, documents-arrive, same-frozen-schema-resolves.

### Stage 3 — traversal and the memory walkers

- [x] Link and selector schema positions holding external references load
      the referenced documents into the traversal:
      `loadExternalSchemaDocs` in `packages/runner/src/traverse.ts`
      (hooked in `followPointer` for link schemas and at the schema
      traverser's entry for selector schemas) reads each document — a
      dependency-recording read, so an absent document's arrival
      re-triggers the reader — adds it to the schema tracker (which is
      what carries it into query results and watch sets), and registers it
      after hash verification. A forged document is tracked but neither
      registered nor recursed into.
- [x] A schema document's own external refs are followed by the same
      loader after registration — the one place `cid:` documents recurse.
      The DAG property plus the per-traversal loaded set bounds the walk;
      the meta-doc no-recurse rule in `loadMetaLinkedDocs` is untouched.
- [x] The walkers needed no structural change — a reference-only schema is
      an object in an ordinary schema position, which all three already
      pass through — but transport compression now skips reference-only
      positions (`isSchemaDocumentRefOnly` in
      `packages/memory/v2/sync-schema-table.ts`): a reference is already
      smaller than a table ref. Pinned in
      `packages/memory/test/v2-sync-schema-table.test.ts`.
- [x] The engine's reserved-prefix gate boundary is pinned by test:
      `schema-ref@2:` and `schema-cas@1:` strings in a schema position stay
      storage-illegal, an object-valued `cid:` reference is storage-legal.

### Stage 4 — sync registration and cold-miss recovery

- [x] Documents arriving by sync register on arrival:
      `#registerArrivedSchemaDocuments` in
      `packages/runner/src/storage/v2.ts` runs as each frame is applied
      (before notifications, so re-triggered readers find what the frame
      delivered), hash-verifies, and chases the unregistered documents
      behind each registration's external refs. The chase is handed to the
      manager's cross-space ledger (`trackPendingWork`), whose resolve loop
      re-checks after every settle, so one `synced()` covers a whole chain.
      Combined with Stage 3's server traversal, a client that syncs a
      document holding reference links receives and registers the schema
      closure in the same round trip — pinned end-to-end by
      `test/schema-doc-sync.test.ts` over two managers sharing one
      loopback server.
- [x] Cold-miss recovery is event-driven twice over: the traversal loader
      reports an absent document through the missing-link-target channel
      (`Runtime.ensureLinkedDocLoaded` kicks the fetch; the tracked read
      re-runs the reader on arrival), and
      `StorageManager.syncSchemaDocumentClosure(space, taggedHash)` is the
      direct helper that pulls a reference's whole closure and fails
      loudly on a hole. No polling anywhere.

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
read correctly through the shared traversal module (which both the client
and the memory server execute), and every stage's checkbox above is
checked. Protocol-level selector references — a client SENDING
`{ "$ref": "cid:…" }` in a watch spec, and the server resolving it from
storage at the protocol boundary — are the spec's Phase 2, not part of
this exit. Phase 0 unblocks Phase 1 (flag-gated writers) in the spec.

All four stages are checked, and the registry-lifetime open item below is
settled. Phase 0 is complete.

## Open items

- Where the registry hangs — resolved with Stage 2: module-level in the
  runner, because `resolveCfcSchemaRef` has no storage handle and verified
  content-addressed entries are safe to share realm-wide. Stage 4's sync
  registration writes into the same module-level registry.
- Registry lifetime and disposal — settled (2026-08-15, Robin): retention
  is session-scoped through leases. Every `StorageManager` acquires a
  registry lease for its open lifetime (re-acquired on reuse after
  `close()`); when the last lease in the realm releases, the registry and
  its closure memo clear. Clients therefore get true session lifetime and
  tests get a clean registry between cases, while a lease-less realm — the
  memory server registers through traversal without a manager — retains
  for the process lifetime, documented as a deliberate caveat: its entries
  are a cache over its own store, so a size cap there is safe if it ever
  measures as needed. This decision closes Phase 0.
- Whether a fragment ref may point into a singleton document
  (`cid:<hash>#/$defs/<name>` where the document is not a cyclic group) is
  disallowed until something needs it: singleton documents are referenced
  bare, and the decomposition never emits such a fragment.
