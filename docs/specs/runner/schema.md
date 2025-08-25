# Schema-Driven Reads (Behavioral Spec)

- Scope: Defines how schemas influence read shapes and identity, including
  `asCell`, `asStream`, `$ref` resolution, `anyOf` handling, defaults, array
  element link-following, and annotations enabling reconstruction of Cells from
  read values. Internal structure is flexible; behavior must match this spec.

Schema Resolution

- `$ref` must be resolved against `rootSchema` for child lookups. When
  interpreting the destination for writes, `asCell`/`asStream` flags are not
  part of the destination type. Boolean/“true” schemas imply no constraints and
  can be treated as absent.

Defaults and Construction

- When an underlying value is `undefined` and a schema has a `default`, a read
  must materialize a value shaped by the schema:
- `asCell`: return a Cell that references the current destination. If the cell
  branch itself specifies a `default` and the current value is falsy, return a
  separate immutable cell referencing that default value to keep identity stable
  across later changes.
- `asStream`: return a stream placeholder object (implementation-defined),
  suitable for receiving events later.
- Objects: recursively construct properties from schema/defaults. `asCell`
  properties are constructed even if `undefined`. Required object/array
  properties without defaults should be materialized as `{}`/`[]` respectively.
- Arrays: map item schema over default array to produce elements.
- Primitives: return the literal.

Back-To-Cell Annotations

- Returned plain objects/arrays must be immutable and annotated so that callers
  can reconstruct a Cell at the same identity and obtain an opaque reference for
  identity/serialization needs.

Validation and Transformation on Read

- Reads must follow intermediary links and write-redirects on the leaf to
  establish the effective destination for consistent write backs.
- When links carry schema hints, child schema must be computed at the remaining
  path depth and applied to the destination; otherwise, carry forward the
  original schema/root schema.
- Self-referential structures must not cause infinite recursion; implementations
  must ensure repeated visits yield the same object identity for that read.

Return Shapes

- No schema: return a live query result view that yields raw values and records
  reads for reactivity.
- asCell/asStream, or anyOf whose options are exclusively asCell/asStream:
  return a Cell or stream reference based on the current value, after following
  aliases. If link appears mid-path, splice destination path with the remainder
  to build the correct identity and compute child schema accordingly.
- anyOf:
- Arrays: if value is an array and multiple `array` options exist, merge item
  branches (flatten `items.anyOf` when present) and process as a single array
  with a merged `anyOf` for items.
- Objects: evaluate each object-typed branch and merge resulting plain-object
  projections. If any branch yields a Cell, that Cell takes precedence for the
  entire object branch.
- Primitives: choose a branch matching the primitive type; if multiple match,
  prefer the branch with no `type` (acts as catch-all), otherwise choose the
  first.
- Objects: build an object with keys from schema, including defaults and
  `asCell` properties. For additional properties not explicitly declared,
  compute a child schema via path lookup and process. If the underlying value is
  not an object and the projection is empty, return `undefined`.
- Arrays: if underlying value is not an array, return an immutable empty array.
  If elements are links, follow them so that element values reflect current
  items rather than positional links; this enables copy/splice patterns that
  remove by position without changing element identities inadvertently.
- Primitives: return the current value. If `undefined` and the schema has a
  `default`, materialize the default value according to the schema rules above.

asCell/asStream Semantics

- `asCell`: reading yields a Cell whose identity is based on the current
  referenced value (after following redirects). Destination schema for that Cell
  must exclude `asCell` so writes operate against data, not the wrapper.
- `asStream`: reading yields a stream placeholder; event producers bind later.
  Reads do not create active bindings.

Source Cells

- When a read produces values derived from other storage locations, the system
  should expose a way (e.g., via `getSourceCell`) to obtain a Cell pointing at
  the origin of that value for editing. Exposing this is implementation-defined
  and may not always be available.

Examples

- anyOf Object Merge
  - AnyOf:
    `[ { type: 'object', properties: { a: { type: 'number' }}}, { type: 'object', properties: { b: { type: 'string' }}} ]`
  - Underlying value: `{ a: 1, b: 'x', c: true }`
  - Read result: `{ a: 1, b: 'x' }` (merged projection). If one branch specifies
    `asCell`, that cell takes precedence as the representation. ASCII
  ```
  value:   { a: 1, b: "x", c: true }
  anyOf:   [ Obj{a}, Obj{b} ]
  project:   { a: 1 }  +  { b: "x" }  =>  { a: 1, b: "x" }
  ```

- Array of Links
  - Schema: `{ type: 'array', items: { $ref: '#/defs/Item' }}` and underlying
    array contains links to items.
  - Read: For each element, follow the link and return the item’s current value;
    pushing a copy of the array back with an element removed updates length and
    deletes trailing indices.
  ```ts
  const arr = cell.asSchema({ type: "array", items: { $ref: "#/defs/Item" } })
    .get();
  const copy = [...arr];
  copy.splice(2, 1);
  cell.withTx(tx).set(copy);
  ```

Gotchas

- Mixed anyOf branches: If some anyOf branches return Cells and others plain
  objects, a Cell branch takes precedence. This is intentional but can be
  surprising if not documented.
- Boolean schemas: A `true` (catch-all) schema in anyOf acts as a default; it
  may overshadow more specific branches if ordered first.
- `$ref` with asCell: Remember that `asCell` applies to reads; destination
  schema used for writes must strip `asCell`.
