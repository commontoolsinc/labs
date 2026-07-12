# First-Class Serializable Factories

## Status

Proposed. This document specifies intended behavior, not the current
implementation.

The ordered execution checklist is
[First-Class Serializable Factories — Implementation Plan](../../plans/first-class-serializable-factories.md).

The content-addressed identity prerequisite is shipped: every verified,
module-scoped builder factory is addressable by `{ identity, symbol }`.
Exports use their export name, while transformed and non-exported factories use
their `__cfReg` name. See
[Content-Addressed Action Identity](../content-addressed-action-identity.md).

One prerequisite is not yet on `main`: generic `$patternRef` binding and direct
setup/sub-pattern resolution. The relevant semantic changes currently live in
the work behind #4514, including commits `3b028c786`, `39b213e63`, and
`ede6c5a7d`. This feature must copy or reimplement that small behavior and its
tests as Stage 0. It must not wait for, or import the unrelated reactive-
interpreter work in that PR.

This is an independent pattern-construction track. It does not depend on graph
snapshots or the reactive-interpreter migration.

## Summary

Every builder factory gets the same internal factory protocol, and every
factory with a cold-resolvable content-addressed artifact ref becomes a durable
first-class Fabric value:

- `PatternFactory` returned by `pattern`;
- `ModuleFactory` returned by `lift`, `byRef`, and other node-factory builders;
  and
- `HandlerFactory` returned by `handler`.

The callable function itself carries an internal Fabric-factory brand and
codec-state accessor. It serializes as `Factory@1` and decodes to a callable,
reference-backed factory shell. There is no `FabricPatternFactory` or
`NodeFactory` wrapper object. Arbitrary JavaScript functions remain invalid
Fabric values.

Patterns additionally gain lexical closure conversion. A nested authored
`pattern(...)` is hoisted to module scope. Its callback receives public input as
argument 0 and its captured environment as compiler-generated argument 1. At
the authored site, the transformer calls an internal, one-shot
`.curry(params)` method on the hoisted factory.

That method is not public API. It always binds callback argument 1, takes no
argument index, and throws if called twice. It never binds, merges, removes, or
overrides fields in the pattern's public input. Authors express another layer
of partial application by defining another inline pattern closure, just as
they would curry a JavaScript function by defining another closure.

This representation replaces `patternTool` and its `{ pattern, extraParams }`
protocol. An inline pattern closes over the values to bind, and the resulting
`PatternFactory` is itself the tool value.

## Terminology

- **Factory**: a callable builder value of kind `pattern`, `module`, or
  `handler`.
- **Base factory**: the trusted module-scoped artifact identified by a content-
  addressed factory ref.
- **Factory state**: the codec-visible, non-public essential state of a factory,
  including its ref, kind, schemas, modifiers, and optional pattern params.
- **Public input**: argument 0 of a pattern callback and the value supplied by a
  pattern caller.
- **Closure params**: the complete captured environment in compiler-generated
  pattern callback argument 1.
- **Bound pattern**: a derived `PatternFactory` whose hidden factory state
  contains closure params.
- **Symbolic factory binding**: a builder-time reactive alias or link to a Cell
  that contains the current factory value. It is not a second factory wire
  representation, and the graph stores the binding rather than snapshotting
  the currently selected factory ref.
- **Materialized factory argument**: the ordinary live callable supplied by the
  runner when an `asFactory` value crosses a scheduled runtime callback
  boundary, such as a `lift` implementation or handler invocation.
- **Artifact source space**: trusted runner provenance identifying the space
  from which a cold factory artifact may be loaded. It is distinct from a
  pattern factory's `spaceSelector`, which chooses the child's execution
  target.

## Current State and Gaps

All three factory kinds are already callable function objects with useful
descriptor state:

- `PatternFactory.toJSON()` emits `$patternRef`, `argumentSchema`, and
  `resultSchema` at the storage boundary.
- `ModuleFactory.toJSON()` and `HandlerFactory.toJSON()` emit module
  descriptors, using `$implRef` for addressable JavaScript implementations.
- `asScope()` and `PatternFactory.inSpace()` return derived callable factories.
- verified exports and `__cfReg` values already enter the generic artifact
  index, regardless of factory kind.

The existing `toJSON()` path is a one-way conversion. Native conversion calls
`toJSON()` on a function and replaces the function with inert plain data.
Generic reads do not recreate a callable factory. Pattern-valued list builtins
and LLM tools compensate with bespoke `$patternRef` handling.

Serialization alone also does not make a symbolic factory callable. Pattern
inputs are non-callable reactive proxies. Calling a factory-valued input as
ordinary JavaScript therefore fails while constructing the outer graph. The
runner already permits a reactive `NodeRef.module`, but its dynamic-module arm
is unfinished. This proposal completes that path and adds type-directed call
lowering.

Pattern construction has two further limitations:

1. `pattern()` currently calls its callback with one symbolic root and only
   recognizes `argument` and `result` alias roots.
2. Nested-pattern hoisting is limited to special `*WithPattern` and
   `patternTool` shapes. There is no general lexical closure conversion for a
   pattern returned or passed as data.

## Goals

1. Let every content-addressed factory kind round-trip through cells, pieces,
   arrays, objects, CLI/FUSE boundaries, and cross-space links without losing
   its factory kind or callability.
2. Let patterns accept, return, store, and invoke factory values with ordinary
   call syntax.
3. Preserve nested-pattern lexical semantics by making captures explicit,
   reactive closure params.
4. Keep pattern public input completely separate from closure params.
5. Use the existing content-addressed artifact identity and resolution model.
6. Preserve schemas, CFC labels, scope, and pattern space-selection behavior.
7. Replace `patternTool` and the separate params-merging rules around it.
8. Keep transformed output, serialization, hashing, and equality deterministic.

## Non-goals

- Serializing arbitrary JavaScript functions or native lexical closures.
- Exposing `.curry()` or another partial-application API to authors.
- General positional currying or repeated currying.
- Narrowing a factory's public input schema by binding public fields.
- Executing factory implementation code during decode or property access.
- Making keyless, action-created, or host-pseudo-module factories durable. A
  cross-session factory needs a trusted content-addressed module ref; a
  session-only pseudo-ref has no cold reconstruction path.
- Putting tool descriptions, observation policy, or other LLM metadata in
  `Factory@1`.
- Depending on graph snapshots.

## Author-Facing Semantics

### Factories are values

Factory types are valid fields in pattern inputs and outputs and remain
invokable after storage or transport.

```ts
// Shown for illustration only.
interface ApplyInput {
  value: string;
  operation: PatternFactory<
    { value: string },
    { result: string }
  >;
}

const apply = pattern<ApplyInput>(({ value, operation }) => {
  return operation({ value });
});
```

The same applies to modules and handlers:

