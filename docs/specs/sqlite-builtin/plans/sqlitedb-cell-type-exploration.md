# Exploration — `SqliteDb` as a first-class Cell type (`db.query` / `db.exec`)

> **Status:** design exploration only. No code changed. Every file:line below was
> opened and read in the `feat/sqlite-builtin-impl` worktree
> (`/Users/berni/src/labs.sqlite-builtin`).

## The question

Today SQLite is three standalone builder functions:
`sqliteDatabase({tables}) → OpaqueRef<SqliteDatabase>`,
`sqliteQuery<Row>({db, sql, params, reactOn}) → OpaqueRef<{pending,result,error}>`,
`sqliteExecute({db, sql, params}) → OpaqueRef<{pending,result,error}>`
(`packages/api/index.ts:2165-2191`; `packages/runner/src/builder/built-in.ts`;
`packages/runner/src/builtins/sqlite-builtins.ts`).

Alternative: make the DB handle a **Cell** (or a Cell-like branded value) that
surfaces methods:

- `db.query<Row>(sql, {reactOn?})` behaves **like `.map()`/`.filter()`** — builds
  a reactive node whose output is a cell of rows.
- `db.exec(sql, params)` behaves **like `.set()`** — an imperative write recorded
  into the current transaction, atomic with surrounding cell writes, no result.

---

## 1. Mechanisms today (ground truth)

### 1.1 `.map`/`.filter` are cell-method-as-node-constructors — precedent EXISTS

The runtime `CellImpl.map()` builds a reactive graph node by lazily creating a
`createNodeFactory` and invoking it with the receiver as `list`
(`packages/runner/src/cell.ts:1688-1714`):

```ts
map<S>(fn): OpaqueRef<S[]> {
  if (!mapFactory) {
    mapFactory = createNodeFactory({ type: "ref", implementation: "map" });
  }
  const op = pattern(({ element, index, array }) => fn(element, index, array));
  const result = mapFactory({ list: this as unknown as OpaqueRef<T>, op });
  const schema = flowPrecisionSchemaForBuiltin("map", op.resultSchema);
  if (schema !== undefined) result.setSchema(schema);
  return result;
}
```

`.filter` is identical with `implementation: "filter"`
(`cell.ts:1800-1825`); `.flatMap` likewise (`cell.ts:1860-1885`);
`.mapWithPattern`/`.filterWithPattern` pass a pre-built `op` + `params`
(`cell.ts:1720-1743`, `1831-1853`). `.reduce`/`.findIndex` instead use `lift`
(`cell.ts:1750-1793`) — a different mechanism, not a per-element builtin node.

`createNodeFactory` is the node constructor (`packages/runner/src/builder/module.ts:87-126`):

```ts
const factory = Object.assign((inputs) => {
  const outputs = opaqueRef<R>(undefined, module.resultSchema);
  const node: NodeRef = { module, inputs, outputs, frame: getTopFrame() };
  connectInputAndOutputs(node);
  (outputs as OpaqueCell<R>).connect(node);
  return outputs;
}, module);
```

So calling the factory mints an `OpaqueRef` output, builds a `NodeRef`
referencing the named `implementation`, and wires it into the current build
frame's graph. **The op runs later in the scheduler's own tx, not the build-time
tx** — it is a reactive node.

This is the load-bearing precedent: **a cell method already constructs a reactive
graph node the exact same way a top-level builder function does.** `sqliteQuery`
the free function is itself just `createNodeFactory({type:"ref",
implementation:"sqliteQuery"})` (`packages/runner/src/builder/built-in.ts`, same
shape as map/filter). So `db.query` would be `mapFactory`-style sugar over the
same factory — the only difference is the receiver (`db`) is passed as an input
(`{db: this, sql, ...}`) instead of `{list: this, op}`. **There is nothing novel
required at the node-construction layer.**

### 1.2 `.set()` is an imperative tx write — precedent for `db.exec`

`CellImpl.set()` (`packages/runner/src/cell.ts:842-920`) requires an ambient tx
and writes through it:

```ts
if (!this.tx) {
  throw new Error("Transaction required for .set() - mutations only work in handlers ...");
}
...
diffAndUpdate(this.runtime, this.tx,
  resolveLink(this.runtime, this.tx, this.link, "writeRedirect"),
  transformedValue, this._frame?.cause);
```

The cell carries everything an imperative write needs: `tx` is a public readonly
field (`cell.ts:489`) and `space` is a getter (`cell.ts:677`). `.set()` reads
`this.tx` directly (`cell.ts:879,902`).

### 1.3 The commit-fold seam for an imperative SQLite write

Stage 1 of `sqlite-execute-commit-fold.md` is **built and green** (commit
d10d37952; STATUS block at `docs/specs/sqlite-builtin/plans/sqlite-execute-commit-fold.md:3-44`):

- `IStorageTransaction.recordSqliteWrite?(space, op)` records a SQLite write that
  commits atomically with cell ops (`packages/runner/src/storage/interface.ts:553-561`).
- `NativeStorageCommit.sqliteOps?` carries the folded ops, appended last, kept out
  of the doc-pending/touched/notify machinery
  (`interface.ts:1187-1196`).
- `V2Transaction.recordSqliteWrite` asserts writable, **claims `space` as a write
  target** (single-space write isolation), and stashes onto `#sqliteOps`
  (`packages/runner/src/storage/v2-transaction.ts:832-850`); `getNativeCommit`
  emits them (`v2-transaction.ts:852-860`+).
