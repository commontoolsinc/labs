# schema-generator: TypeScript → JSON Schema Mapping (Current Behavior)

**Status:** Descriptive (current behavior; on conflict, code/tests win — §1)\
**Package:** `@commonfabric/schema-generator`\
**Last verified against:** origin/main `47ad2b898` plus this documentation and
test branch, 2026-07-16 verification\
**Related:** `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`
(§10, §12 describe the consumer side; its §6.8/§12 CFC-lowering account was
corrected in the same 2026-07 audit that produced this document) and
`docs/specs/ts-transformer/README.md` (corpus map and authority rules).

## 1. Scope And Source Of Truth

This document specifies what the schema generator currently does, not what it
is intended to do. It covers the conversion of `ts.Type` / `ts.TypeNode`
inputs into `JSONSchemaMutable` values; not schema validation, runtime schema
interpretation, or the transformer stages that decide *when* to generate.

Authoritative implementation sources:

- `packages/schema-generator/src/**`
- `packages/schema-generator/test/**` (fixtures under `test/fixtures/schema/`)
- the wrapper/extension vocabulary in `packages/api/index.ts` and
  `packages/api/cfc.ts`

If this document conflicts with code or passing tests, code/tests win.

Package exports (`deno.jsonc:4-12`): `.` → `src/index.ts` (no `mod.ts`), plus
six subpaths — `./interface`, `./cell-brand`, `./wrapper-names`,
`./type-traversal`, `./property-optionality`, `./property-name`.
`src/index.ts` exports the `SchemaGenerator` class,
`createSchemaTransformerV2`, the `ISchemaGenerator` type, and re-exports
`JSONSchemaObjMutable`.

Consumers, as of this writing (verified by import grep): the only external
consumer package is `@commonfabric/ts-transformers`, along two axes:

1. **Schema generation proper** — `SchemaGeneratorTransformer`
   (`packages/ts-transformers/src/transformers/schema-generator.ts`) calls
   `createSchemaTransformerV2()` and feeds it the pipeline's bare cross-stage
   maps `typeRegistry` / `schemaHints`
   (`ts-transformers/src/core/cross-stage-state.ts:72-73`; its header notes
   this package reads only the bare `WeakMap`s, not `CrossStageState`).
2. **Wrapper-vocabulary oracle** — ts-transformers imports the subpaths
   directly: `cell-brand` (call-root-support, cell-type, opaque-get-validation,
   helper-owned-expression), `wrapper-names` (cast-validation, type-shrinking,
   call-kind), `property-name` (reactive-keys, type-shrinking),
   `property-optionality` (`ast/utils.ts`). The `src/typescript/` tables are
   load-bearing for the whole transformer pipeline, not just schema output.

Instance state: `AnonymousType_N` naming lives on the `SchemaGenerator`
instance (`anonymousNames` WeakMap + counter, `src/schema-generator.ts:45-48`)
— numbering is stable per instance across successive `generateSchema` calls.

## 2. Generation Entry Points And Analysis-Path Selection

Two public methods (`src/interface.ts:86-143`, implemented in
`src/schema-generator.ts`): `generateSchema(type, checker, typeNode?,
{widenLiterals?}?, schemaHints?, sourceFile?)` (`:54-85`) — the normal,
type-driven path — and `generateSchemaFromSyntheticTypeNode(typeNode, checker,
typeRegistry?, schemaHints?, sourceFile?)` (`:94-126`), a thin wrapper that
passes `checker.getAnyType()` as the type (`:116`), forcing the auto-detection
below onto the node-based path.