```ts
// Shown for illustration only.
interface FactoryInputs {
  value: string;
  transform: ModuleFactory<{ value: string }, { length: number }>;
  select: HandlerFactory<{ source: string }, { id: string }>;
}

const useFactories = pattern<FactoryInputs>(({
  value,
  transform,
  select,
}) => ({
  transformed: transform({ value }),
  onSelect: select({ source: value }),
}));
```

Calling a received factory constructs a normal graph node. It does not execute
the referenced implementation synchronously and does not fetch source during
the call.

The callable exposure depends on where the value is consumed:

- During eager `pattern()` construction, public inputs and closure params do
  not yet have values. A factory-typed value from either root is therefore a
  symbolic factory binding. The transformer lowers its call to a dynamic node
  that subscribes to that binding.
- When the runner invokes a `lift()` implementation, each `asFactory` input is
  read as part of that scheduled computation and supplied as the current,
  fully materialized ordinary factory function. The callback never receives a
  decoded shell or a promise. The lift's existing dependency and rerun
  lifecycle owns later input changes.
- When the runner invokes a handler, factory values in bound context and event
  data are materialized before that event's callback runs. Context is read for
  each event, so a context change affects later events but does not invoke the
  handler by itself. A factory carried by value in an event is that event's
  snapshot; an explicit `Cell<Factory>` retains normal Cell semantics.

These rules are based on value origin, not merely lexical nesting. A factory
delivered as a schema-driven `lift` or handler callback argument is live and
directly callable. A pattern-root or closure-param value remains a symbolic
binding until it crosses such a runner-owned materialization boundary.

Cold readiness is local to the consuming dynamic node, lift attempt, or
handler event. A cold nested factory does not delay construction or startup of
the whole parent pattern. Whole-parent prewarming is allowed only as a
cache optimization; making it semantic could deadlock when another node in the
same parent graph produces the factory value. A root factory passed to
non-transactional Promise-based `setup(undefined, ...)` is the exception: its
code is intrinsically required before the parent graph can be constructed.
Synchronous `run()` and transaction-bound setup remain warm-only.

### Nested patterns close over values

Authors write ordinary lexical closures:

```ts
// Shown for illustration only.
const patternOne = pattern(({
  param2,
  otherPattern,
}: {
  param2: string;
  otherPattern: PatternFactory<
    { bar: string },
    { value: string }
  >;
}) => ({
  callback: pattern(({
    foo,
    bar,
  }: {
    foo: string;
    bar: string;
  }) => {
    const other = otherPattern({ bar });
    return { value: something(foo, param2, other.value) };
  }),
}));
```

The inner pattern's public input remains `{ foo, bar }`. `param2` and
`otherPattern` are closure params; they do not appear in, merge with, or
override the public input.

Captures may include reactive values, cells, plain Fabric values, and any of
the three factory kinds. An arbitrary function value is never valid in closure
params, regardless of where it was declared. A module-scoped helper that the
hoisted callback references lexically is not a capture; it remains part of the
verified module.

### Inline patterns are the public partial-application model

Authors do not call `.curry()`. They define a wrapper pattern that closes over
the desired values:

```ts
// Shown for illustration only.
const makeIndex = pattern(({ entries }: { entries: Entry[] }) => ({
  search: pattern(({ query }: { query: string }) =>
    searchPattern({ query, entries })
  ),
}));
```

If another layer is useful, define another pattern. Each generated wrapper has
one environment and the original factory can itself be a closure param:

```ts
// Shown for illustration only.
const wrap = pattern(({
  operation,
  prefix,
}: {
  operation: PatternFactory<{ value: string }, { result: string }>;
  prefix: string;
}) => ({
  prefixed: pattern(({ value }: { value: string }) =>
    operation({ value: `${prefix}${value}` })
  ),
}));
```

This is the only author-facing currying model in version 1.

### Factory modifiers remain derivations

`asScope()` and `PatternFactory.inSpace()` continue returning new factories.
Their state is part of `Factory@1`, so modifiers survive storage. The raw
`inSpace()` selector is retained until graph construction; serializing a named,
anonymous, or cell-derived selector must not prematurely resolve it in the
writer's runtime.

For a pattern with closure params, modifiers may be applied before or after the
transformer-created binding. Every derivation preserves whether params are
already present, so no route permits a second internal curry.

## Branded Callable Fabric Protocol

### Direct factory branding

The factory function is the Fabric value. Trusted builder constructors attach
a non-enumerable internal brand and a state accessor. The exact symbol names
are internal; conceptually the dependency-free protocol is:

```ts
// Shown for illustration only.
const FABRIC_FACTORY = Symbol.for("common.fabricFactory");
const FACTORY_STATE = Symbol.for("common.factoryState");

interface FabricFactory {
  (...args: unknown[]): unknown;
  readonly [FABRIC_FACTORY]: true;
  readonly [FACTORY_STATE]: () => FactoryStateView;
}
```

The state accessor resolves through a stable internal root token because an
artifact ref is assigned after verified module evaluation. Curried, mapped,
and modifier-derived factories retain that same root token through a
`noteDerivedCopy`-equivalent side table; they never copy a temporarily missing
ref by value.

This requires a narrow extension to the current Fabric protocol. Today:

- `FabricValue` has no function arm;
- `[CODEC]` is class-side and lookup reads `value.constructor[CODEC]`;
- codec lookup rejects `typeof value === "function"` before class dispatch;
- native conversion only accepts functions through legacy `toJSON()`; and
- clone, freeze, equality, and hashing treat functions as invalid or primitive
  leaves.

Consequently, attaching today's `[CODEC]` property alone is not automatic. The
implementation adds a narrow `FabricFactory` arm plus one internal
`factoryStateOf(value)` / `tryFactoryState(value)` resolver. Conversion, JSON
encoding, deep-freeze, clone, equality, hashing, schema validation, and builder
traversal consult that resolver before their generic function branches. The
JSON registry has a dedicated callable-factory codec slot; it does not classify
`function` as an ordinary primitive type.

`FactoryCodec.canEncode()` accepts only values admitted to the internal
factory-state table. The brand is checked before legacy `toJSON()` conversion
and before generic function rejection.

No property on `Function` or `Function.prototype` is changed.

### Canonical state

All factory kinds use one wire tag and a genuinely discriminated essential
state:

```ts
// Shown for illustration only.
interface FactoryStateBaseV1 {
  ref: {
    identity: string;
    symbol: string;
  };
}

interface PatternFactoryStateV1 extends FactoryStateBaseV1 {
  kind: "pattern";
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  paramsSchema?: JSONSchema;
  params?: FabricPlainObject;
  defaultScope?: CellScope;
  spaceSelector?: FabricValue;
}

interface ModuleFactoryStateV1 extends FactoryStateBaseV1 {
  kind: "module";
  argumentSchema?: JSONSchema;
  resultSchema?: JSONSchema;
  defaultScope?: CellScope;
}

interface HandlerFactoryStateV1 extends FactoryStateBaseV1 {
  kind: "handler";
  contextSchema?: JSONSchema;
  eventSchema?: JSONSchema;
}

type FactoryStateV1 =
  | PatternFactoryStateV1
  | ModuleFactoryStateV1
  | HandlerFactoryStateV1;

// Internal only: refs may be pending and values may still contain
// Cells/Reactives that builder traversal must rewrite to aliases.
type LiveFactoryState = {
  kind: FactoryStateV1["kind"];
  rootToken: object;
  ref?: FactoryStateBaseV1["ref"];
  params?: FactoryInput<Record<string, unknown>>;
  spaceSelector?: FactoryInput<unknown>;
  // ...the kind-specific schema and modifier fields above
};

type FactoryStateView = LiveFactoryState | FactoryStateV1;
```

`LiveFactoryState` is not yet a hashable or encodable Fabric value. During graph
construction, shared factory traversal maps Cells/Reactives to aliases while
preserving `rootToken`. After verified module registration, the first Fabric
boundary calls `sealFactoryState()`: it resolves the factory artifact ref,
validates and freezes the mapped state, and memoizes one immutable
`FactoryStateV1`. Encode, hash, equality, and Fabric deep-freeze fail if sealing
is attempted before the ref exists. Once sealed, the logical state and its hash
cannot change.

JavaScript hardening of the callable before registration does not imply Fabric
deep-frozenness; the side-table state is not canonical until sealing succeeds.

`module` covers `ModuleFactory`, including factories returned by `lift`,
`byRef`, raw/builtin builders, and equivalent helpers.

`FactoryStateV1.ref` always names the complete builder factory artifact, as
returned by `getArtifactEntryRef(factory)` through its root token. It is never
copied from `moduleToJSON(...).$implRef`: that legacy ref names an
implementation-resolution record and may not recover the factory descriptor or
methods.

For the `Factory@1` V1 wire contract, `ref.identity` is exactly the current
prefix-free module-content identity: 43 characters of unpadded base64url
(SHA-256), with no `cf:module/` prefix. `ref.symbol` is a non-empty artifact
export or `__cfReg` symbol. Session-only `host:<n>` and `keyless:<hash>` pseudo
identities are therefore invalid on this wire.

`params` is either absent or the complete value for callback argument 1. It is
never a map of public input overrides. `paramsSchema` is trusted only after it
matches compiler metadata on the resolved base artifact; a wire value cannot
grant its own callback shape.

| Factory state | `paramsSchema` | `params` |
| --- | --- | --- |
| Capture-free pattern | absent | absent |
| Hoisted closure-bearing base pattern | present | absent |
| Bound closure-bearing pattern | present | present exactly once |
| Module or handler | forbidden | forbidden |

The public `argumentSchema` and `resultSchema` never change when params are
bound. Handler construction retains the original public state and event
schemas as `contextSchema` and `eventSchema` before combining them into the
existing internal `{ $ctx, $event }` module `argumentSchema`.

The encoded shape is:

```jsonc
{
  "/Factory@1": {
    "kind": "pattern",
    "ref": {
      "identity": "<module-content-identity>",
      "symbol": "__cfPattern_1"
    },
    "argumentSchema": { "type": "object" },
    "resultSchema": { "type": "object" },
    "paramsSchema": { "type": "object" },
    "params": {
      "param2": "...",
      "otherPattern": { "/Factory@1": { "kind": "pattern" } }
    }
  }
}
```

The nested example is abbreviated; every nested factory carries its complete
state.

### Encoding and decoding

Encoding performs these checks:

1. The value is present in the module-private factory state table, having been
   created by a trusted builder or by `FactoryCodec.decode()`. A copied symbol
   property is insufficient.
2. For a live builder factory, the state kind matches its trusted builder kind.
   A decoded shell may be re-encoded as validated data but gains no executable
   trust.
3. The factory has a cold-resolvable, content-addressed artifact ref. A
   keyless/manual or `host:<n>` pseudo-module factory fails encoding rather
   than embedding executable source or writing a session-only ref.
4. Pattern params, modifier state, and schemas are valid Fabric values and
   contain no cycles.

Decode validates the discriminant, ref, schemas, allowed fields, and
pattern-only fields, then creates a frozen branded function shell containing
the unresolved state. Decode never resolves or executes implementation code.

Generic JSON and memory decode currently run without a runner-aware
reconstruction context. Therefore generic decode cannot by itself manufacture
a live runner factory. The decoded shell is function-shaped, branded, and
round-trippable, but its call body throws "factory requires runner
materialization" and it does not claim the full behavioral
`PatternFactory`/`ModuleFactory`/`HandlerFactory` surface.

The runner owns one chokepoint, shown conceptually in warm and cold forms:

```ts
// Shown for illustration only.
interface FactoryMaterializationContext {
  runtime: Runtime;
  artifactSpace: MemorySpace;
  expected?: FactoryContract;
  ownerGeneration?: number;
}

materializeFactory(
  value: FabricFactory,
  context: FactoryMaterializationContext,
): BuilderFactory;

prepareFactory(
  value: FabricFactory,
  context: FactoryMaterializationContext,
): Promise<BuilderFactory>;
```

The warm hook returns an existing live builder factory or synchronously
resolves an indexed shell. The async-ready form may cold-load the artifact,
then reconstruct the correct callable builder factory and reapply params and
modifiers. Owner/generation information fences an async result from reviving a
stopped or superseded consumer. Authored code receives only the completed live
callable; a decoded shell is never used as a lazy executable wrapper.

`artifactSpace` is trusted boundary provenance, not a field accepted from
`Factory@1`. It identifies where the content-addressed source closure is
available. A pattern's serialized `spaceSelector` is applied later and chooses
where the child executes. When a factory is copied rather than linked across
spaces, the canonical writer/transport must make the artifact closure durable
in the containing destination space before the Factory value commits, or
reject the write. A linked value instead retains the link's source space. Wire
data cannot grant or retain a different source-space authority.

Every executable runner exposure path uses this chokepoint: schema-driven
`asFactory` reads, recursive Cell/query result materialization, dynamic module
dispatch, and CLI/FUSE/tool adapters. Dependency-only traversal and graph
binding preserve symbolic aliases without loading code. Transformed symbolic
invocation passes the binding to the dynamic node, which reads its current
value before calling the materializer. Context-free `valueFromJson()` remains
the intentional shell-returning boundary.

Materialization returns another function, not a wrapper object, and preserves
the canonical codec state for reserialization.

### Inline document transport

The canonical by-value inline representation is exactly:

```text
data:application/vnd.commonfabric.fabric-value;charset=utf-8,<percent-encoded fvj1 payload>
```

The payload is the complete output of the Fabric JSON encoder, including its
`fvj1:` version prefix. Readers dispatch only from the exact media type:
`application/json` retains the legacy `JSON.parse` interpretation, while
`application/vnd.commonfabric.fabric-value` uses context-free Fabric decode.
Readers never sniff one payload as the other format. In particular, a legacy
JSON object whose literal key is `/` stays an ordinary object; it is not
reinterpreted as a Fabric codec envelope. Both percent-encoded and base64
UTF-8 legacy transports remain readable during migration.

The new decoder therefore returns inert callable shells for `Factory@1`, just
like direct context-free `valueFromJson()`. Inline transport never grants code
loading or execution authority. Dual-format readers land before canonical
writers switch. A canonical writer may emit a nested factory only after the
complete artifact closure is durably available in the exact containing space;
an awaited cross-space by-value copy replicates that closure before commit,
while a synchronous writer without that proof rejects the value.

### Immutability, cloning, equality, and hashing

Canonical factories are immutable functional values:

- Fabric deep-freeze first seals and recursively freezes codec state, then
  freezes the callable;
- `.curry()`, `asScope()`, and `inSpace()` create new factory functions;
- factory values are always-frozen logical atoms, like `FabricPrimitive`
  values, so both frozen and mutable clone requests return the same canonical
  factory rather than exposing mutable hidden state;
- equality compares canonical `Factory@1` state, not function identity or
  `Function.prototype.toString()`; and
- hashing uses the `Factory@1` tag plus the recursively hashed codec state, the
  same semantic path used for codec-backed Fabric instances.

The JSON encoder must include branded functions in its codec cycle tracking.

### Traversal and binding

Closure params may contain cells and other factories. Keeping params private
does not make them opaque to the graph builder.

All Fabric-aware walks use the factory state accessor or a shared codec-state
visitor. Builder traversal, alias conversion, CFC inspection, deep freeze,
clone, equality, hashing, and serialization must not each invent a different
view of factory state.

When a parent pattern is built, traversal recursively maps `params` and
`spaceSelector`. Captured cells become normal aliases, captured factory state
recurses, and a derived branded factory is returned with the mapped hidden
state. A captured factory Cell/link remains a symbolic binding with its link
parent and artifact-source provenance intact; traversal never reads it merely
to snapshot the currently selected ref. No public or enumerable `curried`
property is required.

## Pattern Closure Transformation

### Pre-construction params-schema carrier

`pattern()` invokes its callback eagerly, before the hoisted factory reaches
`__cfReg`. The params schema therefore cannot first appear on artifact
registration. Schema injection decorates the callback before calling
`pattern()`:

```ts
// Shown for illustration only.
__cfHelpers.withPatternParamsSchema(callback, paramsSchema)
```

This compiler-only helper records the schema in a private callback WeakMap (or
equivalent symbol protocol) and returns the callback. `pattern()` and
`patternFromFrame()` read it synchronously on entry, create the second symbolic
root with that schema, and then invoke `callback(argument, params)`. They copy
the same trusted schema into the base factory's internal state for registration
and cold resolution.

The helper is part of the first argument expression. It does not add a fourth
argument to `pattern()` and is not author-facing API. The public callback type
still has one parameter; an authored second parameter is rejected unless the
callback carries this compiler-created metadata. Authored argument 0 is one
public input value and therefore may not be a rest parameter: appending the
compiler-owned argument 1 after a rest parameter would violate both JavaScript
syntax and this ABI.

### Logical transformation

For the nested pattern above, the transformer produces this logical shape:

```ts
// Shown for illustration only.
const __cfPattern_1 = pattern(
  __cfHelpers.withPatternParamsSchema(
    (
      { foo, bar },
      { param2, otherPattern },
    ) => {
      const other = otherPattern({ bar });
      return { value: something(foo, param2, other.value) };
    },
    paramsSchema,
  ),
  publicArgumentSchema,
  resultSchema,
);

const patternOne = pattern(({ param2, otherPattern }) => ({
  callback: __cfPattern_1.curry({ param2, otherPattern }),
}));
```

The shown `.curry()` is emitted JavaScript, not accepted authored API.

There is no fourth argument to `pattern()`. The call remains
`pattern(callback, argumentSchema, resultSchema)`. The compiler-generated
closure-param schema enters through the callback wrapper above and is then
retained on the hoisted artifact. It is not another public positional argument.

### Internal `.curry(params)` contract

The compiler-only method has exactly one argument and these rules:

1. It is available only on the internal factory type used by transformed code;
   the author-facing `PatternFactory` type does not declare it.
2. It always binds callback argument 1. There is no argument-index parameter.
3. The supplied record is the complete closure environment and must satisfy
   the trusted params schema.
4. It returns a new branded `PatternFactory` whose hidden state contains
   `params`.
5. It does not change the public TypeScript input type or public
   `argumentSchema`.
6. It throws if the factory already has params, even if the second value is
   equal or empty.
7. It throws if the base pattern has no compiler-declared params slot.

A capture-free nested pattern emits no curry call. It simply references the
hoisted factory.

### Separate symbolic roots

The internal pattern builder creates up to three roots:

- `argument`: public callback argument 0;
- `params`: compiler-generated callback argument 1; and
- `result`: the pattern result.

`params` has its own schema and alias form. It is not nested under the public
argument and is not persisted as user-editable piece input. At pattern
invocation, the runner validates public input against `argumentSchema` and
binds hidden factory params to the separate `params` root.

Each bound pattern invocation creates an immutable hidden params cell owned by
the invocation's result cell. It has a deterministic result-relative cause,
uses `paramsSchema`, is linked from result metadata under `params`, and carries
the normal back-link to `result` for resume and teardown.
Before child nodes instantiate, setup resolves the bound factory state's params
against the parent binding context, writes or links them into this cell while
preserving CFC labels, and supplies the cell to alias resolution.

Factory-valued entries in params follow the same exposure rules as public
input. During graph construction their aliases remain bindings; neither curry
nor params-cell population snapshots the selected factory ref. When a
scheduled runtime callback later consumes an `asFactory` leaf, the runner reads
and materializes its then-current value from the preserved link/source space.

The alias vocabulary gains `{ $alias: { cell: "params", path, ... } }`.
`unwrapOneLevelAndBindtoDoc`, `sendValueToBinding`, and direct sub-pattern setup
accept that pseudo-root only when the invocation has a params cell. Nested
links resolve relative to their original parent before the hidden cell is
populated; cross-space links remain links rather than copied values. On resume,
the serialized bound `Factory@1` state repopulates the same params cell before
the graph starts. The cell is torn down with its owning result and is never
exposed as piece input.