- The wire `Operation` union includes `SqliteOperation {op:"sqlite", db, sql,
  params?}` (`packages/memory/v2.ts:95-106`) — NOT an entity revision.
- Both tx wrappers delegate `recordSqliteWrite`
  (`packages/runner/src/storage/extended-storage-transaction.ts:348-354,834-840`).

The current `sqliteExecute` does **not** use this seam yet — it is a reactive node
that writes via a separate post-commit RPC
(`packages/runner/src/builtins/sqlite-builtins.ts:301-333`:
`enqueuePostCommitEffect` → `provider.sqliteExecute!` inside a fresh
`editWithRetry`), then bumps `db.rev` for `reactOn` reactivity
(`sqlite-builtins.ts:315-321`). Stage 2 (rewrite execute to fold) is **not
started** (`sqlite-execute-commit-fold.md:21-44`).

**Crucially, Stage 2's own chosen design is already a `.set()`-shaped imperative
call.** Its signature is `sqliteExecute(db, sql, params?) => void`
(`sqlite-execute-commit-fold.md:283-296`), its mechanism is "recover `db`'s Cell,
read `tx = dbCell.tx`, call `tx.recordSqliteWrite(...)` on the handler's own tx"
(`sqlite-execute-commit-fold.md:261-266, 298-305`), and it verified that a
handler's `db` argument is a tx-bound proxy whose `toCell` mints a Cell carrying
the handler's tx (`sqlite-execute-commit-fold.md:244-266`, citing
`query-result-proxy.ts:227-229` + `cell.ts:346`). **`db.exec` as a cell method is
the same design with the recovery step removed** — the method's `this` IS the
tx-bound cell.

---

## 2. The `SqliteDb`-as-Cell design (concrete)

### 2.1 What `SqliteDb` would be

There are two viable framings. The codebase supports both; they differ in cost.

**Framing A — a new `asCell` kind `"sqlitedb"` (true Cell subtype).**
`CellKind` is a closed union (`packages/api/index.ts:181-187`):

```ts
export type CellKind = "cell" | "opaque" | "stream" | "comparable" | "readonly" | "writeonly";
```

`AsCellEntry` (`api/index.ts:193-198`) tags a schema slot with a kind. At runtime
`CellImpl.key()` reads the child schema's `asCell` entry and sets `_kind`
(`packages/runner/src/cell.ts:1194-1206`) via
`ContextualFlowControl.getAsCellKind` (`packages/runner/src/cfc.ts:518-520`). So a
schema like `{ asCell: ["sqlitedb"], ... }` would already flow a `"sqlitedb"` kind
down to the navigated cell — IF the union admitted it and the Cell exposed
methods for it. **But `_kind` only changes runtime behavior for `"stream"`** —
grep shows the only meaningful branches are `isStream()` (`cell.ts:707-708`) and
the query-result `value` shape (`cell.ts:1602`); every other site merely
propagates `_kind` (`cell.ts:1239,1275,1289`). So the kind is a *type/dispatch
tag*, not a behavioral switch. Methods are NOT attached per-kind on `CellImpl`
today — `map`/`filter`/`set` are plain methods on the single `CellImpl` class.

`Stream<T>` is the precedent for a typed cell variant with distinct methods, but
it does so at the **type layer**, not by subclassing `CellImpl`:
`Stream<T>` is an interface composing `BrandedCell<T,"stream">` + capability
interfaces + `IStreamable<T>` (`.send()`) (`packages/api/index.ts:1094-1101`), and
`Stream` is declared as a `CellTypeConstructor` (`api/index.ts:1101`). The runtime
honors it by special-casing `_kind === "stream"` inside the one `CellImpl`.

**Framing B — a branded value with methods (mirror `SqliteDatabase` today).**
`SqliteDatabase` is already an opaque brand (`api/index.ts:2147-2153`) carrying a
`toCell` back-pointer (per the doc comment at `:2150`). The cleanest minimal form
is: keep the handle a branded value, but give its TYPE methods `query`/`exec`,
and implement those methods to (1) recover the backing Cell via the same
`asCellOrUndefined`/`toCell` path already used by the cf-link codec
(`packages/runner/src/builtins/sqlite/cf-link.ts:25-35`), then (2) call the
existing `createNodeFactory` (for `query`) or `cell.tx.recordSqliteWrite` (for
`exec`).

**Recommended framing: B (branded value with methods), NOT a new `asCell` kind.**
Rationale: a new `CellKind` is a closed-union edit that ripples through CFC, the
schema generator (`packages/schema-generator/src/formatters/common-fabric-formatter.ts:65-68`
builds `AsCellEntry`s), `getAsCellKind`, and every exhaustiveness check over
`CellKind`, while buying nothing — because `_kind` does not gate method dispatch
anyway. Framing B reuses the brand + `toCell` machinery that already exists and
isolates the surface to the `api/index.ts` type + a small runtime helper module.

### 2.2 `db.query` — a reactive node mirroring `.map`

`db.query<Row>(sql, opts?)` would be sugar over the existing `sqliteQuery`
factory, exactly as `.map` is sugar over the `map` factory:

```ts
// conceptual — mirrors cell.ts:1688-1714 + built-in.ts sqliteQuery factory
query<Row>(sql: string, opts?: { params?: ...; reactOn?: unknown }): OpaqueRef<QueryState<Row>> {
  return sqliteQueryFactory({ db: this, sql, params: opts?.params, reactOn: opts?.reactOn });
  // result schema injected from <Row>, same as today (see §2.4)
}
```