`createSchemaTransformerV2()` (`src/plugin.ts:8-46`) wraps one shared
`SchemaGenerator` instance and exposes both methods. Type-level drift: the
plugin's signatures narrow `schemaHints` to `WeakMap<ts.Node, { items?:
unknown }>` (`plugin.ts:17,34`) while the class and `GenerationContext` accept
the full `{ items?, cfcUiContract? }` shape (`interface.ts:46-60`) —
runtime-compatible, type-level under-description.

**Path selection** (`shouldUseNodeBasedAnalysis`,
`src/schema-generator.ts:221-237`): node-based analysis is used iff a
`typeNode` is present, the resolved type has `TypeFlags.Any`, and the node is
*not* a wrapper reference (`detectWrapperViaNode`) — wrapper nodes stay on the
type path for `CommonFabricFormatter`. `formatChildType` (`:246-280`) re-runs
the detection per child and deliberately strips the parent's `typeNode` when
no child node is supplied (`:251-255`) to avoid mismatched type/node pairs.

The consumer adds a second trigger of its own: `SchemaGeneratorTransformer`
routes to `generateSchemaFromSyntheticTypeNode` when (a) the type arg is
synthetic (`pos === -1 && end === -1`) and resolved to `any`, or (b) the
real-position type arg *contains* an `any`/`unknown` keyword anywhere
(`containsAnyOrUnknownTypeNode`), "so the checker does not recover a wider
semantic type"
(`ts-transformers/src/transformers/schema-generator.ts:84-101,485-500`). Both
triggers are documented in the ts-transformers behavior spec §12.

**The node-based analyzer** (`analyzeTypeNodeStructure`,
`src/schema-generator.ts:751-959`) handles: `TypeLiteral` nodes (properties
with `questionToken` optionality; string/number index signatures →
`additionalProperties`, first non-undefined wins, no JSDoc — `:759-843`),
`ArrayTypeNode` (`:846-855`), unions (`true` member short-circuits, `false`
members filtered, singletons unwrapped — `:861-877`), literal nodes
(`:879-896`), `TypeReference` nodes (wrapper detection first, then a
scope-based name-resolution fallback for unbindable synthetic references via
`checker.getSymbolsInScope` — `:901-922,961-1003` — plus a `Date`-by-name
special case `:917-921`), keyword types (`:925-948`), and a final
resolve-else-`true` fallback (`:950-958`).

**Observed node/type divergence — literal encodings.** The node path emits
`const` (`{ type: "string", const: "x" }`, `:881-895`); the type path emits
single-value `enum` (`{ type: "string", enum: ["x"] }`,
`src/formatters/primitive-formatter.ts:44-70`). Both spellings appear in
emitted schemas depending on the producing path. The distinction is pinned by
`test/literal-encoding-paths.test.ts`.

## 3. Formatter Chain

`formatType` dispatches to the first formatter whose `supportsType` returns
true, in this fixed order (`src/schema-generator.ts:35-44`):

1. `CommonFabricFormatter` — wrappers, scopes, Default, CFC aliases, wrapper
   unions
2. `NativeTypeFormatter` — built-in name table (§5.2)
3. `UnionFormatter`
4. `IntersectionFormatter` — declines cell-branded intersections
   (`intersection-formatter.ts:21-27`)
5. `ArrayFormatter` — deliberately before `PrimitiveFormatter` "to avoid
   Any-flag misrouting" (comment `:40`)
6. `PrimitiveFormatter`
7. `ObjectFormatter` — also claims the TS `object` keyword via `typeToString`
   (`object-formatter.ts:187-193`)

Order matters: CommonFabric before Union (wrapper unions), Native before
Object (built-ins are object types), Array before Primitive. If no formatter
matches, generation throws (`src/schema-generator.ts:462-474`). Before
dispatch, `formatType` short-circuits unresolved type parameters
(constraint → default → `{}`, `:351-362`) and conditional types (`{}`,
`:369-371`).

## 4. Core Type Mappings

All rows verified against code; test/fixture status marked. "probe" = verified
by an ad-hoc generation run against this tree during spec drafting, not pinned
by any repo test.

| TypeScript input | Emitted schema | Source | Pinned by |
| --- | --- | --- | --- |
| `string` / `number` / `boolean` | `{ type: "string"/"number"/"boolean" }` | `primitive-formatter.ts:87-95` | many fixtures |
| String/number literal | `{ type: …, enum: [v] }` (type path); `{ type: …, const: v }` (node path) | `primitive-formatter.ts:44-61`; `schema-generator.ts:881-886` | divergence pinned by `test/literal-encoding-paths.test.ts` (unions diverge structurally: `enum` list vs `anyOf` of `const`s); runner validation treats both alike but `schemasEqualIgnoringWriterStamp` (deepEqual, `cfc/prepare.ts:1014`) does not — a path flip defeats stored-schema reuse |
| Boolean literal | `{ type: "boolean", enum: [true/false] }` via `intrinsicName` | `primitive-formatter.ts:62-70` | boolean-literals test |
| `bigint` | `{ type: "integer" }` | `primitive-formatter.ts:96-98` | probe only |
| bigint literal (`42n`) | `{ type: "integer", enum: [Number(v)] }` — converted through `Number`, so precision above 2^53 would be lost | `primitive-formatter.ts:71-79` | probe only |
| Template literal type | `{ type: "string" }` | `primitive-formatter.ts:82-84` | probe only |
| `null` | `{ type: "null" }` | `primitive-formatter.ts:99-101` | fixtures |
| `undefined` | `{ type: "undefined" }` — non-standard, deliberate (`api/index.ts:1551`) | `primitive-formatter.ts:102-105`; node `schema-generator.ts:934-936` | fixtures |
| `void` | `{ asCell: ["opaque"] }` ("matches anything, but we will not access the cell") | `primitive-formatter.ts:106-109`; node `schema-generator.ts:942-944` | void-type.test.ts ×3 |
| `never` | `false` (boolean schema); `never[]` → `items: false`; `false` members dropped from `anyOf` | `primitive-formatter.ts:110-114`; `array-formatter.ts:59-62`; `union-formatter.ts:1043-1046` | array-special-types |
| `any` | `true`; `any[]` → `items: true` | `primitive-formatter.ts:115-118`; `array-formatter.ts:49-52` | tests |
| `unknown` | `{ type: "unknown" }` — non-standard (`api/index.ts:1552`); `unknown[]` → `items: { type: "unknown" }` | `primitive-formatter.ts:119-122`; `array-formatter.ts:54-57` | array-special-types |
| TS `object` keyword | `{ type: "object", additionalProperties: true }` | `object-formatter.ts:200-207` | probe only |
| Uninstantiated type parameter | constraint if any, else default, else `{}` | `schema-generator.ts:351-362` | untested at generator level; the pipeline substitutes `unknown` nodes before generation (ts-transformers spec §10.5), so `{}` is the *local* behavior |
| Conditional type | `{}` | `schema-generator.ts:369-371` | untested |
| `T[]` / `Array<T>` / `ReadonlyArray<T>` / aliases | `{ type: "array", items: <T> }`; node-first element detection, then Reference/typeArguments, then numeric index | `type-utils.ts:589-747`; `array-formatter.ts` | fixtures |
| Tuple (`[string, number]`) | `{ type: "array", items: <merged element union> }` — e.g. `items: { type: ["number","string"] }`. **No `prefixItems`, no length bounds**; positional structure is lost (numeric-index fallback, `type-utils.ts:735-744`; grep confirms `prefixItems` appears only in a comment) | `type-utils.ts:735-744` | `test/tuple-emission.test.ts` |
| Dictionary with both string and number index | treated as object map, not array | `type-utils.ts:716-733` | untested directly |
| Index signatures on objects | `additionalProperties: <value schema>`; string index takes precedence over number; JSDoc from index-signature declarations propagates (conflicts → keep first + `$comment`) | `object-formatter.ts:334-379`; node path `schema-generator.ts:793-825` (no JSDoc) | descriptions-index* fixtures |
| `Record<K,V>` with finite literal-union `K` | expands to concrete `properties` (checker-driven property enumeration) | via `ObjectFormatter`; fixture `record-union-keys` | record-mapped-types.test.ts |
| Functions / callables / constructables | property skipped entirely (not in `properties`, not in `required`) — **except** callable properties whose call signature returns `Stream`/`Cell`/`SqliteDb` (ModuleFactory/HandlerFactory shapes): kept as `{ asCell: ["stream"/"cell"/"sqlite"] }` and they participate in `required` | skip: `type-utils.ts:558-575`, `object-formatter.ts:233-238,259,269-287`; exception: `object-formatter.ts:44-67` (only those three kinds; capability cells like `ReadonlyCell` returns are *not* kept) | pattern-with-types fixtures |
| TS `enum` declaration | hoisted under the enum name with **no `type` key** (all-literal union path, §8): numeric → `$defs: { Color: { enum: [0,1,2] } }` + `$ref`; string → `$defs: { Mode: { enum: ["on","off"] } }` | union path `union-formatter.ts:176-214`; hoisting §5 | `test/enum-schema-rows.test.ts` |
| Single enum member type (`Mode.On`) | inline literal schema, e.g. `{ type: "string", enum: ["on"] }`; enum-member symbols are excluded from named-type hoisting so same-named members and unrelated named types cannot collide in `$defs` | `getNamedTypeKey`, `type-utils.ts`; pinned by `test/enum-member-hoisting.test.ts` | — |
| `Date` / `URL` / typed arrays / etc. | native table, §5.2 | `native-type-formatter.ts:5-28` | date-types fixture, native-type tests |
| `Map`/`WeakMap`/`Set`/`WeakSet` | **throws** (§13) | `type-utils.ts:400-411` | schema-generator.test.ts:643-682 |
| `Reactive<T>` | erases to `<T>`'s schema, **no marker** (§6.4) | — | capability-wrapper-types.test.ts:118-132 |
| Wrappers / `Default` / scopes / CFC aliases | §6, §7, §10, §11 | — | — |

Fallback sentinel: a primitive-flagged type matching none of the branches emits
`{ type: "string", enum: ["unknown"] }` (`primitive-formatter.ts:125`) — a
silent, mis-typed sentinel; untested and believed unreachable in practice.

## 5. Named-Type Hoisting, `$defs`, And Cycles

### 5.1 All-named policy

Every type with a usable name is hoisted into `$defs` and referenced by
`{ "$ref": "#/$defs/<Name>" }` at non-root occurrences
(`src/schema-generator.ts:373-453`). The emitted container key is `$defs` —
never `definitions` (0 of 73 expected fixtures contain a `definitions` key; 29
contain `$defs`, as of this writing); only the *internal* context field is
still named `definitions` (`interface.ts:24`), and the README's `definitions`
wording predates the migration.

Whether a type gets a name is decided by `getNamedTypeKey`
(`src/type-utils.ts:422-553`). The rule is structural plus two derived name
sets — not the short name list in the README. A type is *excluded* when any of
these holds:

- the type **node** spells a wrapper: `Default`, `Cell`, `Writable`,
  `ReadonlyCell`, `WriteonlyCell`, `ComparableCell`, `OpaqueCell`, `Stream`,
  `SqliteDb` (`:428-437`, sets from `:24-49`; `Reactive` is *not* excluded on
  the node axis);
- the **aliasSymbol** is one of the above or `Reactive` (`:440-447`);
- the name is compiler-internal (`__type`, `__object`) or absent — with an
  aliasSymbol fallback (`:472-477`), so **non-generic aliases to type literals
  hoist under the alias name** (fixture `shared-type`: `type Shared = {…}` →
  `$defs.Shared` + two `$ref`s);
- the symbol is property/method/signature/function/type-parameter-like or an
  enum member
  (`:483-501`);
- the name is `Array`/`ReadonlyArray` (`:503`), a wrapper name by symbol
  (`:504-509`), or in the `NativeTypeFormatter` table (`:511-514`, §5.2);
- the type is a **generic alias instantiation** (`aliasTypeArguments` present:
  `Record<K,V>`, `Partial<T>`, `Box<T>`) (`:520-526`) — inlined, the bare name
  being meaningless without arguments;
- the type is a **generic interface/class instantiation** without an alias name
  (`typeParameters` + `typeArguments` on the reference target) (`:537-550`).

Everything else — interfaces, classes, named aliases, and TS enum declarations
— hoists under its bare symbol name. Enum members stay inline. There is no
source-file qualification and no collision disambiguation for other named
types on the `$defs` key: the first definition stored under a name wins; later
same-named types emit `$ref`s to it (`:397-407`).

### 5.2 Native leaf table

`NATIVE_TYPE_SCHEMAS` (`src/formatters/native-type-formatter.ts:5-28`), as of
this writing: `VNode` →
`{ $ref: "https://commonfabric.org/schemas/vnode.json" }`; `Date` →
`{ type: "string", format: "date-time" }`; `URL` → `{ type: "string", format:
"uri" }`; `ArrayBuffer`/`ArrayBufferLike`/`SharedArrayBuffer`/
`ArrayBufferView`, the eleven typed arrays (`Uint8Array` … `BigUint64Array`),
and `JSONSchemaObj`/`JSONSchema` → `true`.

Guard: the lib-declared subset (`LIB_DECLARED_NATIVE_TYPES`, `:31-49` — `Date`
through `BigUint64Array`) is claimed only when declared in a default-lib or
`@types/node` file (`hasLibraryDeclaration`, `:138-161`), so a user-defined
`interface Date {…}` is not swallowed. `VNode`/`JSONSchemaObj`/`JSONSchema`
have **no** such guard (untested collision). Native resolution also pierces
type-parameter constraints/defaults and intersection constituents
(`getNativeTypeSchema`, `type-utils.ts:360-416`) — where the `Map`/`Set`
rejections live (§15) — and is consulted from union members, intersections,
and object built-in lookup (`union-formatter.ts:147-151`;
`intersection-formatter.ts:34-37`; `object-formatter.ts:209-210`).

### 5.3 Root handling and pruning

Roots stay inline unless the root type already landed in `$defs` *and* was
referenced — then the document becomes `{ $defs: {…}, $ref: "#/$defs/<Root>" }`
(`shouldPromoteToRef`, `src/schema-generator.ts:493-538`; fixture
`recursion-basic`). `$defs` is attached only when at least one `$ref` was
emitted (`:488-491,1019-1022`), pruned to the transitively referenced subset
(`collectReferencedDefinitions`, `:686-744`; traversal skips nested
`$defs`/`definitions` blocks `:710-713`).

### 5.4 Cycles

Two mechanisms: `inProgressNames` — a named type being built emits an
immediate `$ref` on re-entry (`:397-407`) — and `definitionStack`
identity/stack-key detection (`:409-429`), under which anonymous cyclic types
get synthetic `$defs` names `AnonymousType_N` (`ensureSyntheticName`,
`:333-341`; fixture `writable-recursive-todoitem` shows `AnonymousType_1` and
the `$ref`-with-siblings shape `{ "$ref": "#/$defs/AnonymousType_1", "asCell":
["cell"], "default": [] }`).

Stack keys are specialized for `Default` and wrapper reference nodes —
kind + type flags + argument text + file + position instead of type identity
(`createStackKey`, `:286-331`) — because TypeScript reuses one type object for
identical wrapper instantiations at different positions, which would otherwise
create false cycles (fixtures `nested-default-aliases`,
`default-array-recursive`).

**Dead computation (observed implementation note):** every run performs a full
DFS cycle pre-pass (`getCycles`, `:588-658`, using `safe*` wrappers that
`console.warn` and continue) and stores `cyclicTypes`/`cyclicNames` on the
context (`:156-161`; `interface.ts:17-20`) — but nothing reads either set
(grep over `src/` finds writes only). Pure startup cost; a removal candidate.

## 6. Wrapper Types And The `asCell` Vocabulary

### 6.1 Three axes

The wrapper vocabulary is deliberately split (header comment,
`src/typescript/wrapper-names.ts:3-19`):

- **Spelling axis** — `WrapperSpelling` (`wrapper-names.ts:20-31`): every name
  matched syntactically: `Cell`, `Writable`, `ReadonlyCell`, `WriteonlyCell`,
  `ComparableCell`, `OpaqueCell`, `Stream`, `SqliteDb`, `Reactive`,
  `CellTypeConstructor`, `ScopedCellTypeConstructor`.
  `WRAPPER_SPELLING_TO_KIND` (`:38-55`) normalizes spelling → kind — the
  `Writable` → `Cell` normalization lives here, once; the two
  constructor-interface spellings map to `undefined`. Membership sets derive
  from exhaustive `Record<WrapperSpelling, boolean>` tables (`spellingsWhere`,
  `:81-85`), so a new spelling fails compilation at every classification site.
- **Resolved-kind axis** — `CellWrapperKind`
  (`src/typescript/cell-brand.ts:14-22`): `OpaqueCell | Cell | Stream |
  ComparableCell | ReadonlyCell | WriteonlyCell | SqliteDb | Reactive`.
- **Brand axis** — `CellBrand` (`cell-brand.ts:5-12`): the marker strings
  `"opaque" | "cell" | "stream" | "comparable" | "readonly" | "writeonly" |
  "sqlite"` that land in schemas.

Cell detection is **structural, not nominal**: brand marker properties
`CELL_BRAND`/`CELL_INNER_TYPE` (including `__@`-mangled and
computed-property-name declarations) are found via configurable hierarchy
traversal (apparent type, reference targets, base types —
`cell-brand.ts:30-84`, `type-traversal.ts:36-121`), memoized per
(checker, type) in a `TwoLevelWeakCache` (`cell-brand.ts:91-125`). Node-level
detection (`detectWrapperViaNode`/`resolveWrapperNode`,
`type-utils.ts:793-891`) follows alias chains syntactically; **circular alias
chains throw** (`Circular type alias detected: A -> B -> …`, `:854-859`; a
second detection in union alias resolution, `union-formatter.ts:433-438`;
both tested by `circular-alias-error.test.ts`).

### 6.2 Emission

`applyWrapperSemantics` (`common-fabric-formatter.ts:2053-2072`) maps the
resolved kind to a brand (`wrapperKindToBrand`, `cell-brand.ts:171-193`) and
**prepends** one entry to a single `asCell` array on the inner schema:
`Cell` (and the `Writable` spelling) → `"cell"`, `Stream` → `"stream"`,
`OpaqueCell` → `"opaque"`, `ReadonlyCell` → `"readonly"`, `WriteonlyCell` →
`"writeonly"`, `ComparableCell` → `"comparable"`, `SqliteDb` → `"sqlite"`.
Nesting prepends: `Stream<Cell<number>>` → `{ type: "number", asCell:
["stream", "cell"] }` (fixture `stream-of-cell-number`); `Stream<void>` →
`{ asCell: ["stream", "opaque"] }` (fixture `reactive-stream`, via `void` →
opaque). Boolean inner schemas: `true` → `{ asCell: [brand] }`; `false` →
`{ asCell: [brand], not: true }` (`:2041-2045`).

Entry shapes (`packages/api/index.ts:240-258`): `AsCellEntry = CellKind |
{ kind: CellKind; scope?: SchemaScope }`, `CellKind` being the seven brand
strings (`:221-228`). The object form is produced only by scope wrapping
(§10). `Cell<Cell<T>>` → `asCell: ["cell","cell"]` is representable per the
api comment (`api/index.ts:1554-1556`), but no fixture pins direct
cell-in-cell nesting as of this writing; the pinned nested pair is
`["stream","cell"]`.

**No `asStream` / `asOpaque` keys are ever emitted.** Grep over `src/` finds
them only in two stale comments; the api `JSONSchemaObj` has no such members.
The single-array cleanup landed in #3732 (2026-05-29, verified in git), also
the README's last commit. Legacy *readers* of `asStream` survive in
`packages/runner/src/` (`schema.ts`, `traverse.ts`, `link-utils.ts`, …) for
pre-cleanup schemas.

### 6.3 Node/type interplay

- Capability re-wrap fidelity: when a **synthetic** node narrows a capability
  brand (the transformer re-wraps `Cell<T>` as `ReadonlyCell<T>`) and the
  node's own inner degrades to `any`, the resolved type's inner supplies the
  `$ref`/`$defs` fidelity — only for capability kinds
  (`CELL_CAPABILITY_KIND_MAP`, `common-fabric-formatter.ts:53-79`: the five
  cell-capability kinds true; `Stream`/`SqliteDb`/`Reactive` false; exhaustive
  over `CellWrapperKind`). Non-synthetic disagreeing nodes defer to the
  semantic kind (`:291-312,382-429`; tested: capability-wrapper-types "uses
  semantic wrapper kind…" / "allows registered synthetic wrapper nodes…").
- Wrapper unions: a union whose non-null/undefined members are **all** wrappers
  formats member-wise, preserving `{ type: "undefined" }` / `{ type: "null" }`,
  skipping conditional/type-parameter members, deduping identical member
  schemas (`isWrapperUnion`/`formatWrapperUnion`/`maybeWrapInAnyOf`,
  `:2052-2212`). Mixed unions fall to `UnionFormatter`.
- `Cell<Stream<T>>` **throws** with a boxing suggestion, from both the node
  path (`:461-474`) and the type path (`:644-652`); tested (cell-type.test.ts).
- `FactoryInput<T>` (alias-name detection, `:821-826`) formats the inner type
  with `OpaqueCell` semantics, recursively opaque-unwrapping to find target
  wrappers, depth-capped at 10 (`:226-237,766-816`; tested:
  factory-input-real-api).

### 6.4 `Reactive<T>` — no marker (settled)

`Reactive<T>` emits **no wrapper marker of any kind**. Evidence chain:

1. `Reactive<T> = T` is an identity alias (`packages/api/index.ts:1316`) — no
   runtime wrapper, no structural brand, so structural detection cannot see it
   (explicit comment, `common-fabric-formatter.ts:828-834`).
2. Node-level detection deliberately excludes the spelling:
   `NODE_WRAPPER_SPELLINGS.Reactive = false`, comment: "wrapperKindForName has
   never treated it as a node wrapper" (`type-utils.ts:56-72`).
3. The one mapping that *would* emit a marker —
   `wrapperKindToBrand("Reactive") → "opaque"` (`cell-brand.ts:174-177`) — is
   unreachable: no detection path produces kind `"Reactive"`
   (`brandToWrapperKind`, `cell-brand.ts:150-169`, never returns it;
   `resolveWrapperNode` cannot).
4. Guard test: `capability-wrapper-types.test.ts:118-132` asserts
   `Reactive<{foo: string}>` yields the inner object schema with neither
   `asCell` nor `asOpaque`; fixture `reactive-stream` shows
   `Reactive<LLMState>` emitting a plain `$ref: "#/$defs/LLMState"`.

Hoisting nuance: `getNamedTypeKey` suppresses a key when the aliasSymbol
survives as `Reactive` (`type-utils.ts:440-447`); commonly the checker resolves
the identity alias to the inner type object itself (no aliasSymbol), so inner
named types still hoist, as the fixture shows. The ts-transformers behavior
spec §12 uses the same single-`asCell` vocabulary. Any doc claiming `Reactive`
emits `asCell: ["opaque"]` is wrong on this tree.

## 7. `Default<T,V>` And `DeepDefault<V>`

`Default` detection is two-axis: node references named `Default` (fast path on
identifier text, alias chains followed — `isDefaultTypeRef`,
`type-utils.ts:752-780`) and, when the checker erased the node, the type's
aliasSymbol — the latter **source-checked** to `packages/api/index.ts` /
`@commonfabric/api` / `commonfabric.d.ts` (`isDefaultAliasSymbol`,
`property-optionality.ts:61-74`), so a user type merely *named* `Default` does
not take the alias path. (Contrast §11: CFC detection has no source check.)

**V extraction**, in priority order:

1. **Node-based** (`extractDefaultValueFromNode` + expression walk,
   `common-fabric-formatter.ts:1792-2039`; union-side twin
   `union-formatter.ts:818-990`): literal nodes, tuple nodes, object-literal
   type nodes, `Record<K, never>` → `{}`, and `typeof CONST` queries resolved
   through import aliases to the variable initializer (unwrapping
   `as`/`satisfies`/parens/type assertions; shorthand properties via
   `getShorthandAssignmentValueSymbol`).
2. **Brand-payload fallback**: `Default<T,V>` carries V in a
   `DEFAULT_MARKER`-branded payload; when the alias is resolved away
   (`T | (T & DefaultMarker<V>)`), the payload is read back type-structurally
   (`type-utils.ts:894-1059`). Union-distributed brands must **agree**;
   disagreement bails to no-default (`:1030-1048`). Tested:
   brand-payload-defaults.test.ts (12 tests).

`default` may sit as a sibling of `$ref` (Draft 2020-12 rationale in comment,
`common-fabric-formatter.ts:945-947`); boolean schemas become `{ default }` /
`{ not: true, default }` (`:948-955`).

**Union rules** (`union-formatter.ts:110-129,255-588`):

- At most one `Default<>` member per union — more **throws** (`:330-334`).
- A default whose type is assignable to another member does not re-emit the
  `Default`'s T as a branch (`isDefaultCoveredByUnion`, `:518-530,371-375`).
- An object default that would *widen* an existing object member **throws**,
  pointing at `DeepDefault` (`:532-554`).
- `DeepDefault<V>` requires an object target and object default (else
  **throws**, `:556-574`), then applies nested per-property defaults, resolving
  through local `$refs` and single-object-candidate `anyOf`s; unknown keys
  **throw** (`:666-786`).
- Expanded empty-array arms (`[]`/`never[]`) riding along expanded
  array-Defaults are pruned when a real array member exists, preserving element
  capabilities; an explicit comment notes this is safe only while arrays carry
  no length bounds (CT-1639; `:271-293,383-395`).
- `Default<undefined>` (1-arg) **throws** at both sites
  (`common-fabric-formatter.ts:914-918`; `union-formatter.ts:497-501`); arity
  outside 1..2 throws (`cff:901-903`; `uf:461-463,484-486`).

**Optionality interplay:** `Default<T | undefined, V>` makes the property
non-required (`isDefaultNodeWithUndefined`, `property-optionality.ts:21-48`,
consulted at `object-formatter.ts:279-294`). Plain `T | undefined` does *not*
remove the property from `required`, but optional symbols (`?`) get
`| undefined` stripped from checker-resolved types (`safeGetPropertyType`,
`type-utils.ts:174-323`, union-order-insensitive comparison); a union-merged
result may still carry `type: ["number","undefined"]` (§8; fixture
`default-with-undefined-union`). Shared-definition safety: different defaults
on two uses of one named type do not mutate the shared `$defs` entry (tested:
defaults-no-def-mutation.test.ts).

## 8. Unions

`UnionFormatter` (`src/formatters/union-formatter.ts:87-237`), after the
Default paths of §7:

- **Nullable special case**: exactly one non-null member + `null` →
  `{ anyOf: [<member>, { type: "null" }] }` — `anyOf` over `oneOf`
  deliberately (comment `:160-165`). Emission order is member-first; goldens
  may show null-first because the test normalizer canonicalizes nullable
  `anyOf` pairs (`test/utils.ts:454-466`).
- **All-literal unions** → `{ enum: [...] }` with **no `type` key**; `null`
  joins the enum when present; `undefined` never does (it forces the anyOf
  path); the exact pair `true | false` re-collapses to `{ type: "boolean" }`
  (`:176-214`). This is also what TS enums hit (§4).
- **`{ type: "undefined" }` preservation**: undefined members are kept, not
  stripped (`:132-135`).
- **General case** → `anyOf` with **primitive merging**
  (`mergePrimitiveSchemaIntoAnyOf`, `:1035-1122`): a `true` member
  short-circuits the union to `true`; `false` members drop; exact-JSON
  duplicates drop; same-`type` enum schemas merge enum sets (sorted); enum +
  bare same-`type` → bare type; bare primitive types merge into sorted
  **`type` arrays** — how `string | undefined` becomes
  `{ type: ["string","undefined"] }` (fixture `default-with-undefined-union`).
  Singletons unwrap (`:232-234`).
- **`widenLiterals`** additionally merges structurally-identical-modulo-enum
  member schemas before the anyOf pass (`mergeIdenticalSchemas`,
  `:220-222,1001-1029,1179-1246`). It does **not** reach the all-literal path:
  `"a" | "b"` still emits `{ enum: ["a","b"] }` under `widenLiterals: true`
  (probe; the branch at `:176-214` runs first and never consults the flag).
- Member nodes re-associate with semantic members order-insensitively
  (`orderMemberNodesBySemanticType`, `:57-78`) — the checker canonicalizes
  union order. Union alias nodes resolve through non-generic alias
  declarations to recover member nodes (`getUnionTypeNode`, `:397-441`).
  Empty unions **throw** (`:106-108`).

## 9. Intersections

`IntersectionFormatter` (`src/formatters/intersection-formatter.ts`):

- Cell-branded intersections are declined (`:21-27`); native resolution runs
  first (`:34-37`); empty intersections throw (`:41-45`).
- Brand-only (all `__@`-keyed) and empty-object constituents are filtered
  before validation (`:47-64,90-122`); a single survivor delegates directly
  (`:62-64`).
- Unsupported shapes — non-object constituent, constituent with an index
  signature, or a checker error — produce a **permissive fallback, not a
  throw**: `{ type: "object", additionalProperties: true, $comment:
  "Unsupported intersection pattern: <reason>" }` (`:66-76,124-151`).
- Property merge is **first-wins** (no schema merging); conflicting property
  descriptions keep the first + `$comment` + logger warning (`:183-213`);
  `required` is unioned (`:215-219,227-229`); `$ref` constituents resolve
  through `context.definitions` (`:244-263`).
- Constituent-level JSDoc joins with `\n\n` plus provenance `$comment`s ("Docs
  inherited from intersection constituents." / "Sources: …" / "Missing docs
  for: …") (`:265-321`; descriptions-intersection-* fixtures ×7).

## 10. Scope Wrappers

`PerSpace` / `PerUser` / `PerSession` / `PerAny` (api: optional
`SCOPE_BRAND`-typed intersections, `packages/api/index.ts:260-269`) lower to a
`scope` key with values `"space" | "user" | "session" | "any"`
(`SCOPE_WRAPPER_SCOPES`, `common-fabric-formatter.ts:31-36`). Detection is by
node name or aliasSymbol name (`:81-92,122-131,182-206`). Placement
(`applyScopeWrapperSemantics`, `:506-529`): if the inner schema has a
non-empty `asCell`, the scope merges into the **first** entry, turning a
string entry into the object form (`applyScopeToAsCellEntry`, `:94-105`) —
`PerUser<Cell<string>>` → `{ asCell: [{ kind: "cell", scope: "user" }], type:
"string" }`; otherwise a bare sibling key — `PerUser<string>` →
`{ type: "string", scope: "user" }`. A nested scope **without an intervening
cell boundary throws** (`Nested scope wrappers require a cell boundary between
scopes.`, `:522-527`; tested, scope-wrappers.test.ts). With a cell boundary
both survive: `PerUser<Cell<PerSession<string>>>` → `{ asCell: [{ kind:
"cell", scope: "user" }], scope: "session", type: "string" }` (fixture
`scoped-wrappers`).

## 11. CFC Alias Lowering (`ifc` Metadata)

The canonical authoring surface contains 18 names. The inventory is
`CFC_CANONICAL_ALIAS_NAMES` (`packages/api/cfc.ts`), consumed by
`CommonFabricFormatter`. Sixteen aliases lower the wrapped value and attach an
`ifc` payload; `AnyOf` and `PolicyOf` are label-expression markers interpreted
inside those payloads.

| Alias | `ifc` payload |
| --- | --- |
| `Cfc<T, M>` | spread of the record literal `M` (non-record → no metadata) |
| `Confidential<T, C>` | `{ confidentiality: C }` |
| `Integrity<T, I>` | `{ integrity: I }` |
| `AddIntegrity<T, I>` | `{ addIntegrity: I }` |
| `RepresentsCurrentUser<T>` | `{ addIntegrity: [{ kind: "represents-principal", subject: { __ctCurrentPrincipal: true } }] }` |
| `AuthoredByCurrentUser<T>` | `{ addIntegrity: [{ kind: "authored-by", subject: { __ctCurrentPrincipal: true } }] }` |
| `RequiresIntegrity<T, I>` | `{ requiredIntegrity: I }` |
| `MaxConfidentiality<T, C>` | `{ maxConfidentiality: C }` |
| `AnyOf<X>` | when nested in an IFC label tuple, one atom `{ anyOf: X }` |
| `PolicyOf<typeof rules>` | when nested in an IFC label tuple, a policy atom carrying a compile-time module-binding marker; the ts-transformer resolves it to `{ type, policyRefKind: "module", subject, moduleIdentity, symbol, policyDigest }` |
| `WriteAuthorizedBy<T, typeof b>` | `{ writeAuthorizedBy: { __ctWriterIdentityOf: { file, path: [binding], moduleIdentity? } } }` (`:1444-1539`) |
| `TrustedActionWriteWithIntegrity<…>` | writeAuthorizedBy metadata + `uiContract { helper: "UiAction", action, trustedPattern, requiredEventIntegrity }` (`:1340-1347,1455-1478`) |
| `TrustedActionWrite<…>` | same, with `requiredEventIntegrity` defaulting to `[trustedPattern]` (`:1349-1358`) |
| `TrustedActionUiContract<…>` | `{ uiContract: { helper: "UiAction", action, trustedPattern, requiredEventIntegrity? } }` (`:1359-1371`) |
| `ExactCopy<T, S>` | `{ exactCopyOf: S }` |
| `ProjectionPath<T, F, P>` | `{ projection: { from: F, path: P } }` (`:1397-1402`) |
| `ProjectionOf<T, P>` / `Projection<T, P>` | `{ projection: { from: "/", path: P } }` (`:1403-1414`) |

Mechanics:

- Detection is **canonical-name keyed** — `CFC_ALIAS_NAMES.has(aliasName)`.
  Imported aliases are resolved back to their exported name, so renamed
  imports of `AnyOf` / `PolicyOf` work. A local declaration using a canonical
  name also lowers; unlike `Default`, there is no declaring-package guard
  (§7), so name collisions remain an untested foot-gun.
- User alias chains are followed with type-parameter node substitution until a
  canonical name is reached (`resolveCfcAliasFromDeclaration` /
  `substituteTypeNode`, `:1092-1287`); unresolvable expansions fall back to
  ordinary generation (tested).
- Metadata values come from type-level literals: literal nodes, tuples, type
  literals, `typeof` value reads, alias-parameter substitution, and
  tuple/object **types** via the checker when nodes are gone
  (`extractLiteralLikeValue`, `:1592-1789`). That extraction recognizes
  `AnyOf<X>` as
  `{ anyOf: X }` and `PolicyOf<typeof rules>` as a policy atom containing
  `__ctPolicyIdentityOf: { file, path }`. Projection paths encode as JSON
  Pointers with `~0`/`~1` escaping (`encodeJsonPointerPath`, `:1572-1590`).
- `ifc` merges shallowly into the base schema's existing `ifc`
  (`mergeIfcMetadata`, `:1554-1570`); boolean schemas become `{ ifc }` /
  `{ not: true, ifc }`.
- `WriteAuthorizedBy` writer identity resolves through import aliases to the
  declaring file. A transformer caller supplies
  `writerIdentityForSourceFile`, which maps that compile name to its authored
  spelling and can attach the defining source's content-addressed
  `moduleIdentity`; the runner supplies both, so engine-minted claims are born
  stamped. A transformer identity map that omits the defining source is a
  compile error, rather than a silent downgrade to an unstamped claim.
  Standalone schema-generator callers that omit the callback retain
  the legacy fallback (backslashes → `/`, first path segment stripped by
  `normalizeWriterIdentityFile`). The transformer also handles the direct-root
  `toSchema<WriteAuthorizedBy<T, typeof b>>()` form specially so the wrapper's
  value schema remains the root while the same identity marker is attached.
- `SchemaGeneratorTransformer.resolvePolicyOfMarkers` replaces a valid policy
  marker with the compiled module identity, exported symbol, and policy digest.
  If it cannot match a compiler-verified exported `exchangeRules()` binding,
  it reports a `cfc-policy-of` diagnostic and leaves the marker unresolved.
- `uiContract` also arrives via the hints channel (§13), produced by
  `ts-transformers/src/transformers/ui-helper-lowering.ts:219`.

In-package coverage: `test/schema/cfc-authoring.test.ts` (13 tests), including
renamed `AnyOf` / `PolicyOf` imports. Transformer-side policy compilation and
diagnostics are pinned by `packages/ts-transformers/test/cfc-authoring.test.ts`.

The collection/opaque helpers `LengthPreservedFrom`, `FilteredFrom`,
`SubsetOf`, `PermutationOf`, and `OpaqueInput` were removed from
`@commonfabric/api/cfc`: the runner rejects those unsupported IFC keys
fail-closed. A hand-authored `Cfc<T, M>` still structurally passes through an
arbitrary record `M`; that low-level escape hatch does not make the removed
helpers part of the supported authoring surface.

The emitted key set aligns with the api's `JSONSchemaObj.ifc` member
(`packages/api/index.ts`): `confidentiality`, `integrity`,
`addIntegrity`, `requiredIntegrity`, `maxConfidentiality`, `ownerPrincipal`,
`writeAuthorizedBy`, `exactCopyOf`, `projection`, `observes`, and `uiContract`.
`ownerPrincipal` and `observes` have no direct producing alias in this package
as of this writing.
The api type also declares `[ID]`/`[ID_FIELD]` extension keys
(`api/index.ts:1639-1640`); this package never emits them (grep).

## 12. Doc Comments → `description` / `tags` / `$comment`

- Root: JSDoc from the type's alias and/or direct symbol attaches as
  `description` when the schema lacks one (`attachRootDescription`,
  `src/schema-generator.ts:664-679`; `extractDocFromType`,
  `doc-utils.ts:110-139`).
- Properties: symbol + declaration docs; `@tag` lines stripped; among multiple
  JSDoc blocks the nearest-to-declaration wins (sorted by position descending,
  `doc-utils.ts:40-68`); conflicts keep the first + `$comment: "Conflicting
  docs across declarations; using first"` + logger warning
  (`object-formatter.ts:302-321`).
