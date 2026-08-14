# Content-Addressed Schema Documents

Schemas carried by links and queries become references to content-addressed
schema documents instead of inline copies. A schema is decomposed at `$defs`
granularity: each definition that stands alone becomes its own schema
document, and definitions that reference each other cyclically stay together
in one document, so the cross-document reference graph is acyclic and every
document's hash is well-founded.

## Status

Design, not yet implemented. The unmerged branch
`memory/connection-scoped-schema-cas` (`syncSchemaCasV1`) addresses the
transport half of the same problem — it scopes the sync schema table to the
connection instead of the frame. This design subsumes that branch's benefit
for link schemas (a reference at rest never needs transport compression) but
does not conflict with it; sequencing against that branch is an open
question below.

## Last Updated

2026-08-14

## Motivation

A link's `schema` field (`CellLinkRefPayload`,
`packages/runner/src/sigil-types.ts`) holds a complete, self-contained JSON
Schema — including its whole `$defs` closure — inlined verbatim into the
stored document. Nothing deduplicates it at rest. The same schema is
duplicated on three surfaces:

1. **At rest, per link.** Every schema-bearing link in a stored document
   carries a full copy. Prolific writers include every rendered VDOM prop
   link (`packages/html/src/worker/reconciler.ts`), pattern bindings, and
   result links. Narrowing multiplies the problem: `schemaAtPath` re-attaches
   the reachable `$defs` closure to every narrowed variant, so N views into
   one type store N overlapping closures.
2. **Client→server, per watch.** `refreshWatchSet`
   (`packages/runner/src/storage/v2.ts`) sends one watch spec per (doc,
   selector), each with the full inline selector schema. No compression
   exists in this direction, and reconnect re-sends the entire accumulated
   watch set — the payload grows monotonically with the session's document
   count.
3. **Server→client, per frame.** `syncSchemaTableV2` compresses link schemas
   into a hash-keyed table, but the table is frame-local: every schema body
   re-travels on every frame that references it. The
   `v2-sync-schema-table.test.ts` fixture shows schema repetition at over
   80% of frame bytes before compression.

Transport compression can only ever address surface 3 (and, with the
connection-scoped branch, repetition across frames). Surfaces 1 and 2 need
durable schema identity: a name that is valid in storage, in queries, and
across sessions. The system already has the pieces:

- **Schema hashing and interning** — `internSchemaAsTaggedHashString`
  (`packages/data-model/src/schema-hash.ts`) produces a key-order-independent
  `fid1:` tagged hash; the intern table already gives structurally equal
  schemas one identity per process.
- **Content-addressed schema documents** — CFC already persists schemas as
  `cid:<taggedHash>` documents (`ensureSchemaDocument`,
  `packages/runner/src/cfc/prepare.ts`) with idempotent blind writes,
  client-side hash verification on read, and traversal support: the server's
  graph traversal synthesizes a link from the `cfc.schemaHash` field and
  includes the schema document in query results and watch sets
  (`cfcMetaToSigilLink`, `packages/runner/src/traverse.ts`).
- **Cycle condensation** — module identity hashing already condenses
  strongly connected components so import cycles hash as a unit
  (`computeModuleHashes`, `packages/runner/src/harness/module-identity.ts`).
- **A reserved namespace** — `REQUEST_SCHEMA_CAS_REF_PREFIX`
  (`packages/memory/v2/schema-table-links.ts`) reserves `schema-cas@1:` for
  transport; the storage-side counterpart is this design.

## Design

### Schema documents

A schema document is a `cid:` document whose value is a JSON Schema:

- **Id**: `cid:<taggedHash>` where the hash is
  `internSchemaAsTaggedHashString(schema)` — the same id and content rules as
  CFC schema documents, which become a special case of this mechanism rather
  than a parallel one.
- **Content**: `{ "value": <the schema> }`, exactly the CFC schema-document
  shape.