The node, its result cell, the post-commit RPC, and the dedup-by-request-hash
logic (`builtins/sqlite-builtins.ts:154-237`) are **unchanged**. Only the
author-facing call site moves from `sqliteQuery({db, sql})` to `db.query(sql)`.
The receiver `db` becomes an input named `db` instead of being threaded as a
property — identical to how `.map` threads `this` as `list`.

### 2.3 `db.exec` — an imperative write mirroring `.set`

```ts
// conceptual — mirrors .set() (cell.ts:842-920) + Stage 2 plan (commit-fold.md:298-305)
exec(sql: string, params?: ...): void {
  const cell = asCellOrUndefined(this) ?? throw "...";   // cf-link.ts:25-35
  const tx = cell.tx;                                     // cell.ts:489
  if (!tx) throw new Error("db.exec requires a transaction (call inside a handler)");
  const dbRef = readDbRef(cell.get());                    // sqlite-builtins.ts:104-113
  tx.recordSqliteWrite(cell.space, {                      // v2-transaction.ts:832
    op: "sqlite", db: dbRef, sql, params: encodeParams(sql, params), // sqlite-builtins.ts:71-95
  });
}
```

This is precisely Stage 2's design (`sqlite-execute-commit-fold.md:298-305`) with
the `db`→Cell recovery happening on `this` instead of on a passed argument. It
records onto the **handler's** tx (because `this.tx` is the handler's tx), so the
SQL write commits atomically with sibling cell writes; SQL failure aborts the
whole commit (already proven at the engine level —
`sqlite-execute-commit-fold.md:88-96`).

### 2.4 Row typing / transformer lowering

Today `sqliteQuery<Row>(...)` lowers via the transformer: when `callKind.kind ===
"runtime-call" && callKind.exportName === "sqliteQuery"` and exactly one type arg
is present, it injects a `rowSchema` property built from `<Row>`
(`packages/ts-transformers/src/transformers/schema-injection.ts:3787-3864`). The
untyped form lowers to no schema (`schema-injection.ts:3801-3806`). `sqliteQuery`
is registered as a `runtime-call` reactive-origin export
(`packages/ts-transformers/src/core/commonfabric-runtime-registry.ts:190-195`).

`detectCallKind` resolves a free call through `resolveExpressionKind` on the
callee symbol (`call-kind.ts:230-235`), which is how `sqliteQuery` (an imported
identifier) is matched against the registry.

A **method** form `db.query<Row>(...)` is a `PropertyAccessExpression` callee, not
a bare identifier. The transformer DOES already classify cell methods —
`.map`/`.filter`/`.flatMap` are recognized via `ARRAY_METHOD_ACCESS_BY_NAME`
(`call-kind.ts:87-110`) and a reactive-receiver check
(`call-kind.ts:1196-1206`):

```ts
if (ts.isPropertyAccessExpression(target)) {
  const name = target.name.text;
  if (isKnownArrayMethodName(name)) {
    if (isReactiveArrayMethodReceiverExpression(target.expression, checker)) {
      return { kind: "array-method" };
    }
  }
}
```

So there is precedent for method-call classification. **But the `<Row>` schema
injection for `sqliteQuery` keys specifically off `exportName === "sqliteQuery"`
of a `runtime-call`** (`schema-injection.ts:3793-3796`). A method `db.query<Row>`
would NOT hit that branch; it would need either (a) a new method-name +
reactive-(sqlitedb)-receiver classifier (mirroring the array-method path), then a
new injection branch keyed on that method, OR (b) the receiver's TYPE resolved to
`SqliteDb` so the method symbol resolves back to a registry entry. Option (b)
needs the type checker to see `db.query` as a known reactive method — more checker
work than matching an imported identifier. **Net: method-call lowering is
strictly HARDER than free-function lowering for the typed-Row case** — it adds a
classifier and an injection branch where the free function needs neither. This is
the single biggest implementation cost of the cell-method form.

---

## 3. Comparison

| Axis | Standalone functions (today / Stage-2 plan) | `SqliteDb` cell-type (`db.query`/`db.exec`) |
| --- | --- | --- |
| **Author ergonomics** | `sqliteQuery({db, sql})`, `sqliteExecute(db, sql, p)`. `db` threaded explicitly each call. | `db.query(sql)`, `db.exec(sql, p)`. Reads naturally; `db` is the receiver. **Method form wins.** |
| **Reactivity model** | `query` is a `createNodeFactory` node (built-in.ts); identical machinery to `.map`. | Same node, same factory — method is sugar. **Equivalent.** |
| **Row typing / transformer** | Lowers via `exportName==="sqliteQuery"` runtime-call branch (schema-injection.ts:3787-3864). Imported-identifier match — simple. | Needs a NEW method classifier (mirror array-method path, call-kind.ts:1196-1206) + a NEW injection branch keyed on the method. **Function form wins — strictly less transformer work.** |
| **Atomicity & call context** | Stage-2 `exec(db,...)` recovers `db`→Cell→`tx`, records onto handler tx (commit-fold.md:298-305). | `exec` recovers `this`→Cell→`tx`; same fold, recovery is on `this`. **Equivalent; method slightly cleaner (no arg recovery).** |
| **Layering / import cycle** | Stage-2 notes a hazard: imperative fn is a runtime op exposed on the `cf` builder object; `built-in.ts` → `builtins/sqlite-builtins.ts` → `builder/types.ts` risks a value cycle; mitigated by a leaf module (commit-fold.md:28-34). | A cell method lives on `CellImpl`/the branded value's helper. `cell.ts` already imports `createNodeFactory` (cell.ts:19) and holds `tx`/`space`. `db.exec` reaches `recordSqliteWrite` through `this.tx` with NO new builder→builtins edge. **Method form RESOLVES the layering hazard** — see §4. |
| **CFC** | Per-call argument schemas; `trustedFlowPrecisionSchemaForBuiltin` already applied per builtin (map.ts:104). | Same CFC inputs; a dedicated kind would add CFC surface (getAsCellScope etc., cfc.ts:522-526) for no behavioral gain. **Function form simpler; method form neutral if using Framing B.** |
| **Persistence / identity** | Handle is an opaque-handle cell whose value is `SqliteDbRef{id,tables,rev}`, id = handle cell's own entity id (sqlite-builtins.ts:115-145). Brand + `toCell` (api/index.ts:2147-2153). | Identical handle/identity. Framing B keeps the brand; methods just dispatch off it. A new `asCell` kind (Framing A) would re-address via schema-scope machinery (cell.ts:1194-1206) — more moving parts, same identity. **Equivalent under Framing B.** |
| **Implementation cost** | Stage 1 done; Stage 2 is a contained rewrite of execute + registry flip + test churn (commit-fold.md:499-575). | Stage 2 work PLUS: type-level method surface on the handle, runtime method impls, AND a new transformer method classifier + injection branch for `<Row>`. **Function form is cheaper.** |
| **Migration cost** | Reuses Stage 1 seam, `sqliteQuery` node, codec, registry; discards only the reactive `sqliteExecute` node + its result cell/RPC/`rev` bump (commit-fold.md:526-538). | Same discards, PLUS rewrites the author-facing call surface of BOTH query and execute (every `sqliteQuery(...)`/`sqliteExecute(...)` call site and test moves to `db.query`/`db.exec`), PLUS new transformer paths. **Function form migrates less.** |