- **Declaration-file exclusion**: docs from `.d.ts` declarations are ignored
  unless the symbol also has a non-declaration-file declaration
  (`doc-utils.ts:84-97`) — lib docs do not leak into schemas.
- Index signatures and intersection constituents have their own attachment
  points (§4 table; §9).
- Hashtags in any attached description mirror into a `tags` array —
  lowercased, deduped, first-seen order (`attachDocTags`, `doc-utils.ts:10-16`
  → `extractHashtags`, `packages/data-model/src/schema-tags.ts:25-32`; api
  field `index.ts:1573-1575`). Fixtures: descriptions-hashtag-tags,
  descriptions-index-signature-tags, descriptions-root-with-tags.

## 13. The Hints Channel (`schemaHints`)

Hint shape (`src/interface.ts:46-60`): `WeakMap<ts.Node, { items?: unknown;
cfcUiContract?: { helper: "UiAction" | "UiPromptSlot" | "UiDisclosure";
action?; surface?; role?; kind?; trustedPattern?; requiredEventIntegrity? } }>`.
Lookups always try the node and `ts.getOriginalNode(node)`
(`schema-generator.ts:548-549`; `object-formatter.ts:410-411`; the producer
writes both — `cross-stage-state.ts:150-163`).

- **`items: false`** — array-typed wrapper contents collapse to
  `items: { type: "unknown", …element wrapper markers }` for property-only
  access patterns (e.g. `.length`), preserving the outer wrapper without
  materializing item schemas. Element capability is recovered from the element
  node or type; for expanded `Default<[]> | Item[]` unions it is recovered by
  descending the synthetic union **node** to the single real array member,
  since the resolved type cannot express it (CT-1639 Gap B)
  (`common-fabric-formatter.ts:431-443,605-736`; consumed at
  `array-formatter.ts:20-25` via `context.arrayItemsOverride`,
  `interface.ts:61-62`). Tested: capability-wrapper-types ×2.
