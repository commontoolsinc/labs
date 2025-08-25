# Cell Abstraction (Behavioral Spec)

- File: `packages/runner/src/cell.ts`
- Purpose: A typed, reactive façade over a location in storage identified by a
  normalized link (space + entity URI + path + type), optionally constrained by
  a JSON schema. This document specifies observable behaviors and invariants for
  a new implementation; internal structure is flexible as long as behavior is
  preserved.

Core Concepts

- Link-backed: Every `Cell<T>` is defined by a normalized identity (space, URI,
  type, path, schema, rootSchema). Methods operate against that identity,
  resolving redirects/aliases as defined in the Links spec.
- Transactions: Mutations require an open transaction bound to the cell. Reads
  may use ephemeral transactions for dependency tracking.
- Schema-aware reads: `get()` must interpret schema features
  (asCell/asStream/anyOf/defaults) and follow redirects for the final path
  segment where required.
- Sync: `sync()` should opportunistically request storage synchronization for
  non-`data:` entities.
- Reactivity: `sink(cb)` re-invokes `cb` when any document read during
  evaluation changes.

API Summary

- `get(): Readonly<T>`: Returns current value after schema-driven
  transformation. Should trigger `sync()` if needed.
- `set(value) / send(value)`: Assigns a new value respecting link redirects and
  normalization rules. Requires `tx`.
- `update(partial)`: For object cells; initializes `{}` when permitted; applies
  per-key updates. Requires `tx`.
- `push(...values)`: For array cells; creates `[]` if needed; appends values
  with entity conversion and link semantics. Requires `tx`.
- `equals(other)`: Structural equality by link identity via `areLinksSame`.
- `key(k)`: Returns a child cell addressed by extended path, with child schema
  calculated via `runtime.cfc.getSchemaAtPath(schema, [k], rootSchema)` and
  preserved `rootSchema`.
- `asSchema(schema?)`: Returns a new cell with provided schema and `rootSchema`
  set; resets `synced` false so future reads re-evaluate with new schema rules.
- `withTx(tx)`: Binds a transaction for subsequent writes.
- `sink(cb)`: Subscribes based on reads observed during evaluation; re-invokes
  on changes.
- `sync()`: Marks as synced and asks storage to synchronize unless `data:` URI.
- Link queries: Must support producing a live query result proxy for raw reads
  and serializable links for the cell identity (and write-redirect destination
  when requested).
- Raw access: `getRaw(options?)` and `setRaw(value)` bypass schema validation
  and alias following for writes/reads.
- Source cell: `getSourceCell(schema?)`/`setSourceCell(cell)` allow mapping to
  original source when schema-based extraction returns derived cells. Useful for
  edits that should target origin.
- Metadata: `runtime`, `tx`, `schema`, `rootSchema`, `space`, `entityId`,
  `sourceURI`, `path`. Debug helpers: `value` and `cellLink`. `copyTrap` throws
  to prevent copying/traversal of cells unexpectedly.
- Opaque refs: `[toOpaqueRef]()` returns a stable opaque reference for identity
  comparison or serialization.

Read/Write Semantics

- Reads: Must follow intermediary links and write-redirects on the leaf to
  ensure subsequent writes target the same destination. Apply schema defaults
  when undefined.
- Writes: Must normalize new values (unwrap proxies, convert cells to links,
  apply `[ID]`/`ID_FIELD`, handle `data:` links), resolve write-redirects,
  compute minimal change sets, and write them transactionally.
- Links: Provide canonical link serialization and equality based on normalized
  identity.

Common Patterns

- Object edits: `cell.update({title: "New"})` is equivalent to
  `cell.key("title").set("New")` per key with schema-aware writes.
- Array edits: `cell.push(itemOrCell)` appends; if first write, ensures array
  exists; supports inserting objects that will be turned into entities using
  `[ID]` or `[ID_FIELD]` rules.
- Subcells: `cell.key("foo").asSchema(childSchema).withTx(tx).set(value)`
  targets nested structures under a different schema while preserving identity
  semantics.

Constraints and Errors

- Mutations without `tx` must throw. Updating non-objects with `update` must
  throw. Pushing into non-array must throw. Implementations should trap
  structural traversal of Cells to surface misuse.

Additional Requirements

- Returned object/array read views must be frozen or otherwise immutable and
  carry the ability to reconstruct a `Cell` at the same identity (e.g., via a
  symbol method) and to produce an opaque reference suitable for identity
  comparison/serialization.

Examples

- asCell Read/Write Path
  - Schema:
    `{ properties: { current: { asCell: true, $ref: '#/defs/Item' } }, defs: { Item: { type: 'object', properties: { name: { type: 'string' }}}}}`
  - Read: `cell.key('current').get()` yields a Cell pointing to the referenced
    item (after following redirects).
    `cell.key('current').get().key('name').get()` returns the live name.
  - Write: `cell.key('current').get().key('name').withTx(tx).set('X')` writes to
    the referenced item’s `name`, not the alias. ASCII

  ```ts
  current (alias) -> Item#42
  Item#42.name = "Old"
        |
        v
  set name("X")
        |
        v
  write redirect follows -> Item#42.name := "X"
  ```

- Array Push with ID_FIELD
  - Given `list` is an array cell,
    `list.push({ [ID_FIELD]: 'slug', slug: 'a', title: 'A' })` searches siblings
    for an element whose `slug` equals `'a'`; if found, updates that entity;
    else creates a new entity with a random id and sets the array element to a
    link to it.

  ```ts
  const tx = runtime.edit();
  list.withTx(tx).push({ [ID_FIELD]: "slug", slug: "a", title: "A" });
  tx.commit();
  ```

Gotchas

- copyTrap: Cells should not be traversed as plain objects. Attempting to
  spread/iterate a Cell should throw early to reveal misuse.
- Source cell optionality: `getSourceCell()` is best-effort; do not rely on it
  being present for all read projections.
- Read-only defaults: Default values materialized from schema are immutable
  views; mutating them directly is a no-op—use writes on the corresponding
  cells.