### What is REUSED vs DISCARDED under the cell-type design

**Reused (unchanged):** the Stage-1 commit-fold seam (`recordSqliteWrite`,
`sqliteOps`, the wire `SqliteOperation`) — `db.exec` is its ideal caller; the
`sqliteQuery` reactive node + post-commit RPC + dedup (`sqlite-builtins.ts:147-237`);
`encodeParams`/`parseInsertColumns`/`readDbRef` (`sqlite-builtins.ts:71-145`); the
`_cf_link` codec (`cf-link.ts`); the `sqliteDatabase` handle constructor; the
brand + `toCell` identity model.

**Discarded:** the reactive `sqliteExecute` node, its `{pending,result,error}`
result cell, the separate post-commit RPC, the `editWithRetry`, and the `db.rev`
bump (`sqlite-builtins.ts:239-336`) — same as Stage 2 already plans to discard.

**Added (cell-type only, beyond Stage 2):** the typed method surface on the
handle; a transformer method-call classifier + a `<Row>` injection branch for
`db.query` (the array-method classifier at `call-kind.ts:1196-1206` is the
template, but the schema injection at `schema-injection.ts:3787-3864` would need a
sibling branch).

---

## 4. Recommendation

**Hybrid, leaning function-for-query / method-for-exec — but only after Stage 2
ships as planned.** Concretely:

1. **Ship Stage 2 of `sqlite-execute-commit-fold.md` first, unchanged.** It is a
   contained, already-designed rewrite that delivers atomic imperative writes.

2. **`db.exec` as a cell method is strictly better than the free
   `sqliteExecute(db, ...)` function and should be adopted** — preferably AS the
   Stage-2 surface (or a thin rename of it). Reasons, by axis:
   - **It resolves the layering hazard** that Stage 2 calls out
     (`commit-fold.md:28-34`). The free imperative function must be exposed on the
     `cf` builder object while reaching runtime helpers, risking a
     `built-in.ts`→`builtins`→`builder/types.ts` value cycle. A cell method lives
     where the tx already is: `cell.ts` already imports `createNodeFactory`
     (`cell.ts:19`) and the cell already holds `tx` (`cell.ts:489`) and `space`
     (`cell.ts:677`). `db.exec` reaches `recordSqliteWrite` through `this.tx` with
     **no new builder→builtins import edge**. The hazard simply does not arise.
   - **No argument-recovery step.** Stage 2 must recover `db`→Cell from a passed
     proxy; the method's `this` IS the cell.
   - **It is the closer analogue to `.set()`**, which is exactly the mental model
     the brief asks for, and matches existing precedent on `CellImpl`.

3. **`db.query<Row>` as a cell method is ergonomically nicer but NOT worth it
   yet** — it is strictly harder on the one axis that already has a working,
   tested solution: the `<Row>` transformer lowering keys off an imported
   identifier (`schema-injection.ts:3793-3796`), and moving to a method forces a
   new method classifier + a new injection branch. Keep `sqliteQuery<Row>(...)` as
   the free function for now; revisit `db.query` once `db.exec`-as-method proves
   the handle-method pattern and someone is willing to extend the transformer's
   method-call classification (the array-method path is the template).

**Do NOT introduce a new `asCell` `CellKind`.** `_kind` does not gate method
dispatch (only `"stream"` is behaviorally special — `cell.ts:707-708,1602`), so a
new kind is pure cost across the closed union (`api/index.ts:181-187`), CFC, and
the schema generator with no payoff. Use the existing brand + `toCell` recovery
(`cf-link.ts:25-35`) — Framing B.

In one line: **adopt `db.exec` (method = better, and it kills the import-cycle
hazard); keep `sqliteQuery<Row>` as a free function (method = harder Row
lowering); skip the new cell kind entirely.**

---

## 5. Open questions / risks