- **Write**: idempotent blind write (no read-before-write, per the
  `ensureSchemaDocument` precedent — a read-before-write turns concurrent
  installation of the same content into a false conflict), performed in the
  same transaction as the write that references it.
- **Per space**: a schema document must exist in every space that contains a
  reference to it, written there by whichever writer first references it in
  that space. Content addressing makes concurrent installs collide
  harmlessly.

### Decomposition

Decomposition turns one self-contained schema into a set of schema documents
whose cross-references form a DAG:

1. Start from the sanitized, interned schema as it would be written today
   (after `sanitizeSchemaForLinks`; sanitization order is unchanged).
2. Build the reference graph over the schema's `$defs` entries: an edge from
   definition A to definition B when A's subtree contains a `$ref` to B.
3. Condense strongly connected components (the `computeModuleHashes`
   precedent). Each component becomes one schema document:
   - A **singleton** definition (no cycle through itself) becomes a document
     whose value is the definition's schema itself. References to it use the
     bare document id.
   - A **cyclic group** becomes a document whose value is
     `{ "$defs": { <the group's members> } }`. Within the document, members
     reference each other with ordinary local `#/$defs/<name>` refs.
     References from outside use a fragment: `cid:<hash>#/$defs/<name>`.
4. Rewrite: within each document, refs to definitions in other documents
   become external refs; the `$defs` entries they replaced are removed.
   Definition names are kept as authored (they come from TypeScript type
   names via the schema generator, which are stable across patterns that
   share types).
5. The **root** — the original schema minus its externalized `$defs` — is
   itself a schema document, and its id is what the link or selector
   carries.

Cyclic groups must stay together because a cycle split across documents
would make each document's content hash depend on the other's — content
addressing is only well-founded over an acyclic reference graph. This is the
same reason module identity condenses import cycles.

Because the external refs are part of a document's content, the reference
closure is a Merkle DAG: the root document's hash pins the exact content of
every document reachable from it.

An external ref is a `$ref` whose value is a `cid:` URI:

```jsonc
// A singleton definition document, referenced from a root schema:
{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": { "$ref": "cid:fid1:abc…" },
    },
  },
}
```

```jsonc
// A cyclic group document (two mutually recursive definitions):
{
  "$defs": {
    "Folder": {
      "type": "object",
      "properties": {
        "children": {
          "type": "array",
          "items": { "$ref": "#/$defs/Entry" },
        },
      },
    },
    "Entry": {
      "anyOf": [{ "type": "string" }, { "$ref": "#/$defs/Folder" }],
    },
  },
}
```

Decomposition is deterministic and memoized on the interned input schema, so
repeated link writes carrying the same schema cost one lookup after the
first.

### References in links

`CellLinkRefPayload.schema` remains typed `JSONSchema`; a reference is
simply a schema whose only member is an external `$ref`:

```jsonc
{
  "/": {
    "link@1": {
      "id": "of:fid1:…",
      "path": ["items", "0"],
      "space": "did:key:…",
      "schema": { "$ref": "cid:fid1:xyz…" },
    },
  },
}
```

This keeps the payload type, the three schema-position walkers
(`mapLinkSchemas`, `findSyncSchemaRef`, `containsSyncSchemaRefString` — which
must all learn the new form in one change; the walker-agreement test in
`packages/memory/test/v2-sync-schema-table.test.ts` pins that), and the
schema-combination path structurally unchanged: a reference dereferences to
exactly the schema that would have been inline.

The write path (`createSigilLinkFromParsedLink` with `includeSchema`)
sanitizes as today, then decomposes, ensures the closure's documents exist
in the target space (same transaction), and stamps the reference.

`$alias` bindings (`AliasBindingBase.schema`) are pattern-binding
vocabulary, not links; they adopt the same reference form on the same
schedule as the link flip, which retires the standing "`$alias` schemas
travel inline indefinitely" carve-out in
`packages/memory/v2/schema-table-links.ts`.