“Immutable” describes each installed Fabric params value, not a write-once
address. A stable call site reuses its deterministic params-cell address across
replacement generations. The supervisor cancels the prior owner first, then
atomically installs the new generation's complete params value; generation
fences prevent stale work from observing or reviving an earlier value. Ordinary
stop need not physically delete durable owned cells, but it removes every live
subscription and scheduling owner, so a later generation can reuse the address
only through a fresh, generation-owned setup.

An invocation of a closure-bearing base factory without bound params fails.
Supplying public fields with the same names as closure params has no special
meaning and creates no collision: the roots are distinct.

### Compiler pipeline

The transformation order is:

1. Validate that the nested builder call occurs in a transformable pattern-
   owned context.
2. Collect non-module lexical captures, including captured factory values.
3. Rewrite the callback to receive captures in argument 1.
4. Generate the public argument schema, result schema, and private params
   schema. Wrap the callback with `withPatternParamsSchema(callback, schema)`
   so `pattern()` receives the metadata before eager construction; do not add a
   fourth `pattern()` argument.
5. Hoist the capture-free base `pattern(...)` call to a deterministic
   `__cfPattern_N` declaration and register it through `__cfReg`.
6. Replace the authored site with `__cfPattern_N.curry(captures)`, or with the
   bare hoisted factory when there are no captures.
7. Apply normal reactive-variable cause assignment after the site rewrite.

Current array-callback lowering must use the same representation. For example,
`map` lowers to a `mapWithPattern` call receiving a bound PatternFactory; it no
longer passes closure params as a separate sibling argument. All pattern
closure values flow through the one internal `.curry(params)` operation.

Reactive array lowering does not support the optional JavaScript `thisArg`.
Pattern callbacks have no ambient JavaScript receiver, and the canonical list
node accepts only the bound factory, so a second array-method argument fails
compilation with a focused diagnostic. The previous transformer forwarded it
as an extra `mapWithPattern` argument that the runtime ignored; that accidental
no-op is not a compatibility contract.

### Diagnostics

Compilation or runtime fails clearly for:

- a non-portable captured function;
- a capture the schema generator cannot represent;
- missing or extra closure params;
- params that fail their trusted schema;
- a second internal curry;
- an internal curry on a capture-free pattern;
- an unresolved or kind-mismatched factory ref; and
- an untransformed attempt to invoke a symbolic factory proxy.

Generated names and capture-property order are deterministic.

## Factory Schemas and Symbolic Invocation

### Schema representation

The schema generator recognizes factory types before its generic callable and
callable-returning-cell logic. A factory-valued field uses a Common Fabric
extension such as:

```ts
// Shown for illustration only.
{
  asFactory: {
    kind: "pattern",
    argumentSchema: { /* ... */ },
    resultSchema: { /* ... */ },
  },
}
```

The `module` form uses `argumentSchema` / `resultSchema`. The `handler` form
uses `contextSchema` / `eventSchema`. A `HandlerFactory` must not be mistaken
for an `asCell: ["stream"]` merely because calling it returns a stream.

`asFactory` has one schema meaning and two execution-context exposures. In an
eager pattern-building root it describes a symbolic binding. In a scheduled
`lift` or handler argument it instructs the runner to supply a materialized
ordinary callable. Schema inspection, dependency tracking, and CFC traversal
may inspect or subscribe to the `Factory@1` atom without loading code; authored
runtime callback delivery may not expose the value until it is executable.

Version 1 requires the stored factory's canonical public schemas to equal the
call site's generated schemas after reference resolution and normalization.
Schema variance is deferred. The resolved trusted artifact is authoritative;
wire-carried schema hints never grant execution or CFC authority.

The compiler must preserve that exact public contract even when TypeScript
widens a factory expression to `PatternFactory<Input, any>` or merges several
factory alternatives into one semantic type. Compiler-owned, node-keyed
metadata may retain the builder's canonical type/schema contract through
aliases, selected object/tuple members, destructuring, containers, and lowered
conditionals; it is not serialized and is never populated from a decoded
`Factory@1` value. This applies equally to pattern, module/lift, and handler
factories. Inferred lift/handler contracts are captured after capability
shrinking so the containing schema equals the schemas actually injected at the
builder call. If one semantic position can hold multiple exact contracts, its
schema contains ordered alternatives rather than dropping or broadening any
contract.

For schema-bearing builder overloads, type reconstruction is insufficient:
JSON Schema keywords such as constraints, descriptions, defaults, and nested
`asFactory` metadata are part of the equality contract. The compiler therefore
retains statically resolvable JSON-compatible schema literals (including
proven-stable const bindings and static spreads) as compiler metadata. `const`
alone is not proof: property writes, mutable aliases, exports, or arbitrary-call
escapes make the binding ineligible. The compiler must not execute authored code
to discover a schema. A schema expression that requires execution or lacks that
stability proof is rejected when compiling a first-class factory contract
rather than producing a knowingly mismatched containing schema.
`toSchema<T>(options)` is a compiler-owned schema source rather than authored
execution: for a proven-stable reference, contract capture uses the same schema
generator and options evaluation as final emission. Arbitrary calls remain
unresolvable and fail closed.

Schema-light factories may still be passed and stored. Before symbolically
invoking a `type: "ref"` module factory such as `byRef()`, resolution follows
the ref through `ModuleRegistry` and uses that trusted module's schemas.
Authored `lift` and `handler` calls retain transformer-injected public schemas
on their factory metadata. If no trusted concrete schemas are available after
resolution, symbolic invocation fails; the call site's schema is not promoted
to authority. Direct invocation of the original live factory keeps its current
behavior.

### Type-directed call lowering

Calls on imported or module-scoped live factories continue using the existing
direct builder call path. Calls whose callee originates from an eager pattern
argument/params root are symbolic and are lowered to an internal builder
helper:

```ts
// Shown for illustration only.
operation({ value })

// Logical lowered form:
__cfHelpers.invokeFactory(
  operation,
  { value },
  {
    kind: "pattern",
    argumentSchema,
    resultSchema,
  },
);
```

The helper records a dynamic node containing the symbolic factory binding, the
call input, and the expected trusted contract. It does not read or serialize
the factory currently selected by that binding. It returns a `Reactive` output
for pattern/module factories and a `Stream` for handler factories. Handler
application retains its existing `$ctx` and `$event` node wiring.

The transformer classifier is execution-context aware. A factory-typed value
delivered as a `lift` implementation parameter or handler context/event
parameter remains an ordinary direct call, because the runner materializes
that argument before invoking authored code. A factory captured from an eager
pattern root remains symbolic unless it is explicitly delivered through such
an `asFactory` runtime argument boundary.