1. **`<Row>` method lowering is the real blocker for `db.query`.** The transformer
   injects `rowSchema` only for a `runtime-call` named `sqliteQuery`
   (`schema-injection.ts:3793-3796`). A method needs a new classifier (template:
   the array-method reactive-receiver check, `call-kind.ts:1196-1206`) AND the
   checker to resolve `db.query` to a known reactive method. Whether the checker
   reliably resolves the method symbol back to a registry entry across re-exports
   is unverified here.

2. **Where do methods physically attach?** `CellImpl` is a single class;
   `map`/`set` are plain methods, NOT per-kind dispatch. Adding `query`/`exec` to
   every `CellImpl` (Framing A) pollutes all cells. Framing B (branded value with
   a small helper that recovers the Cell) avoids this but means `db` is not
   literally an `instanceof CellImpl` — it is a branded value whose methods
   recover the cell. The `isCell`/`toCell` path supports this
   (`cf-link.ts:25-35`), but the author's `db` would be `OpaqueRef<SqliteDb>` at
   build time and a proxy at runtime; confirm the method surface is visible on
   `OpaqueRef<SqliteDb>` (OpaqueRef does not define `map`/`filter` itself — they
   resolve through the proxy to `CellImpl`; a custom method would need the same
   proxy forwarding). **This proxy-forwarding-for-a-custom-method path is
   unverified and is the main runtime risk.**

3. **`reactOn: db` after a folded write.** Independent of function-vs-method, the
   commit-fold design drops the `rev` bump, so a `db.query(..., {reactOn: db})`
   does not auto-re-run after `db.exec` (`commit-fold.md:640-650`). This must be
   decided regardless of surface shape; the cell-method framing does not change
   it.

4. **`db.exec` requires a tx-bound `this`.** Like `.set()`
   (`cell.ts:879-884`), `db.exec` must throw clearly when `this.tx` is absent
   (called outside a handler / on a plain dereferenced value). Stage 2 already
   pins this precondition with test (f) (`commit-fold.md:495-497,268-276`).

5. **Single-cell-db-per-commit.** The server enforces ≤1 cell-db per commit
   (`commit-fold.md:631-635`). `db.exec` twice on the same handle is fine; against
   two different dbs in one handler it rejects server-side. A method form makes it
   easier for an author to call `dbA.exec(...); dbB.exec(...)` in one handler and
   hit that limit — worth a friendlier client-side assertion in
   `recordSqliteWrite` (`v2-transaction.ts:832-850`).

## Grounding spike (cell-variant + pending detection)

> Status: grounding spike only, no code changed. Every file:line below was opened
> and read in the `feat/sqlite-builtin-impl` worktree
> (`/Users/berni/src/labs.sqlite-builtin`). This section resolves the three
> previously-unverified items in §5 (open questions 1, 2, and the proxy-forwarding
> risk in 2), and keeps the brief's distinction explicit: **cell VARIANT
> (type-level method surface) vs `asCell` KIND (runtime behavioral gate)** are
> different axes.

### Q1 — variant family structure; cost of a new variant

**The variant family is a TYPE-LAYER construct over a single runtime class.** All
of `Cell` / `ReadonlyCell` / `WriteonlyCell` / `ComparableCell` / `Stream` /
`OpaqueCell` are declared in `packages/api/index.ts` as interfaces that compose
`BrandedCell<T, Kind>` with a different mix of capability interfaces
(`IReadable` / `IWritable` / `IStreamable` / `IEquatable` / `IKeyable` /
`IDerivable` / `IResolvable`):

- `Cell<T>` = `BrandedCell<T,"cell">` + the full `ICell` capability bundle
  (`api/index.ts:1058-1073`).
- `ReadonlyCell<T>` = `BrandedCell<T,"readonly">` + read/equate/key only, NO
  `IWritable`/`IResolvable` (`api/index.ts:1131-1140`).
- `WriteonlyCell<T>` = `BrandedCell<T,"writeonly">` + write/key only
  (`api/index.ts:1151-1159`).
- `Stream<T>` = `BrandedCell<T,"stream">` + `IStreamable` only (`.send()`),
  declared as a `CellTypeConstructor` (`api/index.ts:1094-1101`).
- `OpaqueCell<T>` = `BrandedCell<T,"opaque">` + key/derive/opaquable only
  (`api/index.ts:1043-1046`).
- `OpaqueRef<T>` is literally `type OpaqueRef<T> = T` (`api/index.ts:1172`) — NOT
  its own interface; it is the structural type the proxy presents at build time.

So a "variant" is **a branded interface that selects a subset of capability
interfaces**. The method surface differs purely by which `I*` interfaces are
mixed in; the brand `Kind` string is a type tag.

**At runtime there is exactly ONE class, `CellImpl`.** `createCell()` always
returns `new CellImpl(...)` regardless of kind (`cell.ts:425-442`); the `kind`
argument is just stored. `map`/`filter`/`set`/`get`/`key` are plain methods on
that single class (`map` at `cell.ts:1688-1714`; `set` at `cell.ts:842-920`).
There are no per-variant subclasses and no per-kind method tables.

**`asCell` KIND (`_kind`) is a near-inert runtime tag, NOT a method gate.** Grep
of `_kind` shows the only behavioral branch is `"stream"` (`isStream()` =
`value instanceof CellImpl && value.isStream?.()`, `cell.ts:2526-2528`); every
other site merely propagates `_kind`. `CellKind` itself is the closed union
`"cell"|"opaque"|"stream"|"comparable"|"readonly"|"writeonly"`
(`api/index.ts:181-187`), consumed by `AsCellEntry` (`api/index.ts:193-198`).