### References in selectors

`SchemaPathSelector.schema` accepts the same reference form. This is what
fixes the uncompressed client→server surface: a watch spec for a document
whose schema is already persisted carries `{ "$ref": "cid:…" }` instead of
the full schema, and reconnect re-sends references, not bodies.

The server resolves the reference against the space's own storage (an
engine read; no new protocol). A client may send a reference only for a
schema whose documents it knows are persisted in that space — one it wrote,
or one it received by sync. For anything else it sends the schema inline,
as today. A reference the server cannot resolve fails the query loudly
(protocol error), not silently as an empty match: an unresolvable selector
is a client bug, and matching nothing would mask it.

### Resolution

Reading a reference must produce the schema synchronously wherever schemas
are consumed today (traversal, narrowing, CFC label derivation). The
mechanism follows the module-loading precedent (session-lifetime strong
index, async storage-backed fallback):

- A **session schema registry**: a strong `Map` from tagged hash to interned
  schema, session lifetime. Populated from both directions: decomposition on
  the write path registers what it writes; sync registers every schema
  document that arrives. Memory is bounded by the number of distinct schema
  documents seen in the session — strictly less than the duplicated inline
  copies it replaces.
- `resolveSchemaRefs` (`packages/runner/src/cfc/schema-refs.ts`) extends
  from `#/$defs/<name>`-only to `cid:` refs (with optional `#/$defs/<name>`
  fragment), resolving through the registry. An unresolvable ref keeps the
  existing fail-closed contract: `resolveSchema` returns `false`, and
  traversal treats the value as unmatched.
- A cold miss (a reference read before its documents arrived) is recovered
  by an async storage-backed load of the reference closure, after which
  resolution retries. The sync paths never block: they fail closed and the
  load triggers re-evaluation, the same shape as any other not-yet-synced
  document dependency.

Verification happens at registration: a schema document's value is
re-hashed and must match its id (the `loadSchemaDocument` precedent);
a mismatched document is rejected and never enters the registry. Because
external refs are hash-covered content, verifying each document
individually verifies the whole closure against the root reference.

### Traversal and sync

The server's shared traversal already follows the `cfc.schemaHash` seam by
synthesizing a `cid:` link and adding the document to the query result and
watch set (`cfcMetaToSigilLink` / `loadMetaLinkedDocs`). This generalizes:

- A link or selector schema that is an external reference contributes a
  synthesized link to its root schema document.
- A schema document's own external refs contribute synthesized links to
  their targets — the one place `cid:` documents recurse. Today traversal
  deliberately does not recurse into `cid:` documents; schema documents
  relax that for schema-document targets only, and the DAG property plus
  per-(identity, schema) cycle detection bounds the walk.

A client that syncs a document therefore receives the schema documents for
every link it contains in the same round trip, keeping the "resolved means
locally available" property. Schema documents are immutable, so their
presence in watch sets is quiet; whether they deserve a fetch-once path
instead is an open question shared with all `cid:` documents.

On the wire, a reference-bearing link is already small; the sync schema
table (`schema-ref@2:`) skips reference-only schema positions. Schema
document bodies travel once, as ordinary document upserts, and benefit from
any document-level caching.

### What this does not change

- **Link identity**: `areNormalizedLinksSame` and `addressKey` exclude
  schema today and continue to.
- **Schema semantics**: combination (pseudo-intersection), narrowing,
  `additionalProperties` handling, and the CFC `ifc` vocabulary operate on
  the dereferenced schema and behave identically. `ifc` annotations are
  ordinary schema content, covered by the hash.
- **Sanitization**: `sanitizeSchemaForLinks` runs where it runs today;
  decomposition consumes its output. Distinct sanitization variants of one
  schema are distinct documents — their shared `$defs` closures still
  deduplicate, which is most of the byte win.
