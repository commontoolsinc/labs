# Plan — `sqliteQuery<Row>` type-argument lowering (Piece B)

> Test-first design. **No implementation in this document.** Investigation +
> design only. Every claim below is anchored to a file:line in the
> `feat/sqlite-builtin-impl` worktree and was read directly, not inferred.

## 0. Why this is the fix (carry-over from the proven verdict)

`node-output-schema-propagation.md` (VERDICT block, 2026-06-01) proved
empirically that `_cf_link` query-result auto-decode **cannot** be done at the
runner layer: runtime navigation derives a child's schema **top-down from the
CONSUMER's own schema**, and an untyped `sqliteQuery` lowers to an empty (`{}`)
consumer schema, so descending `q → result → [i] → author_cf_link` never carries
`asCell`. The only thing that worked was applying `.asSchema({… asCell})` **at
the reading cell** ("EXPLICIT asSchema" probe). Therefore the `asCell` markers
must live on the **consumer's** schema, and the only call-site source of those
markers for an arbitrary query is the `Row` **type argument**. Piece B = make
`sqliteQuery<Row>` inject an `asCell`-bearing schema at the call site. This is a
**prerequisite** for decode, not an independent nicety.

The blocked target is pinned today as a skipped test at
`packages/runner/test/sqlite-cf-link-decode.test.ts:211-218`.

---

## 1. Mechanism — how type-argument → schema lowering works *today*

### 1.1 The registry classifies the export

`packages/ts-transformers/src/core/commonfabric-runtime-registry.ts`. Every
recognized runtime export has an entry; for calls it carries a `callKind`. The
relevant `callKind`s and entries (verified):

- `generateObject` → `callKind: "generate-object"` (registry line 120-125).
- `fetchData`, `streamData`, `compileAndRun`, `fetchProgram`, `navigateTo`, `str`,
  `llm`, … → `callKind: "runtime-call"` (lines 132-179).
- `sqliteQuery` / `sqliteDatabase` / `sqliteExecute` → **absent**. Verified: a
  grep for `runtime-call` / `exportName ===` in `schema-injection.ts` returns
  nothing, and `sqlite*` does not appear in the registry array (lines 30-180).

`CommonFabricRuntimeExportSpec` (lines 1-28) is a discriminated union; the field
that drives schema behavior is `callKind` (for `category: "call"`). There is **no
schema-injection-enabling boolean** — injection is keyed entirely off `callKind`
in the schema-injection visitor (§1.3). `reactiveOrigin` only affects
reactive-origin classification, not schema injection.

### 1.2 `runtime-call` preserves the export name (this is what we will key on)

`packages/ts-transformers/src/ast/call-kind.ts:1828-1840`:

```ts
case "runtime-call":
  return symbol
    ? { kind: "runtime-call", symbol, exportName: name, reactiveOrigin: spec.reactiveOrigin }
    : { kind: "runtime-call", exportName: name, reactiveOrigin: spec.reactiveOrigin };
```

So the resolved `CallKind` for a `runtime-call` carries `exportName`. A schema
injection branch can therefore dispatch on
`callKind.kind === "runtime-call" && callKind.exportName === "sqliteQuery"`.

**Critical confirmed gap:** there is **no** generic `runtime-call` schema-injection
branch in `schema-injection.ts` (grep for `runtime-call` and `exportName ===`
returns 0 matches in that file). That means `streamData<T>`, `fetchData<T>`, etc.
get their `<T>` **erased with no schema emitted**. A new builtin that wants
type-arg lowering MUST add a **dedicated branch** (modeled on `generate-object`);
registering as `runtime-call` alone does nothing for schema injection.

### 1.3 Where `generateObject<T>` gets its `<T>` lowered (the precedent to copy)

`packages/ts-transformers/src/transformers/schema-injection.ts`. The visitor
(`visit`, starts at line 2882) detects the call kind via
`detectCallKind(node, checker)` (line 2982) and dispatches per kind. The
`generate-object` branch is **lines 3710-3785**:

```ts
if (callKind?.kind === "generate-object") {
  const factory = transformation.factory;
  const typeArgs = node.typeArguments;
  const args = node.arguments;

  // Idempotency: skip if options already has a `schema` property
  if (args.length > 0 && ts.isObjectLiteralExpression(args[0]!)) {
    const props = (args[0] as ts.ObjectLiteralExpression).properties;
    if (props.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "schema")) {
      return ts.visitEachChild(node, visit, transformation);
    }
  }

  const resolved = resolveInjectableSchemaType(typeArgs?.[0], checker, sourceFile, factory, typeRegistry, () => {...});
  const schemaCall = createRegisteredSchemaCallFromResolvedType(context, resolved, checker, typeRegistry);

  if (schemaCall) {
    let newOptions: ts.Expression;
    if (args.length > 0 && ts.isObjectLiteralExpression(args[0]!)) {
      // Add `schema` property to existing object literal
      newOptions = factory.createObjectLiteralExpression([
        ...(args[0] as ts.ObjectLiteralExpression).properties,
        factory.createPropertyAssignment("schema", schemaCall),
      ], true);
    } else if (args.length > 0) {
      // Options is an expression -> { ...opts, schema: ... }
      newOptions = factory.createObjectLiteralExpression([
        factory.createSpreadAssignment(args[0]!),
        factory.createPropertyAssignment("schema", schemaCall),
      ], true);
    } else {
      newOptions = factory.createObjectLiteralExpression(
        [factory.createPropertyAssignment("schema", schemaCall)], true);
    }
    const updated = factory.createCallExpression(node.expression, node.typeArguments, [newOptions, ...args.slice(1)]);
    context.markSchemaInjected(updated);
    return ts.visitEachChild(updated, visit, transformation);
  }
}
```

Key facts this establishes for our design:

- **The injected schema is a property on the options object** (`schema:`), NOT a
  trailing positional argument and NOT a separate node-output schema. For
  `sqliteQuery` we mirror this by adding a property to its single options object.
- The lowering uses two shared helpers:
  - `resolveInjectableSchemaType(typeNode, checker, sourceFile, factory, typeRegistry, inferType)`
    (schema-injection.ts:939-970) — resolves the explicit `<Row>` `TypeNode` into a
    `{ typeNode, type, inferred:false }`.
  - `createRegisteredSchemaCallFromResolvedType(context, resolved, checker, typeRegistry)`
    (schema-injection.ts:1064-1093) — builds the schema-emitting call expression and
    transfers the resolved `ts.Type` into the `TypeRegistry` so `schema-generator.ts`
    emits the concrete JSON Schema literal at codegen. **It emits the schema for the
    resolved type AS-IS — it does not wrap it.** (This is the load-bearing fact for
    the `result.items` decision in §2.3.)
- **Idempotency** is owned by `context.markSchemaInjected(updated)` plus a
  top-of-visit guard (`context.isSchemaInjected(node)`, lines 2891-2896) that, once
  a node is marked, only descends into children. The per-branch
  `already-has-schema` check (lines 3716-3725) is a secondary dispatch guard for
  user-authored `schema`.

The emitted literal shape (verified from the expected fixture
`packages/ts-transformers/test/fixtures/schema-injection/wish-and-generate-object-contextual.expected.jsx:69-83`):

```jsx
const explicitObject = generateObject<{ title: string; }>({
    model: "gpt-4o-mini",
    prompt: "Return a title",
    schema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"]
    } as const satisfies __cfHelpers.JSONSchema
}).for("explicitObject", true);
```

i.e. `schema: <literal> as const satisfies __cfHelpers.JSONSchema`, appended to
the authored options object. Type arguments are preserved on the emitted call
(the fixture keeps `<{ title: string }>`).

### 1.4 How `Cell<T>` becomes `{ asCell: ["cell"], … }`

This is handled by the **schema generator** (`packages/schema-generator/`), which
runs over the `TypeRegistry` entry transferred in §1.3 — the transformer itself
does not special-case `Cell<>`. Confirmed emission:

- `packages/schema-generator/src/formatters/object-formatter.ts:50-72`
  (`getWrapperSchemaFromCallable` and the inline checks):