- **`cfcUiContract`** attaches `ifc.uiContract` at three layers: generation
  root (`applyNodeSchemaHints`/`attachUiContract`,
  `schema-generator.ts:540-583`), the `$UI` property inside objects
  (`object-formatter.ts:322-328,394-440`), and post-hoc in the transformer
  against the emitted literal
  (`ts-transformers/.../schema-generator.ts:118-125,245-345`, preferring an
  existing `$UI` property when present).

## 14. Options

Exactly one generation option exists as of this writing: `widenLiterals`
(`interface.ts:43-44`, plumbed at `schema-generator.ts:181`). Effects:
(1) single literal types emit bare base types instead of one-value enums
(`primitive-formatter.ts:44-79`; bigint literals → `{ type: "integer" }`);
(2) structurally-identical-modulo-enum union members merge recursively
(`union-formatter.ts:220-222,996-1246`). It does **not** widen all-literal
unions (§8) and has no other effects. `test/widen-literals.test.ts` pins the
in-package behavior; consumer-side it is extracted from `toSchema` options and
exercised via ts-transformers' injection paths
(`ts-transformers/.../schema-generator.ts:67-82`).

## 15. Fail-Loud Inventory And Silent Degradations

Everything that throws, with source (test-pinned unless noted):

| Condition | Message (prefix) | Source |
| --- | --- | --- |
| No formatter matches a type | `No formatter found for type: …` | `schema-generator.ts:470-474` (untested) |
| `Map`/`WeakMap` | `… not JSON-serializable … Use Record<string, V> …` | `type-utils.ts:400-405` |
| `Set`/`WeakSet` | `… Use Array<T> instead.` | `type-utils.ts:406-411` |
| `Cell<Stream<T>>` | `Cell<Stream<T>> is unsupported. Wrap the stream: …` | `common-fabric-formatter.ts:470-473,644-652` |
| `Default<undefined>` (1-arg) | `Default<undefined> is unsupported; …` | `common-fabric-formatter.ts:914-918`; `union-formatter.ts:497-501` |
| `Default` arity ≠ 1..2 / missing args | `Default<T,V> requires 1 or 2 type arguments` | `cff:901-910`; `uf:484-492` |
| `DeepDefault` arity ≠ 1 | `DeepDefault<V> requires exactly 1 type argument` | `union-formatter.ts:461-463` |
| >1 `Default<>` member in a union | `Union types may contain at most one Default<> member.` | `union-formatter.ts:330-334` (indirectly tested) |
| Object default widening an object member | `Default object union member is not assignable …` | `union-formatter.ts:551-553` |
| `DeepDefault` without object target/default | `DeepDefault must be unioned with an object type …` | `union-formatter.ts:571-573` |
| `DeepDefault` unknown key | `DeepDefault key "…" does not exist on the target object type.` | `union-formatter.ts:703-709` |
| Nested scope wrappers | `Nested scope wrappers require a cell boundary between scopes.` | `common-fabric-formatter.ts:522-527` |
| Circular type alias (wrapper chain) | `Circular type alias detected: A -> B -> …` | `type-utils.ts:854-859` |
| Circular type alias (union alias) | `Circular type alias detected: <name>` | `union-formatter.ts:433-438` |
| Wrapper/scope/CFC alias without type argument | `<Kind><T> requires type argument` | `cff:195-198,396-398,485-487,579-583,969-971,997-999` (untested) |
| Internal invariants: empty union/intersection; CommonFabric claimed-but-unformattable terminal; ArrayFormatter element-info mismatch | `… received empty … type` / `Unexpected Common Fabric type: …` / `… indicates a bug in supportsType logic` | `union-formatter.ts:106-108`; `intersection-formatter.ts:41-45`; `common-fabric-formatter.ts:376-379`; `array-formatter.ts:33-43` (all untested) |

