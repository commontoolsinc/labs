# Plan — `_cf_link` result decode to live Cells + `sqliteQuery<Row>` lowering

Focused, test-first design for the two deferred pieces of M3 (Phases 4-decode
and 5 in [implementation-plan.md](../implementation-plan.md)):

- **A.** Query result rows surface `*_cf_link` columns as **live `Cell`s**
  (`q.result[i].author_cf_link` is a `Cell<User>` a pattern can `derive`/read).
- **B.** `sqliteQuery<Row>(...)` lowers the `Row` type argument to a runtime JSON
  Schema (like `toSchema<T>`) that (i) types results and (ii) marks which result
  columns are links (drives A, including **aliased** columns).

Encode-on-write already works and round-trips end-to-end through real storage
([packages/runner/test/sqlite-cf-link-roundtrip.test.ts](../../../../packages/runner/test/sqlite-cf-link-roundtrip.test.ts)).
The decode codec also already exists
([decodeCfLinkValue, cf-link.ts:61](../../../../packages/runner/src/builtins/sqlite/cf-link.ts));
what is missing is wiring decode into the **query result write** so reads
rehydrate to Cells. This plan supplies the missing mechanism.

---

## 0. Key mechanism (verified by probe)

To make `result[i].<linkcol>` a live Cell, the result cell must carry a schema
that marks `result.items.<linkcol>` as `asCell`, **and** the value stored at that
path must be a parsed **sigil-link object** (`{ "/": { "link@1": {...} } }`),
**not** the raw JSON sigil *string* that the SQLite TEXT column returns.

Why: the schema read path in
[schema.ts `validateAndTransform`](../../../../packages/runner/src/schema.ts) —
specifically the `asCell` branch at
[schema.ts:978-1013](../../../../packages/runner/src/schema.ts) — calls
[`readMaybeLink(tx, link)` (link-resolution.ts:360)](../../../../packages/runner/src/link-resolution.ts)
which only recognizes a value as a link if it is a sigil/legacy link **object**
(it reads sub-paths `"/" → "link@1"`). A JSON string is opaque to it and is
returned verbatim. So decode must produce the sigil **object** and store *that*.

**Probe (run, passed, since deleted):** built a result cell with schema
`{ result: { items: { properties: { author_cf_link: { asCell: ["cell"], type: "object" } } } } }`,
called `resultCell.asSchema(schema).set({ result: [{ author_cf_link: <sigilObject> }] })`,
then `resultCell.asSchema(schema).get().result[0].author_cf_link` → `isCell` was
`true` and `.get()` returned the target value `{ name: "Ada" }`. This confirms the
whole A path hinges on **storing the parsed sigil object under an asCell schema**.

Decision (store object vs decoded Cell): **store the parsed sigil-link object.**
Storing a `Cell` instance into a cell's value is not how persisted links work —
the schema-driven read is what produces the live Cell, and it needs the link
*object* in the stored value. (The existing `decodeCfLinkValue` returns a `Cell`,
which is the right shape for the *imperative* `cf-link` round-trip test but the
*wrong* shape for the result-cell write; see §1.2 for the small helper this adds.)

---

## 1. Piece A — decode result rows to live Cells

### 1.1 Where the result cell is written

[sqlite-builtins.ts `sqliteQuery`](../../../../packages/runner/src/builtins/sqlite-builtins.ts):

- The result cell is allocated **without a schema** by `makeResultCell`
  ([sqlite-builtins.ts:44-62, 169](../../../../packages/runner/src/builtins/sqlite-builtins.ts)
  — `runtime.getCell<T>(space, cause, undefined, tx)`).
- Rows are written raw at
  [sqlite-builtins.ts:217-223](../../../../packages/runner/src/builtins/sqlite-builtins.ts):
  `result.withTx(wtx).set({ pending: false, result: res.rows, requestHash })`.
  `res.rows` carry `*_cf_link` values as **JSON strings** straight from the column.

### 1.2 Staged change list (A)