```ts
if (wrapperInfo?.kind === "Stream") return { asCell: ["stream"] };
if (wrapperInfo?.kind === "Cell")   return { asCell: ["cell"] };
```

- Confirmed by unit test
  `packages/schema-generator/test/schema/cell-type.test.ts:7-19`:
  for `interface X { name: Cell<string> }`, the generated `properties.name` is
  `{ type: "string", asCell: ["cell"] }` and `name` is `required`.

So `sqliteQuery<{ author: Cell<User>; n: number }>` lowers to a schema whose
`properties.author = { …User…, asCell: ["cell"] }` — **keyed by the alias name
`author`**, independent of any `_cf_link` suffix. The recursion that handles
nested `Cell<>`/`Stream<>` lives in object-formatter; `asCell` marker shape is the
array `["cell"]` / `["stream"]` (also `["opaque"]` for OpaqueRef,
object-formatter / common-fabric-formatter:1963-1969).

### 1.5 How the injected schema reaches the runtime (the generateObject precedent)

The injected `schema:` property is read at runtime exactly like an author-supplied
field. `GenerateObjectParamsSchema`
(`packages/runner/src/builtins/llm-schemas.ts:202-213`) **includes** `schema:
JSONSchemaValueSchema`, and the builtin reads it from inputs:

`packages/runner/src/builtins/llm.ts:922,932-943`:

```ts
const inputs = inputsCell.asSchema(GenerateObjectParamsSchema);
…
const { prompt, messages, maxTokens, model, schema, system, … } = inputs.withTx(tx).get() ?? {};
```

So the injected schema flows in as a normal input value the builtin reads. The
builtin then *uses* that schema however it wants (generateObject validates the LLM
result against it). **The transformer does not decide the schema's structural
role — the builtin does.** This is the seam that lets us put `Row` at
`result.items` (§2.3) without any transformer wrapping.

---

## 2. Design — make `sqliteQuery<Row>` inject `result.items = <Row schema>`

### 2.1 Current `sqliteQuery` typing & registration

- Public type `packages/api/index.ts:2170-2178`:
  ```ts
  export type SqliteQueryParams = {
    db: Opaque<SqliteDatabase>;
    sql: string;
    params?: ReadonlyArray<unknown> | Record<string, unknown>;
    reactOn?: unknown;
  };
  export type SqliteQueryFunction = <Row = Record<string, unknown>>(
    params: Opaque<SqliteQueryParams>,
  ) => OpaqueRef<{ pending: boolean; result?: Row[]; error?: any }>;
  ```
  Note: the generic `<Row>` already exists and types the **return** (`result?:
  Row[]`), but `Row` is **not** referenced anywhere in the params, so the
  transformer cannot recover it from arguments — it must read `node.typeArguments`.
- Runtime factory `packages/runner/src/builder/built-in.ts:179-182`:
  ```ts
  export const sqliteQuery = createNodeFactory({ type: "ref", implementation: "sqliteQuery" }) as SqliteQueryFunction;
  ```
  Pure runtime builtin; no transformer awareness today.

### 2.2 Minimal registry change

Add to `COMMONFABRIC_RUNTIME_EXPORT_REGISTRY`
(`commonfabric-runtime-registry.ts`, before the closing `]`):

```ts
{ exportName: "sqliteQuery",    category: "call", callKind: "runtime-call", reactiveOrigin: true },
{ exportName: "sqliteDatabase", category: "call", callKind: "runtime-call", reactiveOrigin: true },
{ exportName: "sqliteExecute",  category: "call", callKind: "runtime-call", reactiveOrigin: true },
```

- Only `sqliteQuery` gets schema injection; `sqliteDatabase`/`sqliteExecute` are
  added so they are classified as recognized reactive-origin calls (consistent
  with the other builtins). This is additive — `runtime-call` requires no new
  union arm (it already exists, lines 11-21).
- `runtime-call` preserves `exportName` (§1.2), so the new injection branch can
  key off `callKind.exportName === "sqliteQuery"`.

### 2.3 The injection branch (where `Row` maps to `result.items`, not whole-arg)