Exposure follows the nearest decisive execution boundary. Transparent nested
callbacks such as array methods do not hide an enclosing scheduled
`computed`/`lift`/handler boundary, so a captured factory there stays a direct
materialized callable. A nested eager `pattern()` boundary is decisive in the
other direction: a factory delivered live to an outer scheduled callback and
then captured by that nested pattern becomes a symbolic closure-param binding
and its call is lowered through `invokeFactory`.

The type-directed detector follows local aliases, property access, and
statically typed element access, so `const f = inputs.factory; f(value)` and
`inputs.factories[key](value)` use the same lowering. Version 1 rejects a
callable union spanning factory kinds, because the builder must choose
`Reactive` versus `Stream` before runtime resolution. Same-kind unions are
allowed only when their normalized public schemas agree.

A symbolic factory invocation uses one explicit public input argument. Version
1 rejects tuple/rest spread at such a call site: expanding it would require an
eager synchronous read of reactive graph input and could shift the internal
expected-contract argument. Direct calls on live factories retain ordinary
JavaScript call semantics.

At instantiation, the runner subscribes to the binding before its first value.
Initial absence means that the node is pending and has no child. Once a value
exists, the runner reads it in the consuming transaction, validates kind and
schemas, resolves the trusted base artifact, applies modifier and pattern-param
state, and tail-calls the existing pattern, JavaScript-module, or handler
instantiation path. It does not call authored code during decode, selection, or
cold loading.

The direct dynamic node is a switch-latest supervisor for one materialized
child/action/handler. It owns that instance's cancellation scope, result-owned
internal cells, and handler subscription. The factory binding is a reactive
dependency. On a different canonical factory state, the supervisor:

1. increments a generation token and cancels the prior instance;
2. fences late async writes/results from older generations;
3. tears down the prior child internals and stream subscription while retaining
   the call site's output binding;
4. resolves and validates the replacement, including artifact-source
   provenance and cross-space execution modifiers; and
5. rereads the binding after any await and instantiates only the still-current
   replacement under the new generation.

Selector invalidation is control-plane work and must not queue behind an
authored promise from the generation it is replacing. The supervisor therefore
observes the exact resolved selector source at the storage-notification seam,
rereads that source, and invalidates the old generation immediately. This fast
lane grants no execution authority and runs no replacement code: normal
transactional selection, CFC validation, materialization, and instantiation
remain on the scheduled path. JavaScript promises are not forcibly settled;
the canceled promise may finish later, but its transaction and subscriptions
are generation-fenced and cannot commit. The replacement begins when the
ordinary scheduler lane advances.

Replaying the same canonical `Factory@1` state is a no-op. If A is cold and B
is selected before A finishes loading, A may populate the trusted artifact
cache but can never instantiate; completion is fenced by owner and selection
generation, and the resumed attempt rereads the binding. A deterministic
missing/forged/wrong-kind/schema failure fails the current generation closed
but a later valid selection may recover. A transient source failure remains a
pending/retry condition under the existing scheduler policy.

The stable output spot remains the cause/identity anchor, matching existing
sub-pattern and list-builtin invariants. The binding and selected canonical
state are dispatch dependencies, not inputs to result-cell identity; changing
a factory must not churn the output cell merely because its program changed.
Previously committed output may remain readable while the replacement is
pending, but the canceled generation has no live subscription and cannot write
again. Initial absence produces no fabricated output or authored error value;
diagnostics use the runner's node failure channel. Distinct call sites already
have distinct output bindings.

### Scheduled callback readiness

`lift` and handler callbacks use the same materialization chokepoint but not the
direct dynamic node's replacement lifecycle. Before authored code runs, the
runner performs schema-directed input preparation:

1. read each `asFactory` leaf in the action/event transaction, preserving its
   dependency, link provenance, and CFC labels;
2. if every value is live or warm-resolvable, supply ordinary callable
   factories and invoke the callback synchronously as today;
3. if any value is cold, invoke no authored callback code and commit no authored
   result; arrange a single-flight load outside that authored transaction; and
4. when loading completes, verify the owner/generation is still live, retry the
   same computation/event, and reread every factory value rather than using the
   value that initiated the load.

For a lift, ordinary reactive input changes schedule the retry/rerun. Cold
readiness by itself does not tear down the lift's prior committed value or
result-owned child. Once inputs are ready, the existing lift execution,
replacement, and commit semantics apply unchanged; the direct dynamic node's
immediate teardown rule does not silently change general lift semantics.

For a handler, bound context is reread per event and a context change alone
does not run the handler or replace children produced by earlier events. A cold
event is delayed/requeued with the same durable event intent: identity, origin
lineage, commit/final callbacks, retry metadata, and deadline all remain
attached. Readiness waiting is distinct from an authored handler attempt and
does not consume the event's commit-retry budget, call its final callback, or
mint a receipt. Transient artifact unavailability follows a dedicated bounded
readiness retry/backoff policy regardless of the authored event's `retries`
setting; deterministic missing/forged/wrong-kind/schema failure is terminal
and fail-closed. The enclosing handler stream subscription remains active so it
can receive the event, but no handler body, normal success receipt/result graph,
or event-created child/action subscription is created before readiness. Owner
teardown cancels preparation so a late load cannot resurrect either a lift
attempt or handler event.

The selection reads above occur in the consuming action/event transaction so
CFC authority and reactive dependencies flow from the actual current value.
Prewarming outside that transaction is cache-only and cannot authorize later
execution.

## Resolution

Warm resolution uses the existing generic artifact index:

```text
factory.ref -> trusted builder artifact -> verify kind -> instantiate
```

Cold resolution generalizes the existing pattern-only loader. The loader key
includes the trusted artifact source space as well as content identity; it does
not use the pattern's execution `spaceSelector`:

1. Load the source document for `ref.identity`.
2. Verify and evaluate the content-addressed module.
3. Resolve `ref.symbol` through exports or `__cfReg`.
4. Require a trusted builder brand and the expected factory kind.
5. Cache the artifact in the generic identity index.

This generalized `loadArtifactByIdentity()` path serves pattern, module, and
handler factories. A legacy `$patternRef` may adapt to a pattern
`FactoryStateV1` because it names the pattern factory artifact.

There are three cold entry paths: non-transactional Promise-based root
`setup(undefined, ...)`, a direct dynamic node, and scheduled `lift`/handler
input readiness. Root setup waits because the parent graph cannot be built
without its root artifact; synchronous `run()` and transaction-bound setup do
not enter this path. The other cold paths delay only the consuming
node/attempt/event and always reread current state after loading. Linked values
load from the resolved link's source space. A by-value Factory loads from its
containing space, whose writer must have durably replicated the content-
addressed artifact closure before committing or enqueueing that value. This
applies equally to stored Cells, handler event payloads, CLI, and FUSE writes.
The bare `Factory@1` wire state remains only `{ identity, symbol }` and never
names or grants an artifact source space.

