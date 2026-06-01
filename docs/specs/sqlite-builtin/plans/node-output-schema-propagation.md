# Plan — runtime-determined node output schema (unblocks `_cf_link` decode + `sqliteQuery<Row>`)

> ## VERDICT (2026-06-01, after implementing + testing Option A)
>
> **Option A does NOT work, and no runner-only change can.** Implemented the
> recommended Option A end to end — built the per-query `asCell` result schema,
> generalized `resultForRawBuiltinOutputBinding` (allow-set incl. `sqliteQuery`,
> sourcing the schema from the result cell), tried BOTH a regular link
> (`getAsLink`) and a **write-redirect** link (`getAsWriteRedirectLink`), and
> decoded stored strings to sigil objects. The RED test
> (`packages/runner/test/sqlite-cf-link-decode.test.ts`) stayed RED across every
> realistic consumer read path: `.key().get()` leaf, full-tree `result.get()`
> proxy, and `.get()` at the `q` boundary. The column read back as the resolved
> target VALUE (`{name:"Ada"}`), never a `Cell`.
>
> **Why (the corrected root cause).** §1.4's premise — that `combineSchema`
> would carry the link's `asCell` to the reader — is not how reads actually
> resolve a *deep* path. Runtime navigation derives a child's schema **top-down
> from the CONSUMER's own schema**; an untyped `sqliteQuery` lowers to an empty
> (`{}`) consumer schema (verified: `p.resultSchema === {}`), so descending
> `q → result → [i] → author_cf_link` never carries `asCell`. A deeper link's
> schema is only honored when the effective schema **already** `hasAsCell`
> (`schema.ts:978` gate; `hasAsCell` is top-level only, `traverse.ts:3245`) — a
> chicken-and-egg the node-output link cannot break. Proof it's a CONSUMER-schema
> problem, not a storage problem: applying `.asSchema({… author_cf_link:
> {asCell}})` **at the reading cell** rehydrates the stored sigil object to a
> live Cell (the "EXPLICIT" probe passed).
>
> **Consequence.** `_cf_link` auto-decode and typed `sqliteQuery<Row>` are the
> **same** change and it lives in the **ts-transformer**, not the runner: the
> `Row` type argument must lower to an `asCell`-bearing result schema injected at
> the *call site* (Piece B, [result-decode-and-row-types.md §2](./result-decode-and-row-types.md)).
> For an untyped query the call site cannot know which columns are links, so
> untyped auto-decode is impossible by construction. Piece B is therefore a
> **prerequisite** for decode, not an independent nicety. Options A/C/D below are
> superseded; Option B's instinct (consumer-side typing) was directionally right
> but must come from the transformer, not a loosened return type.
>
> All speculative runner/builtin edits were reverted; the branch is green. The
> RED test now documents current behavior (raw sigil string + `decodeCfLinkValue`
> + NULL→null) and carries a `skip` pinning the blocked target.

---


Test-first design for ONE change: let a builtin declare that **its output schema
is determined at runtime** so a per-invocation, `asCell`-bearing schema attached
to the result cell survives a downstream read. This is the single root cause that
blocks both deferred M3 pieces (see
[result-decode-and-row-types.md §7](./result-decode-and-row-types.md)):

- **#1 `_cf_link` result decode** — `q.result[i].author_cf_link` should read back
  as a live `Cell` when the value is a stored sigil link
  ([decodeCfLinkValue / parseCfLinkToSigil, cf-link.ts:61,91](../../../../packages/runner/src/builtins/sqlite/cf-link.ts)).
- **#2 typed `sqliteQuery<Row>`** — a per-query `Row` schema should drive runtime
  decode/coercion of result rows.

Both reduce to: a builtin/node's **static** output schema (the builder-call
return type) takes precedence over any **dynamic** schema the running builtin
attaches to its result cell, so the `asCell` markers never reach the reader.

---

## 1. Root cause (file:line, with quoted code)

### 1.1 A Cell's schema lives on its *link*, not in stored data

`asSchema` returns a transient sibling cell whose schema is on the **link only**:

[cell.ts:1225-1242 `asSchema`](../../../../packages/runner/src/cell.ts)
```ts
asSchema(schema?: JSONSchema): Cell<any> {
  const siblingLink: NormalizedLink = { ...this._link, schema: schema };
  return new CellImpl(this.runtime, this.tx, siblingLink, false, ...);
}
```