**Design decision — the transformer injects the BARE `Row` schema; the runtime
builtin composes `result.items`.** Rationale, with evidence:

- `createRegisteredSchemaCallFromResolvedType` (schema-injection.ts:1064-1093)
  emits the schema for the resolved type **as-is**; it has no wrapping option.
  Generating a `{ result: { items: <Row> } }` literal in the transformer would
  require hand-building object-literal AST around the helper's output — possible
  but bespoke and fragile.
- The generateObject precedent (§1.5) shows the builtin owns the schema's
  structural role. sqliteQuery's runtime signature returns
  `{pending, result: Row[], error?}`; the builtin already constructs that wrapper
  when it writes the result cell. So the natural, lower-risk split is:
  - **Transformer:** inject `rowSchema: <Row schema literal>` (a *property*, exactly
    like generate-object's `schema:`), where the literal is the bare Row object
    schema with `asCell` on `Cell<>` fields.
  - **Runtime builtin:** read `inputs.rowSchema` and build the per-query result
    schema `{ type:"object", properties:{ pending, error:true, requestHash, result:{
    type:"array", items: rowSchema } } }`, then write rows through
    `result.asSchema(thatSchema)` (the mechanism proven by the "EXPLICIT asSchema"
    probe and documented in `result-decode-and-row-types.md §0/§1.2`).

This keeps the transformer change a near-verbatim copy of the generate-object
branch (lowest blast radius) and puts the `result.items` knowledge where the
`{pending,result,error}` wrapper already lives.

Branch to add in `schema-injection.ts` (place it adjacent to the generate-object
branch, ~line 3785, inside the same `visit`), keyed on the export name:

```ts
if (callKind?.kind === "runtime-call" && callKind.exportName === "sqliteQuery") {
  const factory = transformation.factory;
  const typeArgs = node.typeArguments;
  const args = node.arguments;

  // Only the typed form is injectable. Untyped sqliteQuery(...) must compile and
  // lower to NO schema (runtime falls back to suffix/table detection).
  if (!typeArgs || typeArgs.length !== 1) {
    return ts.visitEachChild(node, visit, transformation);
  }
  // Idempotency dispatch guard: author already supplied rowSchema.
  if (args.length > 0 && ts.isObjectLiteralExpression(args[0]!) &&
      (args[0] as ts.ObjectLiteralExpression).properties.some(
        (p) => p.name && ts.isIdentifier(p.name) && p.name.text === "rowSchema")) {
    return ts.visitEachChild(node, visit, transformation);
  }

  const resolved = resolveInjectableSchemaType(typeArgs[0], checker, sourceFile, factory, typeRegistry, () => undefined);
  const schemaCall = createRegisteredSchemaCallFromResolvedType(context, resolved, checker, typeRegistry);
  if (schemaCall) {
    // Same three options-shape cases as generate-object (object literal / expr / none).
    const newOptions = /* { ...args[0], rowSchema: schemaCall } */;
    const updated = factory.createCallExpression(node.expression, node.typeArguments, [newOptions, ...args.slice(1)]);
    context.markSchemaInjected(updated);
    return ts.visitEachChild(updated, visit, transformation);
  }
}
```

Notes:
- The `inferType` callback is `() => undefined`: unlike generate-object (which can
  infer the schema from a contextual `{ object: T }` result type), sqliteQuery's
  `Row` only exists as an explicit `<Row>` type arg. No contextual inference path.
- Property name `rowSchema` (not `schema`) avoids colliding with any future author
  field and is self-documenting; the runtime reads the same name.

### 2.4 Signature / type change in `api/index.ts`

Two viable options; **prefer (a)**:

- **(a) No public type change.** Keep `SqliteQueryParams` author-facing as today;
  `rowSchema` is transformer-injected and read loosely at runtime (mirrors how
  generate-object's injected `schema` is appended to options the author didn't
  write, then read via the params schema). The `<Row>` generic already exists and
  types `result?: Row[]` for authors. This is the smallest, least-risky change.
- **(b)** Add an optional `rowSchema?: JSONSchema` to `SqliteQueryParams` so the
  emitted literal type-checks against the param type. Only needed if the
  `.input.tsx` fixture's *post-injection* shape must type-check — but expected
  (`.expected.jsx`) fixtures are **not** type-checked
  (`packages/ts-transformers/test/fixture-based.test.ts:159` comment), and the
  *input* fixture has no `rowSchema`, so (a) is sufficient. Defer (b) unless a
  real author wants to hand-supply `rowSchema`.

If we want the runtime to *validate/parse* `rowSchema` the way generateObject
validates `schema`, the sqliteQuery params schema used by the builtin
(`inputsCell.asSchema(...)`, analogous to `GenerateObjectParamsSchema`) would need
a `rowSchema` property — that is a **runtime builtin** concern (out of scope for
this transformer plan; it is the runtime half tracked by
`result-decode-and-row-types.md §2.5`). This plan's deliverable is the lowering;
the runtime read is the dependent Piece-A wiring.

### 2.5 How the injected schema composes with the runtime read (the proven path)

End-to-end, with the runtime half (separate PR, `result-decode-and-row-types.md`):

1. Transformer lowers `sqliteQuery<{ author_cf_link: Cell<User> }>({db,sql})` to
   `sqliteQuery<…>({ db, sql, rowSchema: { type:"object", properties:{ author_cf_link:{ …User…, asCell:["cell"] } }, required:[…] } })`.
2. Builtin reads `inputs.rowSchema`, builds `result.items = rowSchema`, writes rows
   through `result.asSchema({result:{items:rowSchema,…}}).set(...)` with link
   columns stored as **sigil-link objects** (not strings — see
   `result-decode-and-row-types.md §0`).
3. Because the consumer's own schema (the pattern's `resultSchema`, derived from
   the `sqliteQuery` return type **plus** the injected node-output schema) now
   carries `asCell` at `result.items.author_cf_link`, the read path's `asCell`
   branch (`schema.ts:978`) fires and mints a live Cell — exactly the "EXPLICIT
   asSchema" probe that passed in the prior session.