1. **Add a "decode to sigil object" helper** in
   [cf-link.ts](../../../../packages/runner/src/builtins/sqlite/cf-link.ts).
   The existing `decodeCfLinkValue` (line 61) returns a *Cell*; add a sibling that
   returns the **parsed link object** (or `null`) for storage:

   ```ts
   /** Parse a stored `*_cf_link` value to a sigil-link OBJECT for storage under
    *  an asCell result schema (NULL/undefined -> null). Throws like decodeCfLinkValue. */
   export function parseCfLinkToSigil(value: unknown): SigilLink | null {
     if (value === null || value === undefined) return null;
     if (typeof value !== "string") throw new TypeError(...);
     let parsed: unknown;
     try { parsed = JSON.parse(value); } catch { throw new TypeError(...); }
     if (!isCellLink(parsed)) throw new TypeError("_cf_link value is not a sigil link");
     return parsed as SigilLink;          // already the { "/": { "link@1": ... } } object
   }
   ```

   (The stored string was produced by `encodeCfLinkValue` =
   `JSON.stringify(createSigilLinkFromParsedLink(...))`, so `JSON.parse` yields
   exactly the sigil object `readMaybeLink` wants. No re-`createSigilLink` needed.)

2. **Compute the set of link columns** for the result, by precedence (§3), in a
   helper `linkColumnsForResult(rowSchema, dbTables, sampleRowKeys)` returning
   `Set<string>` of result-key names. Sources:
   - injected `Row` schema (`asCell` props — see §2/§3) — handles aliases;
   - db `tables` `cfLink: true` markers
     ([schema.ts ColumnSchema.cfLink](../../../../packages/memory/v2/sqlite/schema.ts));
   - `*_cf_link` suffix via
     [`isCfLinkColumn`](../../../../packages/memory/v2/sqlite/columns.ts).

3. **Build the result schema dynamically** — `buildQueryResultSchema(linkCols, rowSchema?)`:

   ```ts
   {
     type: "object",
     properties: {
       pending: { type: "boolean" },
       error: true,
       requestHash: { type: "string" },
       result: {
         type: "array",
         items: rowSchema
           ? rowSchema                         // already carries asCell on link fields
           : { type: "object",
               properties: Object.fromEntries(
                 [...linkCols].map((c) => [c, { asCell: ["cell"], type: "object" }]),
               ),
               additionalProperties: true },
       },
     },
   }
   ```

   When a `Row` schema is injected, prefer it as `result.items` (it already marks
   `Cell<T>` fields `asCell: ["cell"]` via the schema generator — see §2); union
   in suffix/table-derived link cols for any not present in `Row`.

4. **Decode rows + write through the schema.** In the post-commit `flush`
   ([sqlite-builtins.ts:213-234](../../../../packages/runner/src/builtins/sqlite-builtins.ts)),
   before the `result.withTx(wtx).set(...)`:
   - map each row: for every key in `linkCols`, replace the JSON-string value with
     `parseCfLinkToSigil(value)`; leave other columns untouched;
   - write via the schema:
     `result.asSchema(resultSchema).withTx(wtx).set({ pending: false, result: decodedRows, requestHash })`.
   `asSchema` returns a sibling cell with the same identity but the link-aware
   schema ([cell.ts:1225 `asSchema`](../../../../packages/runner/src/cell.ts)); the
   stored value now holds sigil objects under `asCell` paths, so any reader that
   reads `result` **through the same schema** gets live Cells.