A plain `result.asSchema(S).set(rows)` therefore stores **only** `rows` at the
doc. `S` is not persisted into the doc; it rides on the writer's transient link
and is gone after the write. A downstream reader uses **its own** link schema, so
it never sees `S` unless `S` is written into a *link the reader follows*.

### 1.2 The result cell's redirect link is stamped with NO schema (the shadow)

The query result cell is allocated schema-less and its result write-redirect is
captured **at allocation**, before any dynamic schema exists:

[sqlite-builtins.ts:44-62 `makeResultCell`](../../../../packages/runner/src/builtins/sqlite-builtins.ts)
```ts
const base = runtime.getCell<T>(parentCell.space, { [label]: { result: cause } }, undefined, tx); // schema = undefined
const cell = createCell(runtime, base.getAsNormalizedFullLink(), tx);
setResultCell(cell, parentCell);   // <-- captures redirect link now (no schema)
```

[result-utils.ts:21-26 `setResultCell`](../../../../packages/runner/src/result-utils.ts)
```ts
export function setResultCell(cell: Cell<unknown>, resultCell: Cell<unknown>) {
  cell.setMetaRaw("result", resultCell.getAsWriteRedirectLink({ includeSchema: true }));
}
```
`getAsWriteRedirectLink({ includeSchema: true })` serializes `this.link` *and its
schema* ([cell.ts:1413-1424](../../../../packages/runner/src/cell.ts)) — but the
schema is `undefined` here, so the redirect the reader follows carries none.

### 1.3 The reader's schema is the STATIC builder return type, injected at the *consumer* call site

The transformer does **not** inject a schema at the `sqliteQuery(...)` call (it is
absent from the registry —
[commonfabric-runtime-registry.ts](../../../../packages/ts-transformers/src/core/commonfabric-runtime-registry.ts);
`grep sqlite` returns only `generateObject`/`fetchData`/`streamData`). Instead the
static return type `OpaqueRef<{ pending; result?: Row[]; error? }>`
([api/index.ts:2176-2178](../../../../packages/api/index.ts)) is lowered onto
**every consumer** of `q`. Verified by `deno task cf check … --show-transformed`
on a `derive(q, (q) => q.result)` pattern — the emitted argument schema for `q`
is:
```jsonc
result: { anyOf: [ { type: "undefined" },
  { type: "array",
    items: { type: "object", properties: {}, additionalProperties: { type: "unknown" } } } ] }
```
i.e. `result.items` has **no `asCell`**. This static schema is what the reader
(`lift`/`derive`, or the pattern's own `resultSchema`) carries on its link.

### 1.4 Where static beats dynamic on read

On read, the reader's (static) schema is combined with whatever schema is on the
**resolved link** it follows:

[schema.ts:924-929 `validateAndTransform`](../../../../packages/runner/src/schema.ts)
```ts
const resolvedLinkSchema = resolveSchema(resolvedLink.schema);
const effectiveSchema = resolvedSchema !== undefined
  ? resolvedLinkSchema !== undefined
    ? combineSchema(resolvedSchema, resolvedLinkSchema)
    : resolvedSchema
  : resolvedLinkSchema;
```
The `asCell` branch that would mint a live Cell is gated on the **combined**
schema carrying `asCell`:

[schema.ts:978 `validateAndTransform`](../../../../packages/runner/src/schema.ts)
```ts
if (SchemaObjectTraverser.hasAsCell(effectiveSchema)) { /* read link object -> live Cell */ }
```

**The decisive fact:** `resolvedLink.schema` here is the schema on the link the
reader follows = the result cell's redirect link from §1.2 = **none**. So
`effectiveSchema = resolvedSchema` = the static, asCell-free schema from §1.3, and
the `asCell` branch never fires. The dynamic schema set by the builtin at write
time was on a *different* (transient) link and is invisible here.

(Note: `combineSchema` would actually *preserve* `asCell` if `resolvedLinkSchema`
carried it — the type-mismatch branch
[traverse.ts:1844-1853](../../../../packages/runner/src/traverse.ts) does
`mergeSchemaFlags(linkSchema, parentSchema)` and
[mergeSchemaFlags:1663-1667](../../../../packages/runner/src/traverse.ts) keeps
`flagSchema.asCell`. The problem is therefore **not** that combine drops `asCell`
— it is that the dynamic schema never reaches `resolvedLink.schema` at all,
because nothing writes it onto a link the reader follows.)

### 1.5 The sanctioned escape hatch already exists — but is hard-coded to `generateObject`

The runtime already has a seam that takes a builtin's runtime result cell, stamps
a schema onto it, and emits a **link with that schema** into the node output
binding (so the reader follows a link that carries the dynamic schema):

[runner.ts:327-343 `resultForRawBuiltinOutputBinding`](../../../../packages/runner/src/runner.ts)
```ts
const resultForRawBuiltinOutputBinding = (result, outputBindingSchema, builtinIdentity) => {
  if (!isCell(result) || outputBindingSchema === undefined ||
      builtinIdentity?.kind !== "builtin" ||
      builtinIdentity.builtinId !== "generateObject") {           // <-- hard-coded
    return result;
  }
  return result.asSchema(outputBindingSchema).getAsLink({ includeSchema: true });
};
```
called from the builtin's `sendResult` in
[runner.ts:3488-3516 `instantiateRawNode`](../../../../packages/runner/src/runner.ts).
`builtinId` is just the module ref/debugName
([implementation-identity.ts:34-37](../../../../packages/runner/src/cfc/implementation-identity.ts)),
so for our builtins it is the string `"sqliteQuery"`.

**Caveat that makes this not quite a drop-in:** the schema it stamps comes from
`outputBindingSchema = schemaForRawBuiltinRootOutputBinding(...)`
([runner.ts:308-325](../../../../packages/runner/src/runner.ts)), which reads the
schema *off the static output binding* (`bindingLink.schema ?? link.schema`). For
`sqliteQuery` that is `undefined` (§1.3), so even after adding `"sqliteQuery"` to
the allow-set the call short-circuits on `outputBindingSchema === undefined`. The
dynamic, per-query schema we want lives on the **result cell**, not on the static
binding — so the fix must source the schema from the result cell, not the binding.

---

## 2. Options

### Option A — generalize the result-cell→output-binding schema seam (recommended)

**Mechanism.** Let a builtin's result cell *carry* its dynamic schema (set via
`asSchema` / a schema param on `makeResultCell`), and have
`resultForRawBuiltinOutputBinding` emit `result.getAsLink({ includeSchema: true })`
**using the schema already on `result`** (not the static binding schema) for
builtins that opt in. Concretely:

- Replace the hard-coded `builtinId !== "generateObject"` gate with an opt-in set
  that includes `"sqliteQuery"` (and `"generateObject"`), OR key off a new
  `module` flag (Option C).
- When the result cell already has a schema (`result.schema !== undefined`), emit
  `result.getAsLink({ includeSchema: true })` so the node output binding link
  carries the dynamic schema; the reader then follows a link whose
  `resolvedLink.schema` has the `asCell` markers, and §1.4's `combineSchema`
  *preserves* them (verified leaf behavior, §1.4 note).
- In [sqlite-builtins.ts `sqliteQuery`](../../../../packages/runner/src/builtins/sqlite-builtins.ts):
  build the per-query result schema (link cols → `asCell`, via the helpers in
  [result-decode-and-row-types.md §1.2](./result-decode-and-row-types.md)) and
  write through it: `result.asSchema(resultSchema).withTx(wtx).set({...})`, having
  also stamped that schema on the result cell so `sendResult` sees it.

**Files touched.** `packages/runner/src/runner.ts`
(`resultForRawBuiltinOutputBinding`, ~3 lines: allow-set + source-from-result-cell
branch); `packages/runner/src/builtins/sqlite-builtins.ts` (build + apply dynamic
schema); `packages/runner/src/builtins/sqlite/cf-link.ts` (reuse existing
`parseCfLinkToSigil`). Possibly `result-utils.ts` if we re-stamp the redirect with
schema (not required if we go through the output binding).

**Blast radius / risk.** Low–medium. The seam is builtin-scoped (only runs for the
opted-in `builtinId`s in `sendResult`); `generateObject` already exercises the
exact code path, so the mechanism is proven. Main risk is making the gate too
broad — keep it an explicit allow-set so other builtins are unaffected.