The transformer change (this plan) supplies step 1. Steps 2-3 are the runtime
wiring already designed in the sibling plan; this plan makes step 1 concrete and
test-gated.

---

## 3. Test-first plan (RED first, then GREEN order)

### RED-T1 — transformer fixture: `<Row>` lowers to `result`-ready asCell schema

Transformer tests are **fixture pairs** under
`packages/ts-transformers/test/fixtures/`, picked up by
`packages/ts-transformers/test/fixture-based.test.ts` (it scans for `*.input.*`
files, line 123-125, and compares emitted output to the sibling `*.expected.jsx`,
line 230-236, 297-318). Add a pair under `schema-injection/`:

- `sqlite-query-row-schema.input.tsx`:
  ```ts
  import { sqliteQuery, type Cell } from "commonfabric";
  interface User { name: string }
  export default function F(db: any) {
    const q = sqliteQuery<{ author: Cell<User>; n: number }>({
      db, sql: "SELECT author_cf_link AS author, count(*) AS n FROM m GROUP BY author_cf_link",
    });
    return { q };
  }
  ```
- `sqlite-query-row-schema.expected.jsx`: the call with an injected
  `rowSchema:` property whose literal has
  `properties.author = { type: "object", properties: { name: { type: "string" } }, required: ["name"], asCell: ["cell"] }`
  and `properties.n = { type: "number" }`, emitted as
  `… as const satisfies __cfHelpers.JSONSchema` (match the exact frame from
  `wish-and-generate-object-contextual.expected.jsx:69-83`).

**The single load-bearing assertion** (the diff that proves the whole feature):
the emitted `rowSchema.properties.author` carries `asCell: ["cell"]` **under the
alias `author`** — i.e. links are detected by Row typing, with no `_cf_link`
suffix present. This is RED today because there is no sqliteQuery injection branch
(§1.2: zero `runtime-call`/`exportName ===` matches in schema-injection.ts).

Add a second fixture `sqlite-query-no-type-arg.{input,expected}`: untyped
`sqliteQuery({db,sql})` must emit **no** `rowSchema` (proves §5 optionality / the
`!typeArgs` early return). The `.expected.jsx` equals the input call verbatim.

