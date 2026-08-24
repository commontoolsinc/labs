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
has landed, and Phases 1 and 2 ship together behind the
`contentAddressedSchemas` flag (on by default): links and `$alias`
bindings stamp references with commits materializing each closure into
the destination space, and a selector normalizes for the wire — the
reference form only when its whole closure is confirmed persisted in
the target space, the fully inline form (recomposed through the realm
registry when the schema itself carries references) otherwise, and a
loud server error for a selector reference nothing backs. The
connection-scoped
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
- **Content-addressed schema documents** — CFC persists schemas as
  `cid:<taggedHash>` documents (`ensureSchemaDocument`,
  `packages/runner/src/cfc/prepare.ts`) through the shared
  schema-document staging (registration, per-transaction dedupe,
  confirmed-persistence elision), with client-side hash verification on
  read and traversal support: the server's
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
- **Space scope only, by rule**: the commit boundary rejects a `cid:`
  write at any other scope. A scoped partition could hold a divergent
  copy under one content-addressed id, and the paths that read the
  store — delivery, traversal, and commit validation — resolve `cid:`
  documents at space scope. (Direct-registry reuse across spaces is
  hash-verified, so a divergent copy could never enter it.)

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

An embedded schema ref — a URL in the runtime's static embedded-schema
table, such as the renderer's
`https://commonfabric.org/schemas/vnode.json` — is an allowed leaf inside
a document. Every realm resolves it from the same table, so it hashes as
ordinary document content and contributes nothing to the closure. The
embedded table is transitional: the expectation is that its residents
retire in favor of ordinary `cid:` documents, at which point the table
goes with them, while documents already carrying the URLs keep resolving
until then.

Decomposition refuses input it cannot represent faithfully — a `$ref`
outside the `#/$defs/<name>`, external, and embedded vocabularies, a
dangling local ref, a nested `$defs` scope, the deprecated `definitions`
keyword, the resource-scope keywords (`$id`, `$anchor`, `$dynamicAnchor`,
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

The server validates root selector references BEFORE traversal begins:
every referenced document, transitively through its closure, must be
stored in the requesting space with content that verifies against its
id, and the validation reads through the query's manager, so a
historical query (`atSeq`) requires the closure to exist and verify at
that same sequence. A reference that fails this validation fails the
query loudly (a QueryError), never silently as an empty match — the
lenient selects-nothing gate is for LINK schemas inside delivered
documents, where a hole is a wait-for-arrival state; an unresolvable
selector reference is a client bug, and matching nothing would mask
it. Past validation, resolution flows through the shared traversal
with the documents already registered. What remains for clients is
the sending half: a client may send a reference only for a schema
whose documents it knows are persisted in that space — one it wrote,
or one it received by sync — and sends the schema inline otherwise,
as today.

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

The same identity check is the class test. `cid:` holds more document
classes than schema documents — blobs among them — and a delivery site
cannot name the class of a directly pulled document, so a document is a
schema document exactly when its id is the schema interning of its
value. Anything that passes is byte-for-byte usable as the schema
document that id names; anything else is another class, not a rejection
to warn about.

Content-addressed documents are immutable at the commit boundary: the
server rejects a `delete` or `patch` of any `cid:` document, whatever
its class, and rejects a `set` that is neither the first installation
nor content-identical to the stored document (canonical value equality,
which compares special objects by content hash) — conflicting sets of one id
within a single commit included — because a deleted or altered
dependency would invalidate every document referencing it. An
idempotent re-`set` of the same content is how writers install closures
and stays legal — and it applies as a semantic no-op: the immutability
comparison proves the content unchanged, so the engine writes no
revision, advances no head, and marks nothing dirty, while the commit
row and space sequence still advance (a blind closure re-install costs
watchers nothing). A sync frame's removes are watch-result removals,
not deletions.

The commit boundary also validates the closure a commit's content
references: every schema ref introduced by a set's document, a patch's
own values, an installed schema document's own refs, or the
`cfc.schemaHash` a document's stored CFC envelope names (in a
non-`cid:` set's value, or in the post-patch document of any patch
sequence whose pointers can reach the reserved `cfc` member — a `cid:`
document's own `cfc` member is deliberately not a metadata position and
is never collected) must be backed —
in the same commit or already stored in the space — by a document whose
content verifies against its id, transitively through the closure. A
commit that references what it does not supply, or supplies content
that does not hash to its id, is rejected. The commit API therefore
cannot create a missing or forged closure for any reference this
collection sees; readers treat a broken closure that exists anyway as
the patch shape below, out-of-band tampering, or a store that predates
this validation, and fail loudly on it. The
writer's obligation to install the closure atomically with the referrer
remains normative — the boundary is its enforcement, not a substitute
for it.