Silent degradations: `safe*` wrappers `console.warn` and continue
(`type-utils.ts:113-169,199-205`); type parameters / conditionals → `{}` (§4);
conditional/type-parameter wrapper-union members skipped (`cff:2135-2144`);
synthetic node resolution failure → `any` → `true`
(`schema-generator.ts:950-958`); unsupported intersections → permissive object
+ `$comment` (§9); the `{ type: "string", enum: ["unknown"] }` sentinel (§4);
`applyWrapperSemantics` with an unmappable kind returns the schema unchanged
(`cff:2057-2061`).

## 16. Known Limits And Observed Quirks

1. **Tuples lose positional structure** — no `prefixItems`/length bounds (§4);
   the empty-array-pruning safety argument (`union-formatter.ts:280-285`)
   explicitly depends on this. Sub-wart: `[string, number?]` leaks
   `"undefined"` into `items.type`. Pinned by `test/tuple-emission.test.ts`.
   Adoption note: the runner already consumes `prefixItems`
   (`cfc.ts:528-536`, traversal in `cfc/schema-refs.ts:81` /
   `schema-merge.ts:272`) and the api dialect declares it — emission here is
   the missing half, gated on the pruning-safety argument above.
2. **TS enums** — whole enum declarations hoist `{ enum: […] }` defs with no
   `type` key; individual enum-member types stay inline to avoid `$defs` name
   collisions. Pinned by `test/enum-member-hoisting.test.ts` +
   `test/enum-schema-rows.test.ts`.
