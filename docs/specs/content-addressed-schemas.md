# Content-Addressed Schema Documents

Schemas carried by links and queries become references to content-addressed
schema documents instead of inline copies. A schema is decomposed at `$defs`
granularity: each definition that stands alone becomes its own schema
document, and definitions that reference each other cyclically stay together
in one document, so the cross-document reference graph is acyclic and every
document's hash is well-founded.

## Status

Design; the readers-first resolution infrastructure (Phase 0 of
[the implementation plan](../history/plans/content-addressed-schemas-phase-0.md))
is landing, and nothing writes references yet. The connection-scoped
transport experiment (`syncSchemaCasV1`, unmerged) is not being pursued;
this design is the storage-side successor for link positions, and a
reference at rest never needs transport compression.

## Last Updated

2026-08-15

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

Transport compression can only ever address surface 3. Surfaces 1 and 2
need
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
   become external refs; the `$defs` entries they replaced are removed. A
   singleton document carries no definition name — the definition's schema
   is the document — so structurally identical standalone definitions
   deduplicate regardless of what their schemas called them. Cyclic-group
   members keep their authored names (they come from TypeScript type names
   via the schema generator, which are stable across patterns that share
   types), because the internal `#/$defs/<name>` refs need them.
5. The **root** — the original schema minus its externalized `$defs` — is
   itself a schema document, and a reference to it is what the link or
   selector carries. A root or a definition that reduces to a single
   external reference and nothing else gets no document of its own: the
   reference binds straight to the target, so a chain of pure-ref aliases
   decomposes to the same closure as a direct reference, and decomposition
   stays canonical under recomposition.
6. External refs the input already carries — the normal case once narrowed
   schemas round-trip through storage — are resolved against the documents
   at hand (hash-verified) and included, transitively, in the returned
   closure, so "every document in the closure" holds for the writer that
   persists it.

Cyclic groups must stay together because a cycle split across documents
would make each document's content hash depend on the other's — content
addressing is only well-founded over an acyclic reference graph. This is the
same reason module identity condenses import cycles.

Because the external refs are part of a document's content, the reference
closure is a Merkle DAG: the root document's hash pins the exact content of
every document reachable from it.

Decomposition refuses input it cannot represent faithfully — a `$ref`
outside the `#/$defs/<name>` and external vocabularies, a dangling local
ref, a nested `$defs` scope, the deprecated `definitions` keyword, the
resource-scope keywords (`$id`, `$anchor`, `$dynamicAnchor`,
`$dynamicRef`, and the 2019-09 pair `$recursiveAnchor` and
`$recursiveRef`, whose scoping the rewrite cannot preserve), and an
external
ref whose document is not at hand — and a writer falls back to carrying
such a schema inline, as today.

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

The server side of this needs no new machinery: selector schemas flow
through the shared traversal, whose loader collects referenced documents
from the requesting space's own storage and whose entry gate keeps an
uncollectable schema from selecting anything (see Space boundaries). What remains
for clients is the sending half: a client may send a reference only for a
schema whose documents it knows are persisted in that space — one it
wrote, or one it received by sync — and sends the schema inline otherwise,
as today. A reference the server cannot resolve fails the query loudly
(protocol error), not silently as an empty match: an unresolvable selector
is a client bug, and matching nothing would mask it.

### Resolution

Reading a reference must produce the schema synchronously wherever schemas
are consumed today (traversal, narrowing, CFC label derivation). The
mechanism follows the module-loading precedent (session-lifetime strong
index, async storage-backed fallback):

- A **session schema registry**: a strong `Map` from tagged hash to interned
  schema. Populated from both directions: decomposition on the write path
  registers what it writes; sync registers every schema document that
  arrives. Retention is session-scoped through leases — every
  `StorageManager` holds one for its open lifetime, and the last lease's
  release clears the registry — so memory is bounded by the distinct schema
  documents the live sessions have seen, strictly less than the duplicated
  inline copies they replace; concurrent sessions share retention for the
  union of their lifetimes. A realm that never holds a lease (the memory
  server registers through traversal without one) retains for the process
  lifetime; its entries are a cache over its own store, so a size cap there
  is safe if ever needed — an evicted document is one local read away.
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