One patch shape escapes the collection: an edit INSIDE an existing
link's schema (replacing a `$ref` string at a sub-path) introduces a
reference no patch value carries as a whole link, and only a scan of
the post-patch document would see it — a cost the validation
deliberately does not pay. The gap closes when links become opaque
`FabricPrimitive` Link objects instead of patchable plain JSON; until
then such a reference is caught by read-side assembly rather than at
commit time.

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
  whichever server handles that space by construction. `decomposeSchema`
  refuses to emit a reference whose closure the writer does not hold,
  and the commit boundary independently enforces the same obligation for
  raw commits that never went through it.
- **The read-side guarantee.** A query result is self-sufficient: every
  schema reference embedded in delivered documents resolves within the
  delivered set. Enforcement sits at the result-assembly boundary: after
  traversal establishes the documents being delivered, the server scans
  each complete document — a link schema anywhere in its value, or a
  delivered schema document's own refs — verifies each referenced
  closure against the delivering space's own store, and joins the whole
  closure to the delivered set and watch set. A missing or forged
  closure document fails the query loudly: the write-side guarantee
  installed closures with their referrers, so a hole is a consistency
  bug to surface, never to repair around. Scans are document-granular
  (delivery is), so no selected path can shadow another, and their
  results are cached per document version, so in steady state a version
  is scanned once however many sessions or refreshes deliver it.
  Traversal keeps its own gate where a schema enters it — the selector
  and a link: a schema whose closure the space does not hold selects
  nothing, since selecting by an uncollectable schema would produce a
  result whose shape the receiving client could never reproduce from
  what arrives.

Arrival mirrors the assembly pass rather than trusting it: BEFORE a frame
applies, every schema ref its documents embed — a registered `cid:`
schema document's own refs, or a link schema anywhere in an ordinary
document's value — must reach a document the prospective frame or the
stored replica holds whose content passes the identity check. Verified
content, never mere presence: a forged local copy fails even when the
realm registry holds a valid twin from another space, and content that
changes under a previously verified `cid:` id fails outright. A broken
ref rejects the frame whole, with the replica untouched. The repair
paths that do exist serve callers, not arrival: the traversal loader's
reads are tracked (arrival re-runs the reader), the missing-target kick
requests the fetch, and any sync of a schema document delivers its
whole closure through result assembly — never satisfied by
realm-registry presence alone.

Walking delivered values is a transitional cost: the intended end state
moves each document's embedded-ref information into a meta field
maintained at write time, so assembly consults an index instead of
scanning content, with the per-version scan cache bounding the cost
until then.

Outside a traversal — direct runtime resolution of an already-read
schema — a reader MAY reuse an identical, hash-verified schema another
synced space in the realm supplied. That is value sharing working as
intended, and it is strictly a read-side recovery: it never satisfies or
repairs the write-side guarantee, a cold realm still fails closed, and a
traversal deliberately does not take it — traversal is where the
read-side guarantee is enforced, and its strictness only ever bites where
the write-side guarantee was violated, which is exactly where a loud
signal is wanted. The commit boundary's closure validation makes the
write-side guarantee server-checked for every commit, up to the one
patch shape documented under Resolution.

### Traversal and sync

The server's shared traversal already follows the `cfc.schemaHash` seam by
synthesizing a `cid:` link and adding the document to the query result and
watch set (`cfcMetaToSigilLink` / `loadMetaLinkedDocs`). Beyond that seam,
delivery and traversal split the work in two layers:

- **Traversal** loads the closure where a schema enters it — the selector
  and a link — because resolution during the traversal needs the
  documents at hand, and its availability gate (a schema whose closure
  the space does not hold selects nothing) lives on the same reads.
  Traversal does not recurse into `cid:` documents.