A legacy `$implRef` does not feed this resolver as a factory ref. It may name
only an implementation function and omits module/handler configuration. Its
compatibility reader retains the surrounding serialized module descriptor,
resolves the implementation through the legacy path, and reconstructs a
ModuleFactory or HandlerFactory with the corresponding internal descriptor
constructor.

For a bound pattern, setup additionally:

1. validates `paramsSchema` against the trusted base metadata;
2. validates the complete `params` value;
3. binds it to the pattern's `params` alias root; and
4. traverses nested factory refs and cell links normally.

Scope and raw pattern space-selector state are applied after base resolution
and before node instantiation.

## Trust and Security

The Fabric-factory brand is a data-type brand, not executable trust. The
symbol routes protocol handling; membership in a module-private WeakMap or
WeakSet is the unforgeable brand.

There are two separate capabilities:

- the data-model factory-state table admits well-formed live factories and
  decoded shells for conversion and reserialization; and
- runner-owned provenance tables alone assign/resolve executable artifact refs
  for verified builder factories.

The data-model registration mechanism is not an execution-trust grant, even if
an internal materializer must call it to create a derived shell.

- Only trusted builder constructors and `FactoryCodec.decode()` create branded
  values.
- `FactoryCodec.canEncode()` additionally checks the internal builder/state
  brand; a user function with a copied symbol property is rejected.
- Decoded state resolves only through the trusted artifact index or verified
  source loading. It cannot supply implementation source.
- The resolved artifact kind, schemas, and compiler params schema must match
  the decoded state before invocation.
- The current factory selection is read in the consuming transaction. A
  cache-warming load outside that transaction cannot substitute for the read,
  dependency, CFC provenance, or trusted-contract validation that authorizes
  execution.
- CFC and alias traversal descend into params, so hiding params from the public
  object shape does not hide their labels or dependencies.
- A factory's schema, ref, description, or debug preview is never an authority
  grant.

### Framework-provided inputs

Inline wrappers preserve `FrameworkProvided` obligations transitively. They do
not turn a framework-provided input such as `sandboxId` into an ordinary
closure param or let an author bind it indirectly.

The compiler records trusted framework-provided paths for each base factory.
When a wrapper calls such a factory, it synthesizes those fields into the
wrapper's argument schema and callback binding, then forwards their aliases to
the inner factory node. The fields are system-facing inputs, not closure params:
the tool adapter strips them from the model-facing schema, injects them from
the wrapper tool instance's identity, and the synthetic forwarding path carries
that exact value to the ultimate call. Wrapper chains repeat the same
transitive forwarding.

Authored code may neither supply a literal for such a field nor capture a
chosen value and forward it. If a required system value or stable tool identity
is unavailable, invocation fails closed.

The same rule applies when the call occurs in a materialized `lift` or handler
callback: required paths come from trusted compiler/artifact metadata resolved
for the base factory, never from `Factory@1`, authored event/context data, or a
closure capture.

Closure conversion rejects a capture that attempts to freeze a
framework-provided field into `params`. Captured ordinary values remain graph
bindings from the enclosing pattern, not a second caller-input channel, and
there is no public curry API that can override framework-supplied fields.

## Replacing `patternTool`

The current shape:

```ts
// Shown for illustration only.
const tools = {
  search: patternTool(searchPattern, { entries }),
};
```

becomes an ordinary inline pattern closure:

```ts
// Shown for illustration only.
const tools = {
  search: pattern(({ query }: { query: string }) =>
    searchPattern({ query, entries })
  ),
};
```

The wrapper's public schema naturally contains only `query`. `entries` is a
closure param, not a public input that a tool adapter subtracts or merges.

A PatternFactory is directly usable as a tool. Optional description or
presentation metadata may remain in an ordinary tool metadata wrapper, but
there is no `extraParams` field:

```ts
// Shown for illustration only.
const tools = {
  search: {
    pattern: pattern(({ query }: { query: string }) =>
      searchPattern({ query, entries })
    ),
    description: "Search this index",
  },
};
```

Tool discovery reads the factory's public argument schema. Invocation follows
the same dynamic factory path as ordinary pattern composition.

## Compatibility and Migration

During the migration, readers accept:

- `Factory@1` values;
- legacy pattern `{ $patternRef, argumentSchema, resultSchema }` values where a
  PatternFactory is expected;
- legacy serialized module descriptors carrying `$implRef`; and
- legacy `{ pattern, extraParams, ...metadata }` tool definitions; and
- legacy `mapWithPattern` / `filterWithPattern` / `flatMapWithPattern` nodes
  carrying sibling `{ op, params }` inputs.

New writers emit `Factory@1`. Legacy `extraParams` keep their existing
tool-boundary merge and precedence rules only in the compatibility reader. They
are not exposed as `.curry()` and are not redefined as closure params.

During the same dual-read window, list builtins accept either the legacy
`op + params` shape or a new bound PatternFactory with no sibling params. The
transformer emits only the new shape, while the old public method overload and
stored-node reader remain until source usage is gone and stored graphs have
been migrated or explicitly wiped.

Migration proceeds by changing source callers to inline wrapper patterns. Once
stored-data and source-usage gates are satisfied, remove:

- `patternTool` and `PatternToolResult`;
- transformer callback-boundary, validation, and hoisting special cases for
  `patternTool`;
- LLM schema-format and invocation special cases for `extraParams`;
- legacy list-builtin overloads and sibling `params` readers; and
- factory-function `toJSON()` compatibility once all boundaries use the
  registered Factory codec.

Current behavior documents remain accurate until the implementation lands;
they are updated in the same implementation change, not preemptively by this
proposal.

## Delivery Order

### Stage 0: Extract generic pattern-ref binding

Copy or reimplement the small `$patternRef` binder/setup behavior currently
coupled to #4514. Cover patterns nested anywhere in bindings and direct
setup/sub-pattern resolution. Do not take a dependency on the reactive-
interpreter stack.

The compatibility split follows the existing APIs: synchronous `run()` and
transaction-bound setup resolve only warm indexed sentinels and fail clearly
when the ref is cold. Promise-based `setup(undefined, ...)` may load cold source
and re-enter setup. Stage 0 does not make `run()` async.

### Stage 1: Branded factory Fabric values

Add the narrow callable Fabric protocol, `Factory@1`, canonical factory state,
codec registration, conversion, clone/freeze/equality/hash behavior, and shared
factory-state traversal. Brand every trusted pattern/module/handler factory.

### Stage 2: Factory schemas and dynamic invocation

Generate `asFactory` schemas, lower symbolic calls, complete the runner's
dynamic-module arm, materialize runtime `lift`/handler arguments with node-local
cold readiness, and generalize source-space-aware artifact loading across
factory kinds.