3. **`widenLiterals` is incoherent at the literal-union boundary** (§14;
   pinned by `test/widen-literals.test.ts`): all-literal unions stay enums
   under the flag while the same literals DO widen inside mixed unions, and a
   single-literal property widens next to an unwidened literal-union sibling.
   Compounding: `generateSchemaFromSyntheticTypeNode` takes no options, so
   the flag is silently dropped whenever the consumer routes node-based; and
   the transformer-side `widenLiteralType` (same name, schema-injection
   pre-widening) DOES widen literal unions — the two mechanisms disagree.
   Decide the policy (including nested enum-typed properties) before changing
   the in-package behavior.
4. **bigint → `integer` via `Number`** — silent precision loss above 2^53
   (§4, probe); untested.
5. **CFC alias detection is name-keyed**, no source check (§11); untested
   collision case.
6. **`VNode`/`JSONSchema*` lack the lib-declaration guard** (§5.2); untested.
7. **Node/type literal-encoding divergence** (`const` vs `enum`, §2).
8. **Dead cycle pre-pass** (§5.4).
9. **Stale `$schema` doc-comments** (`schema-generator.ts:195,488,1006`); no
   code path emits `$schema` (grep).
10. **Transformer merge wart** — options spread twice, before and after
    uiContract/writeAuthorizedBy attachment
    (`ts-transformers/.../schema-generator.ts:117,134`); idempotent for
    literal options.