**Unblocks both?** Yes. #1 (decode) is the direct consumer. #2 (`<Row>`) lands the
same way: the transformer-injected `rowSchema` (a separate change,
[result-decode-and-row-types.md §2](./result-decode-and-row-types.md)) becomes the
`asSchema` schema the result cell carries; the same seam propagates it.

### Option B — declare the builder return type as opaque so no static schema is ever injected

**Mechanism.** Make `SqliteQueryFunction`'s return an opaque/loose type
(e.g. `OpaqueRef<any>` or a type whose lowering yields `true`/`{}`), so the
transformer injects **no constraining schema** on consumers of `q`. Then
`resolvedSchema` at the reader is absent/permissive and the result cell's own
schema governs. **But** per §1.1/§1.2 the dynamic schema still must be written onto
a link the reader follows — an opaque return type alone removes the *shadow* but
does **not** by itself deliver the `asCell` markers, because the result-cell
redirect is stamped schema-less (§1.2). So Option B must be combined with stamping
the dynamic schema on the result cell's redirect (re-call `setResultCell` after
`asSchema`, or pass schema into `makeResultCell`).

**Files touched.** `packages/api/index.ts` (`SqliteQueryFunction` return type);
`packages/runner/src/builtins/sqlite-builtins.ts` (stamp schema on result cell);
verification via `--show-transformed` that consumers no longer get a constraining
`result.items`.

**Blast radius / risk.** Medium. Loosening the public return type degrades author
ergonomics/typing for **all** `sqliteQuery` users (loses `result?: Row[]` typing),
and is a visible API/type change. It also does not, alone, fix decode.

**Unblocks both?** Partially. Removes the shadow for #1 but still needs a schema
write onto the followed link; actively *harmful* to #2 (it removes the very
typing #2 wants). Not recommended.

### Option C — explicit `module` flag: `runtimeDeterminedResultSchema`

**Mechanism.** Add an optional flag to the `Module`/`createNodeFactory` spec
(e.g. `runtimeResultSchemaFromCell: true`) that `instantiateRawNode` checks in
`sendResult`: when set and `isCell(result)` and `result.schema !== undefined`,
emit `result.getAsLink({ includeSchema: true })`. `sqliteQuery`'s factory sets the
flag ([built-in.ts:179-182](../../../../packages/runner/src/builtins/../builder/built-in.ts)).

**Files touched.** `packages/runner/src/builder/types.ts` (Module field),
`packages/runner/src/builder/built-in.ts` (set flag on `sqliteQuery`),
`packages/runner/src/runner.ts` (read flag instead of the hard-coded id),
`packages/runner/src/builtins/sqlite-builtins.ts` (apply schema). Optionally
migrate `generateObject` to the flag.

**Blast radius / risk.** Medium. Cleanest long-term (no string allow-list), but
touches the module type and the factory plumbing; slightly larger surface than A.

**Unblocks both?** Yes — identical propagation to A; just a different opt-in
mechanism.

### Option D — propagate the dynamic schema through the result-cell redirect metadata

**Mechanism.** After computing the per-query schema, re-stamp the result cell's
redirect link with it: `setResultCell(cell, parentCell)` re-run after
`cell = cell.asSchema(resultSchema)`, so `getAsWriteRedirectLink({includeSchema:true})`
captures the dynamic schema (§1.2). The reader follows the redirect → gets the
schema. No runner.ts change.

**Files touched.** `packages/runner/src/builtins/sqlite-builtins.ts` only
(+ `result-utils.ts` if a schema param is added).

**Blast radius / risk.** Low *if* it works, but **uncertain**: it depends on
whether the reader resolves through the result-cell redirect (`meta "result"`) or
through the node **output binding** link. §1.4 shows reads combine with
`resolvedLink.schema` after `resolveLink(..., "writeRedirect")`; whether that
chain ends on the redirect we re-stamped or on the binding link must be confirmed
by the RED test below. If the binding link is the terminal schema source, D is
insufficient and A/C is required.

**Unblocks both?** Same as A/C *if* the redirect is the followed link. Treat D as
the cheapest first probe; fall back to A if the probe shows the binding wins.

---

## 3. Recommendation

**Option A** (generalize `resultForRawBuiltinOutputBinding` to source the schema
from the result cell, gated by an explicit builtin allow-set incl. `"sqliteQuery"`),
optionally hardened later into **Option C** (a module flag) if we want to drop the
string list.