(Optionally also assert via the manual command in §5:
`deno task cf check sqlite-query-row-schema.input.tsx --show-transformed --no-run`.)

### RED-T2 — runner: `q.result[0].author_cf_link` is a live Cell

Extend `packages/runner/test/sqlite-cf-link-decode.test.ts` — **un-skip** the
pinned case at lines 211-218 and turn it into a real assertion. Because the
runner-side decode wiring (Piece A) is a dependent change, structure the test so
it fails RED on today's tree and goes GREEN only after both halves land:

```ts
it("surfaces q.result[i].<col>_cf_link as a live Cell automatically", async () => {
  const author = runtime.getCell<{ name: string }>(space, "author", undefined, tx);
  author.set({ name: "Ada" });
  const encoded = encodeCfLinkValue(author);

  // NOTE: the typed form below is what the transformer must lower. In a pure
  // runner test (no transformer), emulate the lowering by passing the injected
  // schema the transformer would produce — i.e. construct the pattern with the
  // rowSchema the builtin reads — OR run through the cf check pipeline. Prefer a
  // builder-free Driver-1 form mirroring sqlite-cf-link-roundtrip.test.ts.
  // ... INSERT encoded into author_cf_link; run sqliteQuery through the builtin ...

  const v = await waitUntil<{ q: QueryState }>(runtime, result,
    (s) => s.q?.pending === false && Array.isArray(s.q?.result) && s.q.result.length === 1);
  const col = v.q.result![0].author_cf_link;
  expect(isCell(col)).toBe(true);                 // RED today (it's a JSON string)
  expect((col as any).get()).toEqual({ name: "Ada" });
});
```

Caveat for whoever writes this: a pure runner test cannot exercise the
*transformer* (it builds via `createBuilder`, not `cf check`). Two honest options:
(i) keep RED-T1 as the proof that the transformer emits the schema, and in RED-T2
**feed the injected `rowSchema` into the builtin directly** (proving the runtime
half consumes it correctly); or (ii) add an integration test that runs a `.tsx`
through `deno task cf check … --no-run` and then executes. Recommend (i) for the
deterministic runner gate + RED-T1 for the lowering gate; they jointly cover the
seam. The existing two passing tests in this file (lines 100-206) stay as
regression pins for the untyped string/NULL behavior.

### GREEN — implementation order

1. **Registry** (§2.2) — add the three entries. (No behavior change yet; other
   builtins unaffected because there is still no injection branch for them.)
2. **Injection branch** (§2.3) — add the `exportName === "sqliteQuery"` branch.
   Make **RED-T1** (and the no-type-arg fixture) GREEN. Verify with
   `--show-transformed` (§5). This is the **entire deliverable of this plan**;
   stop here for the transformer PR.
3. **(Dependent runtime PR — `result-decode-and-row-types.md`)** read
   `inputs.rowSchema`, compose `result.items`, store sigil objects, write through
   `asSchema`. Make **RED-T2** GREEN. This is *out of scope* for the transformer
   change but is what flips the skipped runner test.

---

## 4. Blast radius / risk

- **Registry consumers.** `COMMONFABRIC_RUNTIME_EXPORT_REGISTRY` feeds derived
  sets at the bottom of the same file (`…_BY_NAME`, `…BUILDER_EXPORT_NAMES`,
  `…CALL_EXPORT_NAMES`, `…REACTIVE_ORIGIN_*`, lines 182-216) and `detectCallKind`
  (call-kind.ts). Adding `category:"call"` entries only **adds** `sqliteQuery`
  etc. to the call/reactive-origin sets — it does not change any existing entry,
  so it is **additive**. Risk: classifying `sqliteQuery` as `reactiveOrigin:true`
  changes how the broader pipeline treats the call (reactive-origin handling). It
  matches the other builtins (`fetchData`, `streamData` are `reactiveOrigin:true`),
  so this is consistent, but it is the one non-injection behavior change to watch.