- **The memory engine's storage model**: schema documents are ordinary
  documents in the revision table, like every `cid:` document today.

## Migration

Experimental flag (`contentAddressedSchemas`, registered in
`docs/development/EXPERIMENTAL_OPTIONS.md` when implementation starts),
phased on the op-migration playbook:

- **Phase 0 — resolution infrastructure.** Session schema registry;
  `resolveSchemaRefs` learns `cid:` refs; verification at registration;
  traversal follows external refs out of schema documents. Readers can now
  handle references that nothing yet writes. The three memory walkers learn
  reference-only schema positions in the same change.
- **Phase 1 — write references on links (flag-gated).** Decomposition +
  same-transaction document installs; links carry references. Old inline
  links keep reading forever — links rewrite on every re-instantiation, so
  inline forms age out without a data migration. A canary pins the inline
  vintage.
- **Phase 2 — references in selectors.** Watch specs and one-shot queries
  send references for persisted schemas; server-side resolution; the
  loud-failure rule for unresolvable references.
- **Phase 3 — retire transport compression for link positions.**
  `syncSchemaTableV2` (and `syncSchemaCasV1`, if landed) stop matching
  anything on link positions once reference-bearing links dominate; the
  `$alias` carve-out retires with the alias flip. Transport compression for
  inline selector schemas from old clients remains until the protocol
  version floor passes Phase 2.

## Test plan

- Decomposition: property tests that recomposition (inline expansion of the
  closure) round-trips to the sanitized input; SCC grouping pinned on
  fixtures with self-cycles, mutual cycles, and diamonds; determinism across
  key order.
- Dedup: the `v2-sync-schema-table.test.ts` fixture (256 schema copies per
  frame) rewritten against references asserts bodies travel once per
  session, not once per frame.
- Fail closed: a forged schema document (content not matching id) never
  enters the registry; a query with an unresolvable selector reference
  errors loudly; a link with an unresolvable reference reads as unmatched.
- Round trip: a piece written with reference links, resumed in a fresh
  session, resolves schemas through sync alone; the same with a cold
  registry exercises the async recovery path.
- Walker agreement: the existing mechanical test extended to
  reference-only schema positions.

## Open questions

1. **Sequencing against `syncSchemaCasV1`.** The connection-scoped
   transport table helps immediately and needs no storage change; this
   design makes it unnecessary for link positions but not for inline
   selector schemas during migration. Land transport first and retire it
   later, or skip straight to references? Owner coordination needed
   (Bernhard's branch).
2. **Small-definition threshold.** A `{ "type": "string" }` definition as
   its own document costs more in envelope and round-trip bookkeeping than
   it saves. Start with unconditional decomposition (simplest, canonical),
   measure, and only then consider an inline-below-N-bytes rule — a
   threshold changes document identity, so it must be part of the
   decomposition's versioned contract, not a tuning knob.
3. **Server-side integrity enforcement.** Verification is client-side, as
   for CFC schema documents today (the S5 / A2 items in the CFC audit).
   Making the server the sole acceptor of `cid:` writes — rejecting content
   that does not hash to the id — would cover schema documents and CFC
   documents in one change.
4. **Fetch-once for immutable documents.** Every pull is a watch add, so
   schema documents permanently grow the session watch set even though they
   can never change. Quiet but not free; a fetch-without-subscribe
   primitive for `cid:` documents would benefit blobs and module sources
   equally.
5. **Garbage collection.** Nothing collects unreferenced documents today;
   schema documents accumulate like `pattern:` and CFC `cid:` documents do.
   Net bytes still fall (each document replaces many inline copies), so
   this stays in the existing GC-design bucket rather than blocking here.
6. **Definition naming.** Authored names are kept, so two structurally
   identical definitions with different names are different documents.
   Acceptable (names are stable per shared TypeScript type); canonical
   renaming would buy marginal dedup at real debuggability cost.