Rationale:
- It reuses the **exact** code path `generateObject` already relies on
  ([runner.ts:327-343, 3488-3516](../../../../packages/runner/src/runner.ts)) —
  proven in production, minimal new surface.
- It sources the schema from the **result cell** (where the per-query, per-`Row`
  schema actually lives), fixing the `outputBindingSchema === undefined`
  short-circuit that makes the literal `generateObject` hatch unusable for us
  (§1.5 caveat).
- It unblocks **both** #1 and #2 with one mechanism: #1 supplies the schema from
  link-column detection; #2 supplies it from the transformer-injected `rowSchema`.
- It does **not** change the public `SqliteQueryFunction` type (unlike B), so
  author typing is preserved.

Start with the **Option D probe** as the very first RED test (it is one file and
will tell us empirically whether re-stamping the redirect alone suffices); if D's
assertion still fails, implement A.

---

## 4. Test-first plan

All runner tests use a **unique space per test**
(`(await Identity.fromPassphrase(\`x-${crypto.randomUUID()}\`)).did()`) — the
cell-db temp file is keyed by `(space, dbId)` and leaks rows across runs otherwise
(see [reactivity.md](./reactivity.md) and
[sqlite-builtins.test.ts:121-122](../../../../packages/runner/test/sqlite-builtins.test.ts)).

### RED-0 (diagnostic probe, Option D) — does re-stamping the redirect suffice?

`packages/runner/test/sqlite-node-output-schema.test.ts`. Allocate a result cell
exactly as `makeResultCell` does, then `setResultCell(cell.asSchema(S), parent)`
with `S` marking `result.items.author_cf_link` `asCell`; write a parsed sigil
object; read **through a second cell that has only the static (asCell-free)
schema** on its link (mimicking the consumer in §1.3) and assert:
```ts
expect(isCell(reader.get().result[0].author_cf_link)).toBe(true); // proves redirect schema reaches reader
```
If this PASSES → Option D is enough (no runner.ts change). If it FAILS → the
binding link wins; proceed to RED-1 + Option A. (This test stays in the suite as a
regression either way.)

### RED-1 (the real target, full builtin path) — `q.result[0].author_cf_link` is a live Cell

`packages/runner/test/sqlite-cf-link-decode.test.ts`, Driver 1 (builder-free,
deterministic) mirroring
[sqlite-cf-link-roundtrip.test.ts](../../../../packages/runner/test/sqlite-cf-link-roundtrip.test.ts):
1. write an author cell; `INSERT` its `encodeCfLinkValue(author)` into a
   `*_cf_link` column via `provider.sqliteExecute!`;
2. run `sqliteQuery` **through the builtin** so `sendResult` →
   `resultForRawBuiltinOutputBinding` runs;
3. read the node output exactly as a consumer would (through the static return-type
   schema — i.e. read `q.result` via a cell carrying the asCell-free static schema
   from §1.3, the shape `--show-transformed` emits).

Assertions (FAIL today):
```ts
const col = q.result[0].author_cf_link;
expect(isCell(col)).toBe(true);              // today: a JSON string / plain object
expect(col.get()).toEqual({ name: "Ada" });  // live target value
expect(qNull.result[0].author_cf_link).toBeNull(); // NULL -> null
```
Today this fails: the redirect carries no schema (§1.2) so `effectiveSchema` lacks
`asCell` (§1.4) and the value is read as a plain string/object, not a Cell.

### RED-2 (re-query keeps it live)

After a `reactOn: db` rev-bump re-runs the query
([sqlite-builtins.ts:301-322](../../../../packages/runner/src/builtins/sqlite-builtins.ts)),
re-assert `isCell(q.result[0].author_cf_link)`. Guards against propagating the
schema only on the first `sendResult`.

### RED-3 (#2 typed `sqliteQuery<Row>` aliased column)

Depends on the separate transformer change
([result-decode-and-row-types.md §2](./result-decode-and-row-types.md)). Runner
test: `sqliteQuery<{ author: Cell<User>; n: number }>` over
`... author_cf_link AS author ...`; assert `q.result[0].author` is a live Cell —
proving the **same** node-output-schema seam carries the transformer-injected
`rowSchema` (aliases drop the suffix; only `Row` detects them).

### GREEN — implementation order