- **Schema-injection visitor.** The new branch is gated on
  `callKind.kind === "runtime-call" && callKind.exportName === "sqliteQuery"`, a
  string nobody else matches, so it cannot fire for other builtins. It does not
  touch the shared helpers (`resolveInjectableSchemaType`,
  `createRegisteredSchemaCallFromResolvedType`) — it only *calls* them, exactly as
  generate-object does. No `schema-generator.ts` change is needed; `Cell<>` →
  `asCell` already works (§1.4).
- **Other builtins keep erasing `<T>`.** `streamData<T>`, `fetchData<T>`,
  `compileAndRun<T>` remain unaffected (they have no branch and we add none for
  them).
- **Public API.** With option (a) in §2.4, `api/index.ts` is untouched — no
  author-visible type change. Lowest possible surface.

Net: the transformer change is **additive and builtin-scoped**. The riskiest line
is the `reactiveOrigin:true` classification; mitigate by a fixture that exercises
`sqliteQuery` inside a pattern and confirms reactive-origin handling is unchanged
(or set `reactiveOrigin:false` if classification regressions appear — but the
existing builtins argue for `true`).

---

## 5. Open risks (and how to detect)

- **Interplay with the static `{pending,result,error}` wrapper.** The transformer
  injects the **bare Row** schema (§2.3); the *wrapper* lives in two places that
  must agree: the return type `OpaqueRef<{pending,result?:Row[],error?}>`
  (api/index.ts:2178) and the runtime builtin's composed result schema. If they
  disagree on where `Row` sits (`result.items`), the consumer's `resultSchema`
  may not carry `asCell` at the path the reader descends. **Detect:** RED-T2 reads
  exactly `q.result[0].author_cf_link`; if it returns a plain object/string, the
  wrapper composition is wrong. Also run `--show-transformed` on a
  `derive(q, q => q.result[0])` pattern and confirm the consumer arg schema has
  `result.items.<field>.asCell` (the prior session's verification method).
- **Optionality of the type arg.** Untyped `sqliteQuery({db,sql})` MUST still
  compile and lower to **no** `rowSchema` (the runtime then falls back to
  table/suffix detection, which per the verdict cannot produce live Cells — a
  documented limitation, not a regression). The `!typeArgs || length !== 1` early
  return (§2.3) handles this; the `sqlite-query-no-type-arg` fixture pins it.
- **Idempotency / double injection.** If `cf check` runs the transformer twice or
  an author hand-writes `rowSchema`, the branch must not double-inject. Covered by
  `context.markSchemaInjected` + the `isSchemaInjected` top guard
  (schema-injection.ts:2891-2896) and the per-branch `rowSchema`-present check.
  There is an existing fixture pattern for this
  (`double-inject-already-has-schema.{input,expected}` in `schema-injection/`);
  mirror it if a regression appears.
- **Alias correctness.** The whole point is that `author_cf_link AS author` yields
  `properties.author.asCell`. This relies on the schema generator keying off the
  **Row field name**, confirmed by `cell-type.test.ts:7-19`. If a future schema
  generator change drops `asCell` on nested object types, the alias detection
  breaks silently — RED-T1's `properties.author.asCell` assertion guards it.
- **`--show-transformed` verification command** (per AGENTS.md):
  ```bash
  deno task cf check docs/.../sqlite-query-row-schema.input.tsx --show-transformed --no-run
  ```
  Use it to eyeball the emitted `rowSchema` before trusting the fixture diff.

---

## 6. Authoring doc status (AGENTS.md "worth adding a doc")

**The doc already exists:**
`packages/ts-transformers/docs/adding-type-arg-schema-lowering.md`. It documents
exactly this recipe: registry entry → recognize the call in the visitor → build
+ inject via `createSchemaCallWithRegistryTransfer` /
`createRegisteredSchemaCallFromResolvedType` → read at runtime, with
`generateObject`/`lift`/`toSchema` cited as reference implementations and a
"Tests" section pointing at the fixture-pair convention. **Recommendation:** when
implementing, add `sqliteQuery` to that doc's "Reference implementations" list as
the canonical *nested-result* (`result.items`) example, since it is the first
builtin to inject a bare schema that the **runtime** (not the transformer) wraps.
No new doc file is needed.