11. **`plugin.ts` hint-type drift** (§2).
12. **Untested helper modules** — `typescript/property-name.ts`,
    `property-optionality.ts`, `type-traversal.ts`, `wrapper-names.ts` have no
    dedicated unit tests (`test/typescript/` holds one cell-brand test);
    exercised indirectly through ts-transformers suites.
13. **Primitive fallback sentinel** (§15) — silent, mis-typed, untested.

## 17. Test Workflow

- `deno task test` from `packages/schema-generator/` (env knobs allow-listed
  in `deno.jsonc:16-21`); `deno task check` type-checks source, harnesses, and
  test suites while excluding raw fixture inputs. Those inputs depend on the
  synthetic declarations supplied by the fixture runner and are checked there.
- **Fixture runner** (`test/fixtures-runner.test.ts`): drives
  `test/fixtures/schema/*.input.ts` → `*.expected.json`; the root type is the
  fixture's `SchemaRoot` (`:22`). Env knobs: `FIXTURE=<baseName>` filter
  (`:26,96-101`); `UPDATE_GOLDENS=1` rewrites goldens
  (`packages/test-support/src/fixture-runner.ts:119`); `SKIP_INPUT_CHECK=1`
  disables the default batch type-check of all inputs in one program — type
  errors otherwise fail the suite before any comparison (`:36-90`).