### Stage 3: Pattern closure conversion

Add the second callback root, pre-construction
`withPatternParamsSchema(callback, schema)` carrier, deterministic hoisting,
one-shot internal `.curry(params)`, params binding, and the updated
`*WithPattern` lowering.

### Stage 4: Remove `patternTool`

Migrate source callers to inline wrapper patterns, dual-read stored legacy tool
values, then remove the API and transformer/runtime special cases once the
compatibility gate is met.

Each stage is independently testable and revertible.

## Implementation Areas

- `packages/data-model`: FabricFactory type arm and brand, `FactoryCodec`, codec
  registry function dispatch, conversion, freeze/clone, equality/hash, JSON
  cycle tracking, and formal type declarations.
- `packages/memory` and runner storage/update paths: treat branded factories as
  atomic codec values at storage boundaries, preserve them through patches and
  diffs, and reject unbranded functions.
- `packages/api`: mirrored FabricFactory and `asFactory` schema declarations;
  keep `.curry` out of the public `PatternFactory` type.
- `packages/runner/src/builder`: brand/state attachment for every factory,
  pre-construction callback params-schema metadata, pattern params root,
  internal curry derivation, symbolic invocation helper, modifier persistence,
  root-token provenance, and live-to-canonical protocol traversal.
- `packages/runner`: params pseudo-alias types and binding functions, hidden
  params-cell metadata/lifecycle, dynamic-module supervision, generic artifact
  resolution/loading, runner materialization, scheduled action/event readiness
  and retry ownership, artifact-source context, and compatibility adapters.
- `packages/schema-generator`: recognize all factory kinds before generic
  callable handling and emit public factory schemas.
- `packages/ts-transformers`: capture analysis, nested-pattern closure rewrite,
  `withPatternParamsSchema` emission, deterministic hoisting, symbolic call
  lowering, framework-input threading, list callback lowering, and diagnostics.
- `packages/llm`, CLI, FUSE, and schema formatting: consume Factory values
  directly and retain legacy reads during migration.
- pattern sources: replace `patternTool` with inline patterns.

## Validation Plan

### Fabric protocol

- Encode/decode/hash/equality/clone/freeze each factory kind.
- Round-trip factories nested in objects, arrays, cells, pieces, and other
  factory params.
- Round-trip through the memory client/server boundary, where decode has no
  runner reconstruction context, then materialize in a runner.
- Reject arbitrary functions, copied symbols, malformed states, cycles,
  keyless artifacts, kind mismatches, and schema mismatches.
- Reject encode/hash/deep-freeze before ref sealing and verify that a sealed
  factory's state and hash never change.
- Verify equal state hashes equally across independent module evaluations.
- Verify params and space selectors participate in traversal and hashing.

### Transformer

- Golden-test the exact two-parameter callback and
  `__cfPattern_N.curry(params)` site.
- Assert `withPatternParamsSchema(callback, schema)` is present before eager
  `pattern()` / `patternFromFrame()` construction.
- Assert there is no fourth `pattern()` argument, argument-index curry, public
  input merging, or curry call for capture-free patterns.
- Capture cells, nested properties, and every factory kind.
- Reject non-portable functions and a second internal curry.
- Wrap a bound pattern in another authored pattern and verify one curry per
  wrapper.
- Lower symbolic factory inputs without changing imported/live-factory calls.
- Cover aliased, property-selected, element-selected, and same-kind union
  callees; reject cross-kind callable unions.
- Lower `map`/`filter`/`flatMap` captures through a bound PatternFactory rather
  than a sibling params object.

### Runtime

- Invoke stored pattern, module, and handler factories through symbolic inputs;
  verify initial absence subscribes before the first value and equal canonical
  replay is a no-op.
- Change a direct symbolic factory binding and verify switch-latest teardown,
  stable output identity, last-committed output behavior, and stale async-write
  fencing.
- Deliver every factory kind as a warm and genuinely cold `lift` argument,
  handler context value, and handler event value. Assert authored callbacks see
  ordinary callables and never shells/promises.
- Gate cold load deterministically and cover A-loading then B-selected, owner
  teardown during load, invalid-then-valid recovery, and a factory produced by
  another node in the same parent graph without parent-start deadlock.
- Verify a lift keeps its normal last-successful result/child until a successful
  rerun atomically replaces it; do not apply direct-node immediate teardown to
  general lift semantics.
- Requeue a cold handler event with the same durable event identity; assert no
  body or normal receipt before readiness, transient retry, terminal
  deterministic rejection, per-event context reread, and by-value event
  snapshot behavior.
- Bind closure params through the separate params root and preserve public
  argument fields with the same names.
- Resume and tear down the deterministic hidden params cell, including nested
  aliases, cross-space links, and CFC labels.
- Capture and invoke another stored factory from a nested pattern.
- Verify Factory state uses the builder artifact ref, never an implementation
  `$implRef`, and exercise schema-light `byRef()` resolution.
- Preserve `asScope()` and every `inSpace()` selector form across round-trip.
- Resume all factory kinds cold by content-addressed identity.
- Resolve a cross-space linked factory from its artifact source while applying
  `spaceSelector` only as the child execution target; verify by-value transport
  replicates the artifact closure without adding source authority to the wire.
- Preserve CFC labels on the selection read and fail closed on forged refs or
  metadata.
- Pin Stage 0's warm synchronous `run()` and cold asynchronous `setup()` split.

### Tool migration

- Use an inline pattern that captures entries as an LLM tool.
- Wrap a tool with a framework-provided `sandboxId`; verify synthetic forwarding
  from the wrapper tool identity and reject authored/captured values.
- Discover and invoke the same tool through runtime, CLI, and FUSE paths.
- Read legacy `PatternToolResult` values without changing their old precedence.
- Read legacy list nodes with sibling params and emit only bound-factory nodes.
- Verify no new source caller or stored writer emits `extraParams`.

## Completion Criteria

This proposal is complete when:

1. Every content-addressed pattern/module/handler factory is directly branded
   and round-trips through a runner as a callable `Factory@1` value; keyless and
   session-only factories fail durable encoding.
2. Arbitrary functions remain rejected.
3. Factory-valued eager pattern inputs and captures invoke through one dynamic
   supervisor path; factory values delivered to `lift` and handler callbacks
   pass through the same runner materialization chokepoint and then use the
   ordinary direct callable path.
4. Nested patterns preserve lexical semantics through callback argument 1 and
   exactly one transformer-only `.curry(params)` operation.
5. Public pattern inputs are never merged with closure params.
6. Factory refs, schemas, params, scopes, space selectors, CFC labels, and
   hashes survive storage and cold reload.
7. `patternTool` and sibling list params have no source writer path, and their
   compatibility readers have explicit stored-data removal gates.