5. **Reader sees the schema.** Two options; pick (a) for V1:
   - **(a)** Stamp the schema at allocation: pass `resultSchema` into the
     `makeResultCell`/`getCell` call so the result cell's *own* link carries the
     schema and downstream `q.result[i].x` reads inherit it. This requires the
     link columns be known **at init** — they are, when `reactOn`/db tables and/or
     the injected `Row` schema are available in `inputsCell` on the first action
     tick (the db handle and `rowSchema` are inputs; the SQL is too, so the suffix
     set can be derived from the SQL's projection or deferred to first rows).
     Simplest correct form: compute `linkCols` from `Row` schema + db `tables`
     (both available at init) and stamp at allocation; the `*_cf_link` **suffix**
     fallback (for untyped, table-less queries) is applied per-write in step 4 and
     surfaced by re-stamping via `asSchema` on the write (works because schema
     travels with the stored link object regardless).
   - **(b)** Keep the result cell schema-less and require readers to opt in with
     `.asSchema(...)`. Rejected: patterns read `q.result[i].x` directly and must
     not need to know the schema.

   **Recommendation:** stamp from `Row`+`tables` at init (covers Examples 1 and 2),
   and additionally write through `asSchema(resultSchema)` in flush so the
   suffix-only fallback path is also covered. Net: `makeResultCell` gains an
   optional `schema` param forwarded to `runtime.getCell`.

### 1.3 Risk specific to A

- **Dynamic schema on the result cell.** The result cell is shared with
  `{pending,error,requestHash}` scalars; the schema must keep those permissive
  (`error: true`, etc.) so non-link fields are unaffected. Mitigated by the schema
  shape in step 3 (only `result.items.<linkcol>` is constrained).
- **Re-query / rev-bump** (`reactOn: db`) rewrites `result`; the decode + `asSchema`
  write must run on **every** flush, not just init. Step 4 lives inside `flush`, so
  this holds. Assert in the test that a re-query still yields a live Cell.
- **CFC / scope:** `getCellFromLink` carries scope from the sigil; absolute links
  produced by `encodeCfLinkValue` already include `scope`
  ([cf-link.ts:49-52](../../../../packages/runner/src/builtins/sqlite/cf-link.ts)),
  so cross-space/scoped targets resolve. No extra scope stamping needed (and per
  the runtime CLAUDE notes, avoid promoting asCell entry scope to schema scope).

---

## 2. Piece B — `sqliteQuery<Row>` transformer lowering

### 2.1 Current gap

`sqliteQuery` is **absent** from the transformer registry
([commonfabric-runtime-registry.ts:30-180](../../../../packages/ts-transformers/src/core/commonfabric-runtime-registry.ts)
— `grep sqlite` in `packages/ts-transformers/src` returns nothing). It is only a
runtime builtin via `createNodeFactory`
([built-in.ts:179](../../../../packages/runner/src/builder/built-in.ts)). So the
`<Row>` type argument is currently **erased with no schema emitted**, and the call
is not even classified as a reactive-origin call by the transformer.

Note: `streamData`/`fetchData`/`compileAndRun` are registered `runtime-call` but
have **no** schema-injection branch (their `<T>` is not lowered). The only
type-arg→schema precedents are `generate-object`, `wish`, `when`, `lift`. So B
must add a **dedicated injection branch** keyed on `exportName === "sqliteQuery"`
(modeled on `generate-object`), not rely on a generic `runtime-call` handler.

### 2.2 Exact registry entry

In [commonfabric-runtime-registry.ts](../../../../packages/ts-transformers/src/core/commonfabric-runtime-registry.ts),
add to `COMMONFABRIC_RUNTIME_EXPORT_REGISTRY`:

```ts
{ exportName: "sqliteQuery",    category: "call", callKind: "runtime-call", reactiveOrigin: true },
{ exportName: "sqliteDatabase", category: "call", callKind: "runtime-call", reactiveOrigin: true },
{ exportName: "sqliteExecute",  category: "call", callKind: "runtime-call", reactiveOrigin: true },
```

(`sqliteDatabase`/`sqliteExecute` are added for correct reactive-origin
classification; only `sqliteQuery` gets schema injection. `runtime-call` preserves
`exportName` on the resolved `CallKind`
— [call-kind.ts:1828-1840](../../../../packages/ts-transformers/src/ast/call-kind.ts)
— so the injection branch can key off the name.)

### 2.3 Exact injection rule

In [schema-injection.ts](../../../../packages/ts-transformers/src/transformers/schema-injection.ts),
add a branch mirroring the `generate-object` one
([schema-injection.ts:3710-3785](../../../../packages/ts-transformers/src/transformers/schema-injection.ts)).
`sqliteQuery(params)` takes a single options object; inject the lowered schema as a
new property `rowSchema` on that object (analogous to generate-object's `schema`):

```ts
if (callKind?.kind === "runtime-call" && callKind.exportName === "sqliteQuery") {
  const factory = transformation.factory;
  const typeArgs = node.typeArguments;
  const args = node.arguments;
  if (!typeArgs || typeArgs.length !== 1) {
    return ts.visitEachChild(node, visit, transformation);   // untyped: fall back to table/suffix
  }
  // Idempotency: skip if options already carry `rowSchema`.
  if (args.length > 0 && ts.isObjectLiteralExpression(args[0]!) &&
      (args[0] as ts.ObjectLiteralExpression).properties.some(
        (p) => p.name && ts.isIdentifier(p.name) && p.name.text === "rowSchema")) {
    return ts.visitEachChild(node, visit, transformation);
  }
  const resolved = resolveInjectableSchemaType(typeArgs[0], checker, sourceFile, factory, typeRegistry);
  const schemaCall = createRegisteredSchemaCallFromResolvedType(context, resolved, checker, typeRegistry);
  if (schemaCall) {
    const newOptions = /* { ...args[0], rowSchema: schemaCall } — same 3 cases as generate-object */;
    const updated = factory.createCallExpression(node.expression, node.typeArguments, [newOptions, ...args.slice(1)]);
    context.markSchemaInjected(updated);
    return ts.visitEachChild(updated, visit, transformation);
  }
}
```

`createSchemaCallWithRegistryTransfer`/`createRegisteredSchemaCallFromResolvedType`
emit the literal off the `TypeRegistry`; `schema-generator.ts` needs **no** change
([adding-type-arg-schema-lowering.md §"Schema generator"](../../../../packages/ts-transformers/docs/adding-type-arg-schema-lowering.md)).

### 2.4 How `Cell<T>` in `Row` becomes `asCell` (so links are detectable, even aliased)

Verified: the schema generator already lowers `Cell<T>` to `{ ...type-of-T, asCell: ["cell"] }`
([schema-generator test cell-type.test.ts:7-19](../../../../packages/schema-generator/test/schema/cell-type.test.ts);
`type-utils.ts:30 case "Cell"`). So
`sqliteQuery<{ author: Cell<User>; n: number }>(...)` lowers to a `rowSchema`
whose `properties.author` is `asCell: ["cell"]` — **by the field name `author`,
the alias**, not by any `_cf_link` suffix (which the alias drops). This is the
**only** source that can detect aliased link columns (Example 2,
[07-examples.md:83-107](../07-examples.md)). It directly feeds `linkColumnsForResult`
(§1.2 step 2) and `result.items` (§1.2 step 3).

### 2.5 Runtime builtin change to receive the schema

In [sqlite-builtins.ts `sqliteQuery`](../../../../packages/runner/src/builtins/sqlite-builtins.ts),
read `rowSchema` from inputs (exactly as `generateObject` reads `schema` from
`inputs.get()` — [llm.ts:937-943](../../../../packages/runner/src/builtins/llm.ts)):

```ts
const inputs = inputsCell.withTx(tx).get() as {
  db?; sql?; params?; reactOn?; rowSchema?: JSONSchema;
};
```

Pass `inputs.rowSchema` into `linkColumnsForResult` and `buildQueryResultSchema`
(§1.2). When absent, fall back to db `tables` + `*_cf_link` suffix.

Also update the public type
[`SqliteQueryParams`/`SqliteQueryFunction`, api/index.ts:2170-2178](../../../../packages/api/index.ts)
only if `rowSchema` should be visible in the type (it should remain
transformer-injected and *not* author-facing; keep it out of `SqliteQueryParams`
and read it loosely at runtime, matching how generate-object's injected `schema`
is appended to options the author didn't write).

---

## 3. Precedence (link-column detection)

For each result column, mark it a link column if **any** source says so, in this
priority for shaping `result.items` (higher wins on conflicting *schemas*, but for
the boolean "is a link" the sources are unioned):

1. **Injected `Row` schema** — `properties.<key>.asCell` present. Authoritative;
   the only one that survives **aliases/joins/computed columns**. Also supplies the
   element type for non-link fields.
2. **db `tables` cfLink markers** — `tables[<table>].properties.<col>.cfLink === true`
   ([schema.ts](../../../../packages/memory/v2/sqlite/schema.ts)). Works for direct
   `SELECT col` from a declared table (Example 1), no `<Row>` needed.
3. **`*_cf_link` suffix** on a returned key — `isCfLinkColumn(key)`
   ([columns.ts:8](../../../../packages/memory/v2/sqlite/columns.ts)). Last-resort
   fallback for untyped, table-less queries; matches the encode-side default.

**Decode path in the result write** (§1.2 step 4): `linkColumnsForResult` computes
the union; for those keys, `parseCfLinkToSigil` replaces the JSON string with the
sigil object; the row is written via `asSchema(buildQueryResultSchema(...))`.

---

## 4. First deterministic failing tests

### (A) Runner test — `q.result[0].author_cf_link` is a live Cell

New file `packages/runner/test/sqlite-cf-link-decode.test.ts`. Two viable drivers:

- **Driver 1 (recommended, builder-free, deterministic):** mirror
  [sqlite-cf-link-roundtrip.test.ts](../../../../packages/runner/test/sqlite-cf-link-roundtrip.test.ts)
  — write the link via `provider.sqliteExecute!`, then drive the **builtin's
  decode+schema write** by allocating a result cell, calling the decode helper +
  `asSchema(buildQueryResultSchema(...)).set(...)`, and asserting the read. This
  isolates the A mechanism without the reactive builder.
- **Driver 2 (full path):** run a pattern with `sqliteExecute` + `sqliteQuery`
  like [sqlite-builtins.test.ts:116-159](../../../../packages/runner/test/sqlite-builtins.test.ts).
  **Caveat found while probing:** passing an outer `Cell` as a positional param
  inside the pattern callback throws *"Reactive cell from an outer scope was
  captured by a closure"* (builder scope rule). Thread the author cell through the
  pattern **inputs** (not a closure capture), e.g. `cf.pattern((author) => {...})`
  run with `{ author }`. Prefer Driver 1 for the *first* failing test; add Driver 2
  as the integration test once A lands.

**Isolation (critical):** use a **unique space per test** —
`(await Identity.fromPassphrase(\`decode-${crypto.randomUUID()}\`)).did()` — because
the cell-db temp file is keyed by `(space, dbId)` and **leaks rows across runs**
otherwise (see [plans/reactivity.md](./reactivity.md) and the existing reactive
test [sqlite-builtins.test.ts:121-122](../../../../packages/runner/test/sqlite-builtins.test.ts)).

Assertions (the failing expectations before the wiring exists):

```ts
import { isCell } from "../src/cell.ts";
// ... write author cell, INSERT its encoded link, query it back via the builtin path ...
const col = q.result[0].author_cf_link;
expect(isCell(col)).toBe(true);                  // FAILS today: it is a JSON string
expect(col.get()).toEqual({ name: "Ada" });      // live target value
// NULL column:
expect(qNull.result[0].author_cf_link).toBeNull();
```

Today this fails because the result cell is schema-less and `result` holds the raw
JSON string ([sqlite-builtins.ts:217-223](../../../../packages/runner/src/builtins/sqlite-builtins.ts)).
**Probe evidence:** the isolated `asCell`-schema read mechanism was verified to
return a live Cell (see §0); the only missing step is the builtin storing the
sigil object under that schema.

Add a second runner test for the **aliased** column (Example 2) once B lands:
`sqliteQuery<{ author: Cell<User>; n: number }>` over `... author_cf_link AS author`
yields `q.result[0].author` as a live Cell — proving `Row`-schema precedence over
the dropped suffix.

### (B) Transformer fixture pair

Under [packages/ts-transformers/test/fixtures/](../../../../packages/ts-transformers/test/fixtures/),
add a `schema-injection/` pair (picked up by
[fixture-based.test.ts](../../../../packages/ts-transformers/test/fixture-based.test.ts)),
modeled on
[wish-and-generate-object-contextual.{input,expected}](../../../../packages/ts-transformers/test/fixtures/schema-injection/wish-and-generate-object-contextual.input.tsx):

- `sqlite-query-row-schema.input.tsx`:
  ```ts
  import { sqliteQuery, type Cell } from "commonfabric";
  // ... declare interface User { name: string }
  const q = sqliteQuery<{ author: Cell<User>; n: number }>({
    db, sql: "SELECT author_cf_link AS author, count(*) AS n FROM m GROUP BY author_cf_link",
  });
  ```
- `sqlite-query-row-schema.expected.jsx`: the call with an injected
  `rowSchema: { type: "object", properties: { author: { ..., asCell: ["cell"] }, n: { type: "number" } }, required: [...] } as const satisfies __cfHelpers.JSONSchema`
  property added to the options object (exact shape per the generate-object
  expected fixture). Verifies (i) injection happens, (ii) `Cell<User>` lowered to
  `asCell: ["cell"]` under the **alias** `author`.

A second fixture (`sqlite-query-no-type-arg`) asserts **no** injection when `<Row>`
is omitted (idempotency / fallback path).

---

## 5. Staged landing order

1. **B-registry + B-injection + B-fixtures** first (pure transformer, no runtime
   risk; fixtures are the cheapest deterministic gate). Exit: fixture pair passes.
2. **A-helpers** (`parseCfLinkToSigil`, `linkColumnsForResult`,
   `buildQueryResultSchema`) with unit coverage.
3. **A-wiring** in `sqliteQuery` flush (decode + `asSchema` write + init stamp).
   Exit: runner test (A, Driver 1) passes; NULL → null; re-query still yields Cell.
4. **A+B integration**: aliased-column runner test (Driver 2) + full pattern path.

---

## 6. Risks & how this augments `implementation-plan.md`

- **Dynamic schema on a shared result cell** (§1.3): constrain only
  `result.items.<linkcol>`; keep scalars permissive. Lower risk than it looks
  because `asSchema` is per-read sibling creation, identity preserved
  ([cell.ts:1225](../../../../packages/runner/src/cell.ts)).
- **Transformer dependency:** A's *aliased* case depends on B. But A's
  direct-column case (Example 1) works from db `tables` + suffix **without** B —
  so A is shippable independently, and B strictly widens coverage. Sequence keeps
  each landing independently green.
- **Stored-shape commitment:** storing the **sigil object** (not a string, not a
  `Cell`) is load-bearing and verified (§0). If a future change makes the column
  decode happen at the storage layer, this builtin step becomes a no-op — but the
  asCell result schema is still required for the read to produce a Cell.
- **Builder closure-capture gotcha** (found while probing, §4-A Driver 2):
  document in the test that cells must be threaded as pattern inputs, not captured.
- **Untyped + table-less + non-suffixed** link columns are undetectable by design
  (no source marks them); documented as a known limitation — authors must use
  `<Row>` (B) or a `*_cf_link` alias.

**Augments implementation-plan.md:** fills in the "Decode (query builtin)" bullet
of [Phase 4 (lines 253-255)](../implementation-plan.md) with the verified
sigil-object-under-asCell-schema mechanism and the `asSchema`-on-write step, and
makes [Phase 5 (lines 264-292)](../implementation-plan.md) concrete: the exact
registry entries (§2.2), the `rowSchema` injection branch keyed on `exportName`
(§2.3, noting `runtime-call` has no generic injector — a dedicated branch is
required), the `Cell<T> → asCell` evidence (§2.4), and the runtime read of
`inputs.rowSchema` (§2.5).