- **Result assembly** owns delivery: it scans every complete document the
  query delivers, verifies each referenced closure against the space's
  own store, and joins it to the delivered set and watch set — failing
  the query on a hole. A refresh revalidates the established delivery
  state too, so a corrupted dependency fails even under an unchanged
  referrer. An assembly failure means the patch shape that escapes
  commit-time validation (see Resolution), out-of-band tampering, or a
  store predating that validation — never a transient condition, since
  the commit boundary validates every closure it collects and preserves
  every installed document. A
  request-shaped evaluation (watch installation, an initial query)
  answers its caller with the diagnostic as a QueryError; the fan-out
  refresh logs the failure and skips the affected session's frame,
  leaving the connection alone — the database was altered out of band
  (or the store predates commit-time validation), and that has no
  connection-level remedy. No frame from the failed pass is delivered
  and other sessions' fan-out proceeds; the failed session's incremental
  tracking state may be partially advanced, so it is marked for a full
  re-evaluation, and its next successful pass re-diffs everything. Under
  persistent corruption its delivery is simply suspended, with the log
  as the signal.

A client that syncs a document therefore receives the schema documents for
every link it contains in the same round trip, keeping the "resolved means
locally available" property. Schema documents are immutable, so their
presence in watch sets is quiet; whether they deserve a fetch-once path
instead is an open question shared with all `cid:` documents.

Scan results are cached per document version and engine, so in steady
state a version is scanned once however many sessions deliver it, and
closure verification memoizes per version the same way. The caches hold
one version per document and are bounded with wholesale eviction, so
alternating queries over historical versions, or a working set past the
bound, can rescan.

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
`docs/development/EXPERIMENTAL_OPTIONS.md`), phased on the op-migration
playbook:

- **Phase 0 — resolution infrastructure.** Session schema registry;
  `resolveSchemaRefs` learns `cid:` refs; verification at registration;
  traversal follows external refs out of schema documents. Readers can now
  handle references that nothing yet writes. The three memory walkers learn
  reference-only schema positions in the same change.
- **Phase 0.5 — commit-boundary enforcement.** `cid:` immutability
  (no delete, patch, or differing re-set) and commit-time closure
  validation (every collected reference — all but the one patch shape
  documented under Resolution — is backed, in the commit or the space's
  store, by content that verifies against its id, transitively), landed
  with the readers so no writer flag can ever produce a reference the
  boundary would not accept.
- **Phase 1 — write references on links (flag-gated).** Decomposition +
  same-transaction document installs; links carry references. Old inline
  links keep reading forever — links rewrite on every re-instantiation, so
  inline forms age out without a data migration. A canary pins the inline
  vintage.
- **Phase 2 — clients send references in selectors, and `$alias`
  bindings shed their embedded schemas.** Watch specs and one-shot
  queries carry references for persisted schemas. The server side
  already ships with Phase 0 — selector schemas resolve through the
  shared traversal, per space, under the availability scope — so the
  selector half is the client emission plus the loud protocol error for
  an unresolvable selector reference. Measured traffic puts selector
  schemas at roughly six percent of mixed pattern-test bytes with over
  seventy percent repetition, and higher in watch-heavy interactive
  sessions. The `$alias` half is not a traffic win (under half a
  percent measured) — it is a representation fix: an embedded schema
  can carry `FabricValue` defaults, which puts special objects inside
  otherwise plain binding records; a reference keeps binding objects
  plain JSON and confines schema content to schema documents. An alias
  is a binding only by CONTEXT: to the storage layer an `$alias`-shaped
  record is plain data, so no commit-boundary, materializer, arrival,
  or assembly walk treats its `schema` member as a schema position — a
  document that merely looks like a binding can neither fail a commit
  nor fail a query over a reference inside it. A binding's reference is
  emitted by the pattern serializer and resolves through the realm
  registry; a reader that cannot resolve it degrades to the schemaless
  binding it would have had before schemas were stamped at all.
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
2. **Server-side integrity enforcement.** Partially resolved: the commit
   boundary rejects mutations of `cid:` documents and validates the
   referenced schema closure (presence and content identity, transitively)
   for every commit, one documented patch shape excepted. What remains
   open is generic first-install
   verification for `cid:` documents nothing references — the boundary
   cannot name an unreferenced document's class, so a forged blob-or-other
   install is still confined to its space and fails closed when first
   referenced.
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