- **Normalization caveat**: goldens are normalized — object keys sorted,
  `required`/`enum` arrays sorted, nullable-`anyOf` pairs reordered null-first
  (`test/utils.ts:421-499`) — so golden JSON ordering is not emission ordering.
- Fixture inputs compile against a synthetic prelude declaring the wrapper
  interfaces with `CELL_BRAND` markers, `Reactive<T> = T`, `Writable<T> =
  Cell<T>`, and the scope wrappers (`test/utils.ts:9-33`); `Default` is
  declared per-fixture (e.g. `default-type.input.ts:1`), relying on §7's
  name-based node detection. The `commonfabric.d.ts` filename accepted by
  `isDefaultAliasSymbol`/property-name serves consumer test environments that
  register api types under that synthetic path.
- **Cross-package pinning**: the ts-transformers `schema-transform` and
  `schema-injection` fixture suites (ts-transformers behavior spec §12 and §20)
  exercise this package end-to-end through `SchemaGeneratorTransformer`;
  changes here surface as golden diffs there.
- In-package unit suites (as of this writing): brand-payload-defaults, plugin,
  enum-member-hoisting, enum-schema-rows, intersection-formatter,
  literal-encoding-paths, native-type-parameters, schema-generator,
  scope-wrappers, tuple-emission, widen-literals, typescript/cell-brand, and the
  `test/schema/` family
  (arrays, booleans, capability wrappers, cell types, CFC authoring, circular
  aliases, defaults ×5, factory inputs, nested wrappers, records/mapped types,
  recursion, aliases, type-to-schema, void).

## 18. Sources Of Truth

When a section above enumerates a set, the constant/function below is
canonical; update prose from it, not the other way around. Paths relative to
`packages/schema-generator/` unless noted.

| Spec content | Canonical source | Guard / note |
| --- | --- | --- |
| Formatter chain + order (§3) | `SchemaGenerator.formatters` (`src/schema-generator.ts:35-44`) | array literal is the order; routing tests in `test/schema-generator.test.ts` |
| Core keyword mappings (§4) | `PrimitiveFormatter.getSchemaType` (`src/formatters/primitive-formatter.ts:37-126`); node table `analyzeTypeNodeStructure` (`src/schema-generator.ts:925-948`) | void-type / array-special-types tests |
| Hoisting exclusion rule (§5.1) | `getNamedTypeKey` (`src/type-utils.ts:422-553`) | recursion/shared-type/alias fixtures |
| Native leaf table + guard (§5.2) | `NATIVE_TYPE_SCHEMAS` / `LIB_DECLARED_NATIVE_TYPES` (`src/formatters/native-type-formatter.ts:5-49`) | `test/native-type-parameters.test.ts` |
| Wrapper spellings + normalization (§6.1) | `WrapperSpelling` / `WRAPPER_SPELLING_TO_KIND` (`src/typescript/wrapper-names.ts:20-55`) | compile-time exhaustiveness (`:57-64`) |
| Node-wrapper participation (§6.1, §6.4) | `NODE_WRAPPER_SPELLINGS` (`src/type-utils.ts:60-72`) | compile-time table |
| Brand values / kind↔brand maps (§6.2) | `CellBrand` / `wrapperKindToBrand` (`src/typescript/cell-brand.ts:5-12,171-193`) | capability-wrapper-types tests |
| Capability-kind subset (§6.3) | `CELL_CAPABILITY_KIND_MAP` (`src/formatters/common-fabric-formatter.ts:68-77`) | exhaustive over `CellWrapperKind` |
| `asCell` entry shape (§6.2, §10) | `AsCellEntry` / `CellKind` / `SchemaScope` (`packages/api/index.ts:240-258`) | — |
| Scope wrapper map (§10) | `SCOPE_WRAPPER_SCOPES` (`src/formatters/common-fabric-formatter.ts:31-36`) | scoped-wrappers fixture |
| CFC alias set (§11) | `CFC_CANONICAL_ALIAS_NAMES` (`packages/api/cfc.ts:765-784`) | — |
| CFC payload map (§11) | `buildIfcMetadataForAlias` switch (`src/formatters/common-fabric-formatter.ts:1292-1392`) | cfc-authoring tests |
| `ifc` key vocabulary (§11) | `JSONSchemaObj.ifc` (`packages/api/index.ts:1648-1678`) | — |
| Hint shape (§13) | `GenerationContext["schemaHints"]` (`src/interface.ts:46-60`) | note plugin.ts drift (§2) |
| Generation options (§14) | `GenerationContext["widenLiterals"]` (`src/interface.ts:43-44`) | sole option as of this writing |
| Throw inventory (§15) | grep `throw new Error` under `src/` | messages quoted above verified this snapshot |
| Fixture env knobs (§17) | `test/fixtures-runner.test.ts:26-101`; `packages/test-support/src/fixture-runner.ts:119` | — |

A drift-resistant habit (mirroring the ts-transformers spec §21.1): when
editing a set above, update this document from the canonical source and keep
prose lists labeled "as of this writing."
