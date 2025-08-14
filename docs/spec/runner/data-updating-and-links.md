Data Updating and Links (Behavioral Spec)

- Scope: Define observable behavior for normalization of inputs, interpretation
  of links and aliases, conversion to entities, diffing strategy, and
  application of change sets for writes. Internal function structure is
  flexible; behavior must match this spec.

Link Forms

- Detected link-like values: cells, sigil links (`{"/": {"link@1": ...}}`),
  legacy JSON cell links, legacy alias objects, `DocImpl` (deprecated), query
  result proxies, or entity id `{"/": string}`.
- Normalization: `parseLink(value, base?)` produces a `NormalizedFullLink` with
  `space`, `id`, `type`, `path`, optional `schema` and `rootSchema`, and
  optional `overwrite: "redirect"` for write-redirect links.
- Write-redirects: `isWriteRedirectLink(value)` returns true for legacy `$alias`
  and sigil links with `overwrite: "redirect"`.

Read Resolution

- Resolution must follow links encountered along the path; cycles or excessive
  hops must fall back to a static empty data link. Three leaf behaviors must be
  supported: follow all links; follow only write-redirects; follow none.
  Resolution must propagate schema hints to reflect destination depth and drop
  overwrite flags from the final identity.

Normalization and Diff

- Inputs to writes must be normalized prior to diffing. The result is an ordered
  list of writes `(location, value)` that transforms current state into the
  desired state. The list should be minimal with respect to observable JSON
  state.

- High-level behavior:
  - Circular inputs: detect object reference cycles and serialize repeats as
    relative links to their first appearance.
  - ID_FIELD: If input has `[ID_FIELD]: fieldName`, and target is an array, scan
    siblings for matching `fieldName` value; if found, reuse that entity and
    diff its value. Else, convert to a fresh entity using a random id.
  - Links as new value:
    - Data links: treat link content as the effective input; if content itself
      is a link, rebase with concatenated path and continue.
    - Non-data links: if equal to the current link, no-op; otherwise write the
      link as the new value.
  - Objects with `[ID]`: Convert to an entity reference using a derived id based
    on parent/space/path and optional context (excluding array indices when
    deriving). Emit a write of the link at the current location and a diff of
    the target entity’s content against the object without `[ID]`.
  - Arrays: if current is not an array, write `[]` first. Diff per index. If
    current is longer than new, write `length` and deletions for truncated
    indices. Respect classification when writing `length` for secret arrays.
  - Objects: if current is not a plain object or is a link, write `{}` first.
    Recurse into provided keys; delete keys missing in input.
  - Primitive/other: compare via `Object.is`; write only when different.

- Redirects in current value: if the current value is a write-redirect, resolve
  it and perform writes at the destination.

Applying Changes

- Apply the change set in order within the transaction, writing JSON values or
  `undefined` to delete. Partial writes (e.g., to `length`) must be consistent
  with overall state.

Helper Conversions

- Provide a conversion utility to serialize cells/streams/query-results to
  links, preserving cycles with relative links and honoring `toJSON` like
  JSON.stringify.

Equality and Identity

- Implement link equality across shapes to avoid redundant writes and enable
  `Cell.equals`.

Guidelines for Authors

- Always provide a transaction for writes. Prefer cell operations. Use
  `[ID_FIELD]` for array upserts. Avoid bypassing normalization rules.

Examples

- Writing a Data Link
  - Input: set value to a link with `id: 'data:application/json,{"x":1}'` and
    `path: ['y']`.
  - Behavior: resolve data link content; traverse to path `['y']` if present;
    write the resulting JSON value at the destination. ASCII
  ```
  newValue = link(data:{ x: { y: 5 }}, path:['y'])
  -> resolve -> 5
  -> write destination := 5
  ```

- Upsert into Array with ID_FIELD
  - Input: set array to
    `[ { [ID_FIELD]: 'slug', slug: 'a', v: 1}, { [ID_FIELD]: 'slug', slug: 'b', v: 2} ]`
    where the current array contains an entity with `slug: 'b'`.
  - Behavior: reuse the entity for `b` (diff its content), create a fresh entity
    for `a`, and set the array to links for both in order; truncate or extend as
    needed. ASCII
  ```
  current: [ Link(Entity b) ]
  new:     [ {slug:'a',v:1}, {slug:'b',v:2} ] w/ ID_FIELD='slug'
         -> [ Link(Entity a*), Link(Entity b) ] and diff(Entity b).v := 2
  ```

- Redirect at Destination
  - Input: current value is a write-redirect; new value is a primitive.
  - Behavior: resolve redirect to destination and write primitive there; do not
    overwrite redirect link at the source.
  ```
  src := { $alias: { path: ['dst'] } }
  set src := 7  =>  write dst := 7 (leave alias intact)
  ```

Gotchas

- Data links: Treat `data:` links as read-through content only. Writing a
  `data:` link at a destination should be a structural write (i.e., overwrite
  with the link) unless normalization explicitly inlines its content.
- Array length writes: When truncating arrays, ensure index deletions are
  applied consistently so observers don’t see ghost items.
- Circular references: For cycles in input objects, use relative links back to
  the first occurrence to avoid infinite recursion or duplication.