**Verdict (Q1): a `SqliteDb` variant is a CHEAP typed facade, not a new runtime
class.** It is a new branded interface in `api/index.ts` — `SqliteDb<...> =
BrandedCell<Handle,"cell"> + { query; exec }` (reuse the existing `"cell"` kind;
do NOT add a kind) — backed by the same `CellImpl`. No new runtime class, no new
proxy class, and (if it reuses kind `"cell"`) no CFC / schema-generator / closed-
union edits. This confirms §2.1's Framing B and §5's recommendation against a new
`asCell` kind: adding a `CellKind` would ripple through the closed union and
`AsCellEntry` while buying nothing, because `_kind` does not gate dispatch.

The ONE non-facade cost is method dispatch through the proxy and transformer Row
lowering — Q2 below pins the proxy seam exactly.

### Q2 — does a CUSTOM method forward through the OpaqueRef proxy?

**Answer: NO — not automatically. The OpaqueRef proxy uses an explicit allow-list
(`cellMethods`), so `.query`/`.exec` would silently fail to bind unless added to
that set. This is the exact seam, and it is small.**

The OpaqueRef proxy is minted by `CellImpl.getAsOpaqueRefProxy()`
(`cell.ts:1630-1682`); `opaqueRefWithCell` returns it (`builder/opaque-ref.ts:65`).
Its `get` trap (`cell.ts:1635-1679`) dispatches in this order:

1. `Symbol.iterator` / `Symbol.toPrimitive` / `toCell` / `isOpaqueRefMarker` /
   `SELF` — special symbols (`cell.ts:1636-1659`).
2. For a string/number `prop`: it ALWAYS navigates `self.key(prop)` to a nested
   cell (`cell.ts:1662`), then checks **`cellMethods.has(prop)`**
   (`cell.ts:1665`). If the name is in the set, it returns the nested cell's
   proxy bound to the real method: `nestedCell.getAsOpaqueRefProxy(self[prop].bind(self))`
   (`cell.ts:1666-1672`). Otherwise it returns the nested cell's proxy with no
   bound method (`cell.ts:1674`).
3. Else delegate to the target (`cell.ts:1678`).

`cellMethods` is an explicit `Set` of method names (`cell.ts:372-423`) —
`get`, `set`, `map`, `filter`, `flatMap`, `key`, `sink`, etc. **`.map`/`.filter`
are NOT generic forwards; they are in this allow-list.** A name absent from the
set (e.g. `query`/`exec`) is treated as a data-key navigation, not a method: the
returned proxy is bound to no callable, so calling it would not invoke a
`CellImpl` method.

The query-result proxy (the value-proxy a handler actually reads,
`query-result-proxy.ts:211-270`) is a SEPARATE proxy and is even more closed: it
forwards `toCell` (`:227-229`), array methods via an `arrayMethods` table
(`:272-278`), and otherwise reflects the underlying concrete value
(`:264-269`). It exposes NO cell mutators and no custom-method seam.

**Exact seam to add `.query`/`.exec` (smallest correct change):**

1. Add `query` and `exec` as real methods on `CellImpl` (siblings of `map`/`set`,
   `cell.ts:842-920,1688-1714`) — `query` calls the `sqliteQuery`
   `createNodeFactory` with `{db:this,...}`; `exec` reads `this.tx`
   (`cell.ts:489`, public readonly) and `this.space` (`cell.ts:677`) and calls
   `this.tx.recordSqliteWrite(...)` (Stage-1 seam).
2. Add the strings `"query"` and `"exec"` to the `cellMethods` set
   (`cell.ts:372-423`) so the OpaqueRef `get` trap binds them at build time
   (`cell.ts:1665-1672`).
3. Add `query`/`exec` to the `SqliteDb` interface in `api/index.ts` (the
   capability bundle) so the surface is visible/typed on `OpaqueRef<SqliteDb>`.

That is the whole runtime+type seam for dispatch. The proxy handler itself does
NOT need new code — the allow-list `Set` is the data the handler reads. (The
separate `<Row>` transformer-lowering cost for `db.query<Row>` from §2.4 still
stands and is unchanged by this finding; it is what makes `db.query` strictly
harder than `db.exec`.)

**This directly resolves §5 open-question 2's "main runtime risk".** Custom
methods do NOT forward by default; they require an entry in the `cellMethods`
allow-list. That is a one-line addition, not a proxy rewrite — so the risk is
real but cheap to discharge, and now precisely located.

### Q3 — can a PENDING reactive param be detected synchronously at `exec` time?

This splits into two genuinely different sub-cases, and the honest answer differs
between them.

**What "pending" actually is at runtime.** There is NO general runtime pending-
value sentinel. Grep for `PENDING`/pending markers on values finds none in
`packages/runner/src/*.ts`. "Pending" exists in only two unrelated forms:
- a STORAGE-load concept inside `storage/v2.ts` (`pending: PendingVersion[]`,
  `:166`, and a `"pending:"` dependency string `:443`) — about data not yet
  loaded from the server, surfaced by throwing during a tx read, not a value an
  author holds; and
- a FIELD CONVENTION: sqlite/fetch result cells store `{ pending: boolean,
  result?, error? }` (sqlite `QueryState` at `sqlite-builtins.ts:147-152`, written
  `{pending:true}` at `:206`/`:295`; fetchData mirrors it, `fetch-data.ts:76-92`).
  This `pending` is an ordinary boolean property of a normal result object — it is
  NOT a type-level marker and is indistinguishable from any other `{pending:...}`
  object.