Resolution demands the whole closure: a registered document whose
transitive closure is not fully registered resolves as a miss, exactly
like an unregistered document. Resolving it partially would let derived
results — an IFC scan, a path narrowing — be memoized over the hole,
keyed by the root's stable identity, and the missing child's later
arrival would never invalidate them. Completeness is monotonic, so the
gate opens by itself once the closure lands; caches that memoize derived
results by schema identity populate only for schemas whose external
closure is complete.

### Space boundaries

A schema document's value is space-free: content addressing makes the
bytes identical wherever they are stored, so the realm-wide registry
shares one verified object across spaces, and using a shared value can
never produce a wrong answer. Which space a document EXISTS in matters in
exactly two guarantees, both about delivery rather than about values:

- **The write-side guarantee.** The client that replaces an inline schema
  with a reference created the obligation, so it discharges it: the
  decomposed closure is written into the space that will hold the
  reference, in the same transaction as the reference itself. A
  transaction commits against one space's session, so the closure reaches
  whichever server handles that space by construction, and
  `decomposeSchema` refuses to emit a reference whose closure the writer
  does not hold — the guarantee is the only path through the API.
- **The read-side guarantee.** A query result is self-sufficient: every
  schema reference embedded in delivered documents resolves within the
  delivered set. The traversal loader collects each referenced closure
  from the traversed space (reads at the canonical `"space"` scope,
  tracked into the query result and watch set), and a schema whose closure
  the space does not hold selects nothing — the gate sits at the two
  places a schema enters a traversal, the selector and a link, and
  availability is closure-transitive, so interior resolution needs no
  per-lookup scoping. Selecting by an uncollectable schema would produce a
  result whose shape the receiving client could never reproduce from what
  arrives.

The recovery path repairs per-space presence when the guarantees meet a
hole: the loader's reads are tracked (arrival re-runs the reader), the
missing-target kick requests the fetch, and the arrival-time dependency
chase and `syncSchemaDocumentClosure` complete a closure within their own
space — never satisfied by realm-registry presence alone.

Outside a traversal — direct runtime resolution of an already-read
schema — realm-wide value sharing means resolution can succeed for a
reference whose document the encountering space does not hold, when
another session in the realm fetched the same content elsewhere. That is
value sharing working as intended; the delivery guarantees above are what
keep any such reference backed by a real per-space document, and the
write gate under the server-enforcement open question would make the
write-side guarantee server-checked as well.

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
- **Phase 2 — clients send references in selectors.** Watch specs and
  one-shot queries carry references for persisted schemas. The server side
  already ships with Phase 0 — selector schemas resolve through the shared
  traversal, per space, under the availability scope — so this phase is
  the client emission plus the loud protocol error for an unresolvable
  selector reference.
- **Phase 3 — retire transport compression for link positions.**
  `syncSchemaTableV2` stops matching
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

1. **Small-definition threshold.** A `{ "type": "string" }` definition as
   its own document costs more in envelope and round-trip bookkeeping than
   it saves. Start with unconditional decomposition (simplest, canonical),
   measure, and only then consider an inline-below-N-bytes rule — a
   threshold changes document identity, so it must be part of the
   decomposition's versioned contract, not a tuning knob.
2. **Server-side integrity enforcement.** Verification is client-side, as
   for CFC schema documents today (the S5 / A2 items in the CFC audit).
   Making the server the sole acceptor of `cid:` writes — rejecting content
   that does not hash to the id — would cover schema documents and CFC
   documents in one change. Accepted as non-urgent: a forged document is
   confined to the space it was written into — every path into the shared
   registry re-computes the hash before trusting a claim, so refs in that
   space fail closed and no other space is affected.
3. **Fetch-once for immutable documents.** Every pull is a watch add, so
   schema documents permanently grow the session watch set even though they
   can never change. Quiet but not free; a fetch-without-subscribe
   primitive for `cid:` documents would benefit blobs and module sources
   equally.
4. **Garbage collection.** Nothing collects unreferenced documents today;
   schema documents accumulate like `pattern:` and CFC `cid:` documents do.
   Net bytes still fall (each document replaces many inline copies), so
   this stays in the existing GC-design bucket rather than blocking here.
5. **Definition naming.** Singleton documents are name-free and so
   deduplicate name-independently; only cyclic-group members keep their
   authored names, so two structurally identical cyclic groups with
   different member names are different documents. Acceptable (names are
   stable per shared TypeScript type); canonical renaming inside groups
   would buy marginal dedup at real debuggability cost.