1. **Run RED-0.** If it passes, implement **Option D** in
   `sqlite-builtins.ts`/`result-utils.ts` and make RED-1 pass; skip steps 2-3.
2. **If RED-0 fails:** implement **Option A** in
   [runner.ts `resultForRawBuiltinOutputBinding`](../../../../packages/runner/src/runner.ts):
   - widen the gate to an explicit allow-set incl. `"sqliteQuery"`;
   - source the schema from the result cell: when `isCell(result)` and
     `result.schema !== undefined`, return
     `result.getAsLink({ includeSchema: true })`.
3. In [sqlite-builtins.ts `sqliteQuery`](../../../../packages/runner/src/builtins/sqlite-builtins.ts):
   - compute link columns + build the per-query result schema (reuse
     `parseCfLinkToSigil` + the helpers in
     [result-decode-and-row-types.md §1.2](./result-decode-and-row-types.md));
   - stamp it on the result cell and write rows through it:
     `result = result.asSchema(resultSchema); result.withTx(wtx).set({...decodedRows})`.
   Make RED-1, RED-2 pass.
4. (Separate PR) the transformer `rowSchema` injection
   ([result-decode-and-row-types.md §2](./result-decode-and-row-types.md)); feed
   `inputs.rowSchema` into the schema builder; make RED-3 pass.

---

## 5. Open risks (and how to detect)

- **Reader doesn't follow the link we stamp.** The whole fix hinges on the reader
  resolving through a link whose `resolvedLink.schema` carries `asCell` (§1.4).
  RED-0/RED-1 detect this directly — if the value reads as a plain object despite
  a stamped schema, the reader is terminating on a different link (binding vs
  redirect). Mitigation: Option A stamps the **output binding** link (the one
  `sendValueToBinding` writes, [pattern-binding.ts:90-166](../../../../packages/runner/src/pattern-binding.ts)),
  which is what the parent's `internal` alias resolves to.
- **`combineSchema` could still drop `asCell` for a specific static shape.** The
  static `result.items` is `{type:"object", properties:{}, additionalProperties:{type:"unknown"}}`.
  For a key absent from parent.properties the merge is
  `combineSchema(parentAdditionalProperties={type:"unknown"}, linkValue={asCell,...})`
  → type-mismatch branch → `mergeSchemaFlags(linkValue, parent)` keeps `asCell`
  ([traverse.ts:1782-1814, 1844-1853, 1663-1667](../../../../packages/runner/src/traverse.ts)).
  But if a future static schema gives `result.items.author_cf_link` an explicit
  asCell-free entry, the *both-objects per-key* branch
  ([traverse.ts:1790](../../../../packages/runner/src/traverse.ts)) recurses
  `combineSchema(parent.author_cf_link, link.author_cf_link)` with parent first and
  the both-objects spread `...linkSchema, ...parentSchema`
  ([traverse.ts:1817-1824](../../../../packages/runner/src/traverse.ts)) would let
  parent override `asCell`. Detect with a RED test variant where the consumer's
  static schema explicitly types the link column; if it fails, the seam must stamp
  the binding link such that the **link** schema is the parent in the merge (it is,
  since `resolveLink` puts the followed link's schema as `resolvedLinkSchema` =
  second arg = `linkSchema`).
- **Transformer re-injection / future registry entry.** If `sqliteQuery` is later
  added to the transformer registry with return-type lowering, a *new* static
  schema could be injected at the call site and re-shadow. Detect with a
  `--show-transformed` fixture assertion (or the RED-1 runner test, which would
  regress). Keep `sqliteQuery` out of return-type lowering, or ensure any injected
  schema marks link columns `asCell` (i.e. fold #2 into the injected schema).
- **Over-broad allow-set (Option A).** Adding more `builtinId`s to the gate would
  change behavior for unrelated builtins. Mitigation: keep the set explicit and
  unit-test that a non-listed builtin's result link carries no injected schema;
  prefer the Option C flag if the list grows.
- **CFC / scope.** Absolute links from `encodeCfLinkValue` already include `scope`
  ([cf-link.ts:49-52](../../../../packages/runner/src/builtins/sqlite/cf-link.ts));
  `getCellFromLink` honors it. Don't promote asCell entry scope to schema scope
  (per the runtime CLAUDE notes / CT-1623). Detect with a cross-space decode RED
  test asserting `.get()` resolves the foreign-space target.