**How a handler param arrives — the deciding fork (`runner.ts:2096-2105`,
`2352`).** When the handler's argument is materialized, the schema decides shape:
- If the param's schema is `asCell` including `"cell"`/`"writeonly"`
  (`runner.ts:2097-2100`) — i.e. declared `Cell<>`/`Writable<>` — the param
  arrives as a CELL/proxy carrying a `toCell` back-pointer. `SqliteDatabase` is
  exactly this (it is `asCell` with a `toCell`, per §1.3 / commit-fold.md:602-607).
- Otherwise the param is materialized through the query-result proxy
  (`inputsCell.getAsQueryResult([], tx, ...)`, `runner.ts:2352`), which reflects
  the CONCRETE resolved value (`query-result-proxy.ts:264-269`). Links are
  followed during this read; an unresolved/not-yet-loaded link throws a storage
  "pending dependency" during materialization (`storage/v2.ts:443`), causing a
  handler retry — it does NOT hand the author a detectable "pending" sentinel.

**Detection predicate that IS reliable.** "Is this param a cell/reference rather
than a resolved scalar?" is synchronously decidable with the existing markers:
- `isCell(value)` = `value instanceof CellImpl` (`cell.ts:2507-2508`);
- the `toCell` back-pointer test used by `asCellOrUndefined`
  (`builtins/sqlite/cf-link.ts:25-35`): `typeof value[toCell] === "function"`,
  matching the OpaqueRef proxy (`cell.ts:1652-1654`) and the query-result proxy
  (`query-result-proxy.ts:227-229,594-596`);
- `isOpaqueRef(value)` via `isOpaqueRefMarker` (`builder/types.ts:160-168`).

So `exec(sql, params)` CAN synchronously throw a teaching error when a param is a
**cell/proxy/OpaqueRef** (author passed `db`-style handle or a `Cell<>` where a
scalar was expected). Predicate: `isCell(p) || isOpaqueRef(p) || (isRecord(p) &&
typeof p[toCell] === "function")`.

**Where it is NOT reliable — state the risk loudly.** If the author passes
`someQuery.result` (a plain-typed field off a result cell that hasn't completed),
that value is materialized by the query-result proxy as a CONCRETE read, and a
not-yet-populated `result` reads as `undefined` (the result cell was written
`{pending:true}` with `result` absent, `sqlite-builtins.ts:206`). At `exec` time
that param is indistinguishable from a legitimately-`undefined` scalar — there is
NO runtime marker distinguishing "pending-and-empty" from "resolved-to-undefined".
The only "pending" signal is the SIBLING boolean `pending` field on the result
object, which `exec` does not receive when handed the unwrapped `.result`.
Therefore "throw on a pending param" is reliable ONLY for the cell/reference case,
NOT for the unwrapped-scalar-off-a-pending-result case. For the latter, the
storage layer's own pending-dependency retry (`storage/v2.ts:443`) is the actual
guard, not a synchronous throw.

**Verdict (Q3):** synchronous "throw on pending" is implementable and reliable
for the case that matters for design (b) — a reactive param passed AS a
cell/OpaqueRef/proxy — using `isCell` / `isOpaqueRef` / the `toCell` test. It is
NOT reliable for an already-unwrapped scalar drawn from a pending result cell
(pending-empty == undefined). Recommend `exec` accept params as a tx-bound
cell/proxy (mirroring how `db` itself arrives, `runner.ts:2097-2100`) so the
detectable case is the common case, and document the unwrapped-undefined gap.

### Bottom line (3 lines)

1. The `db.*` cell-variant route is CHEAP as a typed facade over the single
   `CellImpl` (Q1) — the only real runtime cost is one allow-list entry per method
   in `cellMethods` plus the `<Row>` transformer branch for `db.query`; do NOT add
   an `asCell` kind.
2. The custom-method seam is exact and small (Q2): add `query`/`exec` as
   `CellImpl` methods AND register their names in `cellMethods` (`cell.ts:372-423`);
   they will NOT forward otherwise — the proxy is allow-list-gated, not generic.
3. Sync-exec-with-throw-on-pending is implementable and reliable for params passed
   AS a cell/OpaqueRef/proxy (`isCell`/`isOpaqueRef`/`toCell`), but CANNOT reliably
   distinguish a pending-empty unwrapped scalar from `undefined` — so make `exec`
   take reference-shaped params and lean on storage pending-retry for the rest.

---

## DECIDED DESIGN (implementation-ready, 2026-06-01)

Supersedes the free-function `db.exec` framing in `sqlite-execute-commit-fold.md`
§2 (Stage 1 seam there is still the foundation and stays). Decisions locked with
the user this session.

### Shape
`SqliteDb` is a **new cell kind `"sqlite"`** in the same family as
`readonly`/`writeonly`/`opaque`/`comparable`: `CellKind` (`api/index.ts:181-187`)
is already a 6-member union and these are **type-level brands**, not runtime gates
(only `"stream"` and `"opaque"` are behaviorally gated — cell.ts:708/1602,
schema.ts:578, traverse.ts:2476/3110). So
`SqliteDb = BrandedCell<T, "sqlite"> & ISqliteDb<T>`, backed by the single
`CellImpl`, value = the handle ref `{id, tables}`, carrying `tx`/`space`, with an
`asCell: ["sqlite"]` marker that **falls through to normal cell read behavior**
(like `readonly`). Its specialness is the method surface, not read-path gating.
`sqliteDatabase({tables})` returns a `SqliteDb`.

> **Why `"sqlite"`, not reuse `"cell"`** (overrides the grounding-spike Q1
> suggestion, per user): `"cell"` denotes a general read/write value container,
> which a DB handle is not. A distinct kind is the **same implementation cost** (a
> `CellKind` union member + `cellMethods` entries; no new runtime gate) but is
> semantically honest and buys type-safety — a `SqliteDb` can't be passed where a
> writable `Cell<T>` is expected, and the handle can't be `.set()` by accident.
> Work: add `"sqlite"` to `CellKind`; define `ISqliteDb<T>` (exec/query, no
> `IWritable`); verify the generic `getAsCellKind` consumers (schema.ts:594/664/1180,
> cell.ts:1201) treat it as non-stream/non-opaque (they compare `=== "stream"`/
> `=== "opaque"`, so it falls through — the same path `readonly` takes).

- **`db.exec(sql, params?)` — sync write.** Records a folded `sqlite` op onto the
  cell's own `tx` via the Stage-1 seam (`recordSqliteWrite`), atomic with any
  sibling cell writes in that commit; abort-only on SQL failure; no result cell.
- **`db.query<Row>(sql, options?)` — reactive read.** The existing `sqliteQuery`
  reactive node, surfaced as a method; `reactOn` re-runs it.

Call-shape is not strict: the free `sqliteExecute`/`sqliteQuery(db, …)` forms may
coexist, but `db.*` methods are primary.

### Decision 1 — `db.query<Row>` typed lowering goes the TRANSFORMER route ("worth it")
Extend the transformer to lower a **method-call** type argument
`db.query<Row>(...)`, not just the free-function `sqliteQuery<Row>(...)` we
already do. Work: teach `detectCallKind`/the schema-injection visitor to
recognize a `PropertyAccessExpression` call where the property is `query` on a
`SqliteDb`-typed receiver, and inject `rowSchema` exactly as the existing
free-function branch does (`schema-injection.ts` sqliteQuery branch). The
`<Row>` → `asCell` machinery (Cell<T> fields) is unchanged and reused. This is
the one larger cost of full `db.*` adoption, accepted deliberately.

### Decision 2 — pending detection: disallow `undefined` params
For now, `db.exec` **throws if any param value is `undefined`** (after `_cf_link`
encoding). Rationale: there is no universal runtime pending sentinel
(grounding-spike Q3); a pre-unwrapped pending value reads as `undefined`, so
rejecting `undefined` catches it conservatively. `null` remains valid (SQL
`NULL`). Reference-shaped params (a `Cell`/`OpaqueRef` passed directly) are
either encoded (`_cf_link` columns) or already rejected (cells bound to non-link
columns). A separate thread will improve general pending detection; the
`undefined` rule is the interim proxy. Error message should teach: "sqlite param
N is undefined — it may be a value that isn't ready yet; pass a resolved value
(or `null` for SQL NULL), or use the reactive form."

### Regression requirement
Because this touches foundational `cell.ts` (the shared `CellImpl` + `cellMethods`
allow-list + the `CellKind` union), every stage must gate on the **full workspace
suite `deno task test` AND `deno task integration`** — not just the runner
package. Run both green before committing each stage.

### Implementation stages
1. **`SqliteDb` cell variant + `.exec` method (reuses Stage-1 seam).**
   - Add `"sqlite"` to `CellKind` and a branded `SqliteDb = BrandedCell<T,"sqlite"> & ISqliteDb<T>`
     interface in `packages/api/index.ts` exposing `exec`/`query` (no `IWritable`;
     + `toCell` recovery, as today).
   - Add `exec`/`query` as real methods on `CellImpl` (`packages/runner/src/cell.ts`)
     and to the `cellMethods` allow-list (`cell.ts:372-423`) so the OpaqueRef
     proxy forwards them (grounding-spike Q2). `exec` recovers `this.tx`/`this.space`,
     runs `encodeParams` (reuse `builtins/sqlite-builtins.ts`), enforces the
     no-`undefined` rule, and calls `this.tx.recordSqliteWrite(this.space, {op:"sqlite", db: readDbRef(this.get()), sql, params})`.
     (Watch the cell.ts→builtins layering; move the codec helpers to a leaf
     module if a cycle appears.)
   - RED tests: handler does `y.set(z)` + `db.exec(INSERT…)` → one atomic commit
     (extend `sqlite-commit-fold.test.ts`); `db.exec` with an `undefined` param
     throws; `_cf_link` cell param encodes; SQL failure rolls back the sibling
     cell write.
2. **`db.query<Row>` method + transformer method-call lowering (Decision 1).**
   - `query` method builds the `sqliteQuery` reactive node.
   - Transformer: method-call recognition + `rowSchema` injection; RED-T1-style
     fixture `db.query<{author: Cell<X>}>(...)` → injected `rowSchema` with
     `asCell` on the alias.
3. **Drop the reactive `sqliteExecute` node** (result cell/RPC/rev bump) per
   `sqlite-execute-commit-fold.md` §6; flip its registry entry to
   `reactiveOrigin:false` (or remove if fully replaced); migrate declarative
   call sites to handler `db.exec`.
4. **(Optional) `{reactive}` opt-in for `exec`** — escalate to the reactive-node
   form for writing reactively-derived values (the (a) path); design later.

### Reused vs discarded
- **Reused:** Stage-1 commit-fold seam (done); `encodeParams`/`_cf_link` codec;
  `sqliteQuery` reactive node; the `rowSchema` injection logic (extended to
  method calls).
- **Discarded:** the reactive `sqliteExecute` node + its result cell/RPC/`rev`
  bump; `reactOn:db` read-after-write re-run (dropped this session).
