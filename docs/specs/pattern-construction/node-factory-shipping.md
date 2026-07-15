# First-Class Serializable Factories

## Status

Implemented through the pre-launch compatibility cleanup on 2026-07-12. The
only intentionally retained compatibility surface is direct factory-function
`toJSON()` graph serialization; its removal remains gated on proving that every
Fabric boundary uses registered codec dispatch.

The ordered execution checklist is
[First-Class Serializable Factories — Executed Plan](../../history/plans/first-class-serializable-factories.md).

The content-addressed identity prerequisite is shipped: every verified,
module-scoped builder factory is addressable by `{ identity, symbol }`.
Exports use their export name, while transformed and non-exported factories use
their `__cfReg` name. See
[Content-Addressed Action Identity](../content-addressed-action-identity.md).

Stage 0 reproduced only the generic behavior identified by commits
`3b028c786`, `39b213e63`, and `ede6c5a7d`; it did not import the unrelated
reactive-interpreter work from #4514. Factory@1 subsequently replaced that
temporary `$patternRef` carrier.

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

## Shipped State

All three factory kinds are directly branded callable Factory@1 values.
Registered Fabric codecs preserve their kind, content-addressed builder artifact
ref, schemas, params, scope, and space selector, and context-free decode returns
an inert callable shell. Runner-owned materialization is the only execution
chokepoint.

Symbolic factory calls lower to reactive dynamic nodes with switch-latest
replacement and stale-generation fencing. Factories delivered to scheduled
lift and handler callbacks are materialized to ordinary callables before
authored code runs, with consumer-local cold readiness.

Nested patterns use lexical closure conversion: public input is callback
argument 0, closure params are callback argument 1, and the transformer carries
the private params schema through `withPatternParamsSchema(callback, schema)`
before applying its private one-shot `.curry(params)` operation. List lowering
passes one bound factory and no sibling params.

Direct factory-function `toJSON()` remains a compatibility graph serializer.
Canonical Fabric writers dispatch through the Factory@1 codec. `$implRef`
remains current only inside instantiated execution-module descriptors; it is
not factory state and is never accepted as a Factory@1 ref.

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

This capture exception belongs specifically to closure-converted nested
`pattern()` callbacks. Reactive array-method callbacks remain self-contained SES
callbacks and do not capture a locally scoped factory directly. When an array
lowering needs one, it carries the bound nested pattern factory as the list
operation's single factory operand; no sibling params object is introduced.

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
where the child executes. A linked value retains the link's source space. Wire
data cannot grant or retain a different source-space authority. By-value copies
use the publication protocol below so the destination can cold-resolve the
factory without retaining or reading an origin-space link.

Every executable runner exposure path uses this chokepoint: schema-driven
`asFactory` reads, recursive Cell/query result materialization, dynamic module
dispatch, and CLI/FUSE/tool adapters. Dependency-only traversal and graph
binding preserve symbolic aliases without loading code. Transformed symbolic
invocation passes the binding to the dynamic node, which reads its current
value before calling the materializer. Context-free `valueFromJson()` remains
the intentional shell-returning boundary.

Materialization returns another function, not a wrapper object, and preserves
the canonical codec state for reserialization. Preservation requires exact
kind, ref, bound params, scope, and space-selector state. Public schemas are
checked through the normalized contract comparison above, so a harmless `enum`
reorder does not fail the final state check; the materialized callable
reserializes the trusted artifact's canonical schema representation.

### Durable by-value publication

A Factory value may become visible in a space only together with a durable,
verified source closure for every factory ref recursively contained in that
value. The containing write is determined after data-URI expansion, link
normalization, and codec-state traversal; data URIs are transport syntax and do
not create a separate durability exception.

Publication preserves the memory system's optimistic local-commit contract:

1. The authored write is staged normally. Committing it allocates its
   `localSeq` and reserves that sequence's causal wire position before applying
   it to the local pending overlay or invoking any synchronous subscriber. It
   then emits the synchronous speculative commit notification without waiting
   for artifact I/O. A transaction created reentrantly by that notification is
   therefore optimistic immediately but cannot reserve ahead of the transaction
   whose value triggered it.
2. For every warm verified closure, the runner synchronously adds artifact
   ensure operations to the wire commit. A warm publication introduces no
   asynchronous readiness boundary. Every successful source-verification path,
   including a storage-backed compiled-cache load and runtime-version source
   recovery, retains the complete verified module set in the exact source-space
   publication cache before returning the live artifact. The requested or
   compiled entry retains the complete verified set, including synthetic extra
   roots. Every other verified module identity retains its separately rooted
   forward-import closure, so a factory defined outside the entry module remains
   synchronously publishable without including importer-only siblings.
3. If a trusted source closure is not loaded, the same local commit remains
   speculative while runner-owned preparation loads and verifies it. No
   authored callback or setter becomes asynchronous.
   Every transaction issued by a `Runtime` performs this artifact-publication
   preparation from its own `commit()` boundary. Calling
   `Runtime.prepareTxForCommit()` earlier remains an idempotent eager path for
   scheduler and CFC work, but correctness never depends on a public
   transaction caller remembering that separate helper. Every eager or final
   pass reconciles keyed artifact preparations against the transaction's
   current native operations. If a later write removes a factory or replaces
   the same identity with provenance from another source, the obsolete
   preparation is removed and its publication-gate ownership is rejected
   before the final draft can commit. An overwritten Factory may neither
   reject an ordinary final write nor publish an orphan closure.
4. Wire submission for that logical session is held until preparation finishes.
   Later transactions may build on the speculative overlay, but their wire
   commits cannot pass the blocked lower `localSeq`.
   An absent or already-released predecessor is not an asynchronous gate: a
   warm unblocked commit enters the session's causal chain with the established
   commit timing, including conflict-response ownership during concurrent
   shutdown. Existing wire prerequisites such as a scheduler-observation flush
   reserve their turn before the dependent semantic commit, so causal ordering
   cannot become a mutual wait when the semantic commit also carries a cold
   factory preparation.
5. The server applies the artifact ensures and the containing value atomically.
   A deterministic preparation or integrity failure rejects the containing
   commit and follows ordinary speculative-revert and dependent-commit rules.
   Only confirmation of that atomic commit grants destination-space artifact
   availability. At confirmation, the runner also upgrades every already-indexed
   live factory under the confirmed content identity with its durable artifact
   ref; a factory evaluated before publication therefore becomes synchronously
   sealable without re-evaluation. Later evaluations of the same verified
   identity receive the same durable ref immediately.

Consequently, a remote runtime cannot observe a canonical factory ref before
the referenced artifact closure is durable in that value's space. A local
runtime may observe its own speculative containing write while cold publication
preparation is still running, but that same logical commit either publishes the
artifact and value atomically or reverts the value; the revert is the input
notification that re-drives consumers. There is no valid state where an
artifact lands later, independently of an already-durable ref, so factory input
preparation does not poll or sleep waiting for such an arrival.

An artifact ensure is resolved against durable server state, not expressed as
a compare-and-swap read of the destination cache document:

```text
ensure(id, expected)
  absent                      -> store expected
  equal identity payload      -> success without a write
  different identity payload  -> integrity failure
```

The equality payload is the canonical content-addressed artifact content;
incidental annotations, cache metadata, and CFC representation are handled by
their owning layers and cannot turn an identical artifact into a conflict.
Concurrent publication of the same closure is therefore idempotent and does not
reject either containing write. Different content under one content identity is
not a harmless race and must fail closed.

Synthetic `cf:cache-root/` edges are closure-load topology, not authored module
imports and not part of a module's Merkle identity. Stored source documents and
runtime-versioned compiled documents therefore keep them in a dedicated
`roots` set, separate from identity-bearing `imports`. Canonical cache writers
preserve an existing roots set through a narrow, pre-synced path read and append
new roots in deterministic order; they do not broad-read dependency documents
or remove roots contributed by another entry topology.

An artifact ensure compares the canonical document core first, excluding only
its explicitly declared incidental and additive paths. After that core compares
equal, the server atomically unions the ensure's `roots` into the durable set by
stored-value equality. Missing roots are added in deterministic input order;
roots already present, including an existing superset from another entry
topology, are a no-op. This preserves cold source and compiled reachability when
the same module document is published first as a dependency and later as an
entry with generated roots. Generic ignored fields are never merged, and a core
mismatch still rejects before any additive update.

Cross-space closure verification must compare the trusted origin's complete
source and runtime-versioned compiled identity sets with the destination. A
destination that independently verifies but covers only an older topology is
repaired; a destination superset is accepted without rewriting. Exact-space
availability is granted only after that coverage proof.

The global source-root set may retain valid synthetic helper generations from
several compiler/runtime versions. A runtime-versioned compiled closure selects
the matching source view by its own identity set; older source-only generations
do not make the current compiled closure incomplete. When the selected runtime
version has no compiled closure, cold recovery recompiles only the entry's
authored-import-reachable source view and lets the current compiler inject its
own synthetic helpers. Retained roots are never fed back as authored input, so
two valid ambient generations with the same filename cannot shadow one another
during recovery.

An atomic commit may contain multiple idempotent ensures for one resolved
address only when their normalized `ignore` and `addUnique` policies agree.
Every policy path is non-empty: the document root cannot be excluded from the
identity comparison or treated as an additive set. Policy paths are deduplicated
and ordered canonically; overlapping paths within or between the two families
are rejected before any revision, so no declaration order can change which
content is identity-bearing or additive. A commit must
not combine an ensure with an authored `set`, `patch`, or `delete` for that
address. The server resolves scope first and rejects these order-dependent
shapes before writing any revision, so a containing authored operation cannot
overwrite the content-addressed artifact it just checked.

When concurrent containing-value commits publish the same module identity from
different trusted source topologies, each direct runtime transaction carries
its own complete source ensures. Their additive root sets converge atomically
at the destination: neither successful commit may discard roots installed by
the other, and a fresh runtime must be able to verify and traverse both source
closures. Compiled-root convergence remains the runtime-versioned compilation
cache's separate replication responsibility; containing-value publication may
remain source-only because verified source is the cold recovery authority.

Artifact source provenance used during cold preparation is runner-private and
transient. It is neither serialized into `Factory@1` nor retained by the
destination. A context-free shell with neither destination availability nor
trusted source provenance cannot authorize copying and fails closed.
When context-free decode occurs as part of a Cell read, the runner may associate
the returned shell with that containing Cell's space in a private weak table.
This association is only a candidate source location: cold preparation must
load and verify the complete closure there before the containing commit can
reach the wire. The association itself grants no execution authority and is
lost when the runtime or shell is collected.
The candidate remains valid when the containing Cell and the new write are in
the same space. A fresh runtime must be able to reread a durable Factory and
write it to another Cell in that space: cold preparation verifies the existing
closure and carries idempotent ensures before the new containing value reaches
the wire. Exact-space availability is still granted only after confirmation.
Cold preparation always probes durable source authority before consulting a
pending publication. Therefore an unrelated pending rewrite of an identity can
neither delay nor reject a copy from an already-durable Cell. If the probe
misses because the candidate Cell is itself visible only through a speculative
containing commit, verification waits for the applicable `(space, artifact
identity)` publication generation to confirm. This dependency is runner-private
and shared only by runtimes using the same speculative storage manager; it is
not derived from Factory state. Warm verified or cached source remains
synchronous, and a pending publication for another identity or space does not
serialize the write.
Concurrent publishers own the keyed gate by generation: any confirmation makes
the source usable, while rejection fails dependent preparation only after no
publisher for that generation can still confirm. Local abort, preparation
failure, and wire rejection all settle their ownership, so a dependent copy
fails retryably rather than hanging. A same-space follow-up captures the prior
generation before registering its own publication and therefore never waits on
itself. Successful confirmation also carries the confirming owner's verified
in-process module closure across that private gate. A dependent commit can
therefore build its ensures without racing the local replica's later delivery
of the already-durable source documents; this proof is never serialized and a
rejected generation exposes no closure.
When both a verified runner-owned source and a Cell-read candidate exist, the
verified source wins. The candidate may be an intermediate destination whose
containing publication is still speculative; it must not make a causally
dependent copy race that predecessor's wire confirmation when the original
verified closure is already available. Cell provenance remains the cold
fallback and still requires complete closure verification.

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
writers switch. Once expanded into a containing document write, nested factories
follow the same speculative-local, causally gated publication protocol as every
other by-value write.

Read-derived traversal, including query traversal and `resolveAsCell()`, may
construct a transient data-URI address from a value already read inside a
persisted containing Cell. That internal address is derived from the containing
Cell's full source-space address and is not a canonical durable writer, so
constructing it does not repeat destination-availability proof. It grants
neither artifact availability nor execution authority. If the value is
subsequently written, data-URI expansion restores the containing value before
the ordinary codec-state walk, source verification, and atomic publication
proof; no transient address creates a durable publication bypass.

Storage transaction fast paths operate on the containing entity document and
must preserve `Factory@1` as an atomic value at its document path (normally
`value` or a descendant). They use the same Fabric freeze, equality, and
arbitrary-function rejection rules as generic reads and writes; no raw-state
reader or root-function document representation is part of this contract.

### Structured-clone runtime IPC

Browser runtime messages may carry factories inside cell values, VDOM props,
or telemetry details. Because callable `Factory@1` values are not directly
structured-cloneable, every such message projects the complete containing
value through the canonical Fabric JSON codec before crossing the worker
boundary. An out-of-band protocol discriminator selects that projection;
authored strings are never sniffed or reinterpreted as Fabric envelopes.

Factory detection and projection recurse through registered codec state, not
only enumerable JavaScript properties. A factory nested in `UnknownValue`,
`FabricError.cause` or extras, another codec-backed Fabric instance, an array,
or an ordinary object therefore selects the canonical Fabric projection and
round-trips the complete enclosing value. IPC preparation never flattens a
codec-backed instance with `Object.entries()` or strips its container before
the codec owns the projection.

The receiving side performs context-free decode, so every factory leaf is an
inert callable shell. Worker IPC does not grant materialization or code-loading
authority, and arbitrary JavaScript functions remain invalid message values.
Values without factories retain the existing plain structured-clone path.

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
clone, equality, hashing, serialization, IPC detection, and destination-artifact
publication must not each invent a different view of factory state. Registered
codec-backed Fabric instances with implemented container state recurse through
their encoded state. Walks that change that state, including data-URI
normalization and inlining and live factory-state write preparation, reconstruct
the same registered instance type through its codec rather than flattening its
enumerable properties. In-process reconstruction also preserves local
codec-external diagnostics such as `ProblematicValue.error`, even though those
diagnostics are intentionally absent from the round-tripped wire state. This
context-free reconstruction cannot materialize a decoded factory shell. Actual
Cells and links remain atomic references whose own source-space provenance is
preserved. A registered instance whose codec is deliberately unimplemented also
remains atomic during ancillary graph transforms; the canonical writer still
rejects it at the codec boundary, so this is not an admission of that value.

Every canonical by-value write route uses this traversal, including direct Cell
and stream writes, normal result/output binding, writable query-result proxies,
runtime-client, CLI, and FUSE adapters. A route may not bypass publication merely
because it reaches storage through a binding or proxy rather than `Cell.set()`.
When a raw Cell read follows a link, runner provenance records the resolved
target space, not the address space of the link container. A later cross-space
publication therefore copies from the space that actually supplied the artifact.

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

The private params schema is an independent, self-contained schema document.
Captured Cells, including scoped Cells, retain their content schema and every
reachable local `$defs` entry, including concrete generic instantiations, even
when the callback only forwards or writes the capture and even after earlier
compiler stages have rebuilt the working source tree. Compiler schema resolution
therefore uses exact semantic types and the type checker's canonical program
source scope rather than transient symbols from an emitted working tree.
Every emitted descendant type node for which the compiler carries an exact
semantic type remains paired with that type: node syntax is authoritative for
compiler refinements and wrapper syntax such as `Default`, while the semantic
pairing supplies concrete generic arguments and named-type identity. Canonical
source lookup may recover non-generic local or exported declarations, but it
must never substitute an uninstantiated generic declaration such as `Box<T>`
for an authored `Box<string>`. When a detached concrete node such as `Item`
outlives a paired semantic type that has degraded to `unknown`, only that
detached named reference and its concrete canonical source declaration remain
authoritative. Generic declarations and type-parameter references are not
concrete recovery sources. Authored unions collapsed to `unknown`, and explicit
`unknown` keywords or declarations, emit the runtime-dropping unknown schema. A
materialized snapshot spread into an array is a full-shape read: its element
schema must not be shrunk to `unknown`, because the callback observes every
copied element. Calling a materialized array-snapshot method whose result
retains complete elements (`concat`, `slice`, `toReversed`, `toSpliced`, or
`with`) is likewise a full-shape read, including when the receiver is a union
of array, tuple, and branded-intersection forms. Element or array arguments
retained by `concat`, `toSpliced`, and `with` are full-shape reads as well,
including tracked payloads carried through spreads, conditional/fallback
branches, the retained right side of `&&`, and array or object literals;
control-only expressions remain path-precise. A full-shape
observation is a read capability and a retained schema path even when no
separate property access is recorded. Compiler-modeled projection and traversal
methods, such as `map`, retain their precise path semantics.
A detached synthetic node only adds structure when it still carries every
syntax-only obligation needed by that structure. In particular, an inferred
CFC alias that retains `ownerPrincipal` or a `TrustedActionWrite` UI contract
but has already erased a `WriteAuthorizedBy<..., typeof binding>` query becomes
metadata-only: it must not attach a new array or object shape that shadows the
destination cell's complete trusted schema. An unrelated descendant `typeof`
query or a writer claim on a sibling path does not satisfy the missing writer
obligation. The same rule applies to compiler-qualified
`__cfHelpers.TrustedActionWrite` and `__cfHelpers.WriteAuthorizedBy` nodes.
`Default` syntax and an explicit writer-binding query at the obligation's own
alias argument remain eligible; partial trusted metadata never becomes
authoritative merely because an exact semantic type is paired with the node.

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

The bound-list supervisor treats only a different canonical `Factory@1` state
as a row-generation replacement. A selector CFC-label update with byte-equal
factory state must not tear down or recreate stable rows. Each row computation
and handler registers the stable factory-selection link as its own dispatch
dependency and rereads that link in the consuming transaction, so the current
selector label still contributes to CFC provenance without briefly removing
the row's stream registrations. Canonical code/params/modifier changes retain
the switch-latest teardown and stale-generation fencing rules. When a
label-only selector update leaves a row's output bytes unchanged, the storage
write remains a no-op and does not retroactively relabel the prior value; the
current selector label is persisted on that stable row's next value-changing
execution.

Reactive array lowering does not support the optional JavaScript `thisArg`.
Pattern callbacks have no ambient JavaScript receiver, and the canonical list
node accepts only the bound factory, so a second array-method argument fails
compilation with a focused diagnostic. The previous transformer forwarded it
as an extra `mapWithPattern` argument that the runtime ignored; that accidental
no-op is not a compatibility contract.

### Diagnostics

Compilation or runtime fails clearly for:

- a non-portable captured function;
- a capture the schema generator cannot represent, with the authored source
  location and schema rejection instead of an internal stack trace;
- removed `patternTool` or `extraParams` authoring, with guidance to pass an
  inline `pattern(...)` closure directly;
- a plain callback, wrong factory kind, or `Default<>`-narrowed factory used in
  an incompatible factory slot, naming the factory constructor or contract
  correction rather than only TypeScript's structural mismatch;
- missing or extra closure params;
- params that fail their trusted schema;
- a second internal curry;
- an internal curry on a capture-free pattern;
- an unresolved or kind-mismatched factory ref; and
- an untransformed attempt to invoke a symbolic factory proxy.

Generated names and capture-property order are deterministic. Canonical metadata
orders strings with the repository's UTF-8 byte comparator, never
locale-sensitive collation. Transformer emission, builder normalization, and
cold bundle verification use the same comparator, including for non-ASCII JSON
paths.

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

Callback ownership and exposure are semantic rather than syntax-local. Inline
callbacks, referenced arrow functions, referenced function expressions, and
module-scoped function declarations receive the same schema injection,
FrameworkProvided validation, and scheduled materialized-factory exposure.
Moving a callback into a stable declaration must neither turn a scheduled
factory argument into a symbolic proxy nor drop a pattern's public schemas.

Version 1 requires the stored factory's canonical public schemas to equal the
call site's generated schemas after reference resolution and normalization.
When closure conversion returns a captured factory through a nested pattern,
the compiler recovers that leaf's public contract in strict provenance order:
compiler-owned metadata for the concrete builder/value first; then the
statically resolved public input schema at the binding path of the enclosing
pattern; and, when neither carries a more specific contract, the expression's
trusted Common Fabric factory type. An authored input schema may enrich only a
value already proven factory-typed by a Common Fabric alias/private brand; an
`asFactory` object alone grants no transformer or runtime authority. The
compiler attaches the recovered contract to the corresponding result type
before the enclosing pattern emits its schema. A
returned factory-valued property must therefore retain its complete nested
`asFactory` contract; it must never be widened to `true` in the enclosing
factory's `resultSchema` when the hoisted factory's own emitted result schema
has the exact factory leaf. Type-directed recovery carries only the public
kind and schemas; it never invents `FrameworkProvided` authority.
For anonymous union, nullable, and optional captures, every trusted factory arm
receives its own compiler hint while non-factory arms remain in the union. The
synthetic schema writer formats those hinted members in the semantic union
order used by ordinary type-based generation, so exact alternatives do not
reorder merely because a contract crossed a closure boundary.
When the enclosing pattern's authored public input schema supplies a complete,
flat `anyOf` or `oneOf` containing only factory alternatives and its
factory-kind counts match every trusted Common Fabric factory type arm, those
authored alternatives are authoritative as one ordered union contract. The
compiler carries them together across the private params and nested result
boundaries; it does not guess a correspondence between same-kind type arms and
therefore preserves descriptions, constraints, and other schema-only
distinctions exactly. The generated TypeScript union schema uses the canonical
`anyOf` container in either case while retaining every authored factory
alternative exactly.

Mixed unions retain their non-factory arms. When each authored factory
alternative maps unambiguously by kind to exactly one trusted factory type arm,
the compiler enriches that arm and leaves alternatives such as `null` or
`undefined` intact. This includes authored aliases such as
`type Operation = PatternFactory<I, O>`: the compiler carries the exact trusted
factory `ts.Type` with the recovered contract and uses the checker's own type
representation to select the synthetic alias arm. Alias text is only a lookup
representation after factory provenance and input/output types are proven; it
never grants factory authority. A non-unique same-kind match fails closed.
Only a union whose authored factory alternatives truly cannot be mapped
without guessing is a compile-time error. Once authored factory metadata is
discovered, an ambiguous mapping must never silently fall back to type-derived
contracts.
For a pattern factory, `Factory@1.resultSchema` is the authored public result
schema passed to `pattern()`, including reactive `asCell` annotations. The
pattern graph may separately use a link-sanitized result schema that strips
non-stream `asCell` markers because result documents store links; that internal
storage schema must never replace the public schema in factory state. Otherwise
a valid factory whose result contains `Writable` values fails exact call-site
contract validation during materialization.

That public contract belongs to the factory and the compiler-generated call
site, not to a live invocation's result-view cell. The serialized graph keeps
its separate link-sanitized schema as described above. The result view remains
schema-unconstrained so a downstream whole-result capture does not merge the
authored contract into the current payload (which can make opaque values such
as VNodes unreadable). When compiler-only closure binding needs the schema of a
symbolic child-result path, it derives that path from the trusted producing
`Factory@1.resultSchema`. It must not attach the public result schema to the
live view merely to transport contract metadata. Dynamic confidentiality
labels propagated onto that result view remain authoritative; closure-contract
validation combines those live labels with the producing factory's public
content schema rather than letting an IFC-only view schema hide the contract.

Any transformer decision that grants factory call, capture, or trusted metadata
semantics, including emission of an `asFactory` schema, requires the public
alias or private factory-brand symbol to resolve to a Common Fabric declaration.
A declaration is Common Fabric only when the compiler/runtime-module resolver
has registered that exact TypeScript `SourceFile` object as trusted for the
current `TypeChecker`. Module specifier strings and file paths are resolution
inputs, never authority: an authored relative file named `commonfabric.d.ts`,
an authored path resembling `packages/api`, and an ambient declaration for
`commonfabric` or `@commonfabric/*` remain untrusted even when they reproduce
the public aliases and private-brand spelling exactly. Real workspace/package
API sources and virtual runtime declarations gain authority only through the
same compiler-owned registration after module resolution.
That registration stays bound to the resolver-supplied source bytes through
program assembly. Before a single or batched compile registers a trusted name,
the resolved program must contain exactly the source the trusted resolver
returned. An authored source may not shadow a trusted source name, and batch
unioning must reject the collision in either input order rather than retaining
one source while carrying authority from the other. Test harnesses that accept
authored virtual files and compiler-owned type maps enforce the same separation.
The same exact-source rule covers other schema-generation privileges. Reserved
computed keys (`UI`, `NAME`, `SELF`, and `FS`) receive their Common Fabric
meaning only when their symbol comes from a registered declaration source, and
`Default<T, V>` may change property optionality only when its resolved alias
does too. An arbitrary unique symbol with a reserved spelling, a locally
authored `Default`, or either declaration placed at a Common-Fabric-looking
file path remains ordinary authored TypeScript. Compiler-created
`__cfHelpers.<key>` nodes may use the reserved-key fast path only when the
compiler explicitly marks that lookup as synthetic authority; the helper's
spelling alone is insufficient.
A user-defined type merely named
`PatternFactory`, `ModuleFactory`, or `HandlerFactory` remains an ordinary
callable type and schema generation must never emit `asFactory` for it.
Compiler-owned synthetic contracts instead carry explicit schema hints; those
hints provide their exact public schemas without granting authority to a
structurally similar authored type.
Because JSON Schema defines `enum` as a set, normalization compares its members
independently of array order while still requiring the exact same member values.
This permits schema sanitization and Fabric round-tripping to reorder an enum
without creating a false factory-contract mismatch; no other array-valued
keyword is made order-insensitive by this rule. Schema variance is deferred.
Local URI-fragment JSON Pointers are split into segments before percent decoding,
so a `%2F` names a slash inside one property rather than a path separator.
Every `argumentSchema`, `resultSchema`, `contextSchema`, and `eventSchema`
inside a nested `asFactory` contract is an independent JSON Schema document.
Canonical schema writers generate each field in a fresh document context and
attach the complete transitive local `$defs` subset required by that field;
they never reuse the containing schema's definition accumulator. Ordinary
recursive data remains finite through local refs and every emitted field must
therefore satisfy `factorySchemasEqual(field, field)`, as must the containing
argument, result, or closure-params schema.
Normalization resolves its local `$ref`s against that field's own root and
applies the same rule recursively to deeper factory contracts, while retaining
object-cycle detection across document boundaries. A nested contract cannot
borrow `$defs` from its containing value schema. Valid recursive local refs are
canonicalized as structural back-edges, so independently allocated or
equivalently inlined recursive documents compare and terminate. Recursion
structure after ref resolution and every ordinary keyword remain exact.
Public `Schema<>` inference follows the same independent roots and preserves
finite nested factory contracts as callable types, subject to its bounded
recursion guard; it never resolves a factory-public `$ref` from the containing
value schema's `$defs`.
Unresolved, external, or malformed refs and direct JavaScript object cycles
fail closed.
There is one representability boundary: a factory contract that recursively
contains the same factory contract would require an infinite tree of
independently rooted documents. The schema writer rejects that higher-order
cycle with a source-located compile diagnostic. It must not emit a bare
`{ "$ref": "#" }` back-edge, silently widen the repeated contract, borrow an
ancestor's `$defs`, or expand until resource exhaustion.
Normalization also preserves every own schema key (including `__proto__`) in
prototype-safe maps; browser object accessors cannot erase a contract difference.
The resolved trusted artifact is authoritative; wire-carried schema hints never
grant execution or CFC authority.

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
contract. Scheduled preparation selects exactly one matching `oneOf`/`anyOf`
factory alternative by kind and normalized public schemas; it never
double-materializes one value through sibling contracts. Factory discovery
through recursive schemas treats an in-progress cycle result as provisional,
so mutual recursion cannot memoize a false negative before a later branch finds
the factory leaf. Schema generation also keeps each carried public contract in
one cycle-aware schema document: a recursive input or result terminates through
that document's local `$defs` rather than recursively starting a fresh schema
document for every nested factory occurrence.

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

Replaying the same canonical `Factory@1` state is a no-op while the selection
has an active child or a still-valid readiness attempt. It is not a no-op after
that selection's readiness attempt failed: a later selector notification,
including a redirect retarget to the same canonical factory state, creates a
fresh generation, rereads source provenance, and may retry. This applies to
both artifact loading and named execution-space resolution. Source provenance
is also part of the ownership of a pending readiness attempt: if a redirect
retargets from source A to source B while preserving byte-equal canonical
factory state, the supervisor starts B's readiness in a fresh generation
immediately rather than waiting for A to settle. Replaying the same state
through the same source chain remains a no-op. Any later completion or
rejection from A is fenced and cannot instantiate or report against B. More
generally, if A is cold and B is selected before A finishes loading, A may
populate the trusted artifact cache but can never instantiate; completion is
fenced by owner and selection generation, and the resumed attempt rereads the
binding. A deterministic missing/forged/wrong-kind/schema failure fails the
current generation closed but a later valid selection may recover. A
source-load or space-resolution rejection also fails the current preparation
attempt; a later selector/input change begins a fresh one.

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
attached. Every queued intent also retains its original monotonic enqueue
sequence; when several events park on shared cold readiness, reinsertion by that
sequence preserves FIFO order rather than reversing promise-continuation order.
If a durable handler-stream link reaches a renderer before its runner-owned
handler registration is live, the scheduler parks the event while starting the
owning piece. The exact matching registration hydrates that load-pending intent
immediately, even when the broader piece-start promise is still waiting on
other startup work; otherwise the parked FIFO head and piece startup can wait
on each other indefinitely. A successful root piece start is not evidence that
a nested list/dynamic handler has registered yet: the event remains parked for
that exact registration. A failed piece start settles it as an error. This rule
applies only to an intent that had no registration when queued. It does not
retarget an event already captured by an older handler generation into a
replacement registration. Runtime teardown is a terminal owner cancellation:
it settles any still-load-pending intent before waiting for scheduler
quiescence, rather than hanging disposal on a handler that can no longer
register.
Readiness waiting is distinct from an authored handler attempt and does not
consume the event's commit-retry budget, call its final callback, or mint a
receipt. One parked attempt performs one event-driven artifact preparation; it
does not synthesize commit-style `readyToRetry` errors or use timer backoff
around a read-only load. Missing/forged/wrong-kind/schema failure, or a
source-load rejection, fails that attempt closed. Canonical publication's
artifact-before-ref guarantee above prevents a durable ref from being stranded
behind a later artifact-only arrival. A resumed list coordinator's separate row
pre-sync is recoverable supervisor work: a transient row-sync rejection settles
the parked attempt without recording the ready key, so the scheduler reruns the
coordinator and starts a fresh pre-sync. The enclosing handler stream
subscription remains active so it can receive the event, but no handler body,
normal success receipt/result graph,
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
handler factories.

There are three cold entry paths: non-transactional Promise-based root
`setup(undefined, ...)`, a direct dynamic node, and scheduled `lift`/handler
input readiness. Root setup waits because the parent graph cannot be built
without its root artifact; synchronous `run()` and transaction-bound setup do
not enter this path. The other cold paths delay only the consuming
node/attempt/event and always reread current state after loading. Linked values
load from the resolved link's source space. A by-value Factory loads from its
containing space; the publication protocol guarantees that the server never
confirms the containing value without its content-addressed source closure,
while preserving immediate speculative local visibility. This applies equally
to stored Cells, handler event payloads, result bindings, query-result writes,
runtime-client, CLI, and FUSE writes.
The bare `Factory@1` wire state remains only `{ identity, symbol }` and never
names or grants an artifact source space.

Root setup and synchronous `run()` accept first-class pattern and module
factories, but not a first-class handler factory. The runner rejects
`kind: "handler"` from canonical factory state before loading source or writing
piece state, identically for a trusted live factory and a decoded shell.
Transaction-bound setup and `run()` perform the same check synchronously;
Promise-based non-transactional setup rejects its returned promise. This
first-class kind check does not reclassify legacy raw module/handler execution
descriptors, whose compatibility path remains separate.

An `$implRef` does not feed this resolver as a factory ref. It names only an
implementation function and omits module/handler configuration. The surrounding
serialized execution-module descriptor resolves that implementation through
the current descriptor path; Factory@1 state always uses the complete builder
artifact ref instead.

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
every invocation adapter strips them from its authored/model-facing schema,
injects them from the stable callable or tool instance identity, and overwrites
any authored value before the synthetic forwarding path carries the trusted
value to the ultimate call. This includes LLM, CLI, and FUSE entry points.
Wrapper chains repeat the same transitive forwarding. A nested shorthand
proven to originate from callback argument 0 is forwarded as one trusted
subtree alias. The transformer does not enumerate its static type, so ordinary,
union-only, and index-signature siblings remain intact while every protected
leaf comes from the trusted argument exactly once. If that complete alias
cannot be proven, compilation fails closed rather than reconstructing a partial
object, inserting a duplicate protected key, or weakening its provenance.

CLI and FUSE materialize the trusted base factory before publishing help or
parsing arguments, because `FrameworkProvided` paths deliberately do not live
in `Factory@1` wire state. They omit those paths from help/flag schemas. Their
stable identity is derived from the containing callable call-site Cell,
including its path, not from the linked source/artifact Cell. Raw JSON may
contain the same property names syntactically, but adapters overwrite marked
paths; if the call-site identity cannot be derived, invocation fails closed.
If execution temporarily reconstructs the tool through another Cell, that Cell
is an implementation detail and does not replace the durable call-site
identity. Removing a nested protected path also removes any now-system-only
required ancestor from the authored help and flag schema.

This transitive obligation is compiler-owned provenance of the specific wrapper
declaration, not a property of its structural TypeScript factory type. Two
wrappers may intentionally expose identical public `PatternFactory<I, O>` types
while forwarding different protected paths. The compiler therefore carries the
augmented exact input schema and protected paths from the wrapper declaration to
the corresponding `typeof wrapper` type use, through local or imported type
aliases, and to the symbolic call site. This propagation is independent of
source-file transformation order: compiling a consumer before the module that
declares its wrapper must produce the same contract as the reverse order. The
emitted `asFactory.argumentSchema` includes the synthesized required fields so stored
first-class values have the exact materialization contract, but the trusted
paths remain out-of-band compiler/artifact metadata and are emitted only on the
dynamic invocation contract. They are never emitted as authored `asFactory`
authority. A shared structural-type cache must not merge or select between
different wrappers' obligations. A callable union has compiler-owned authority
only when every alternate factory arm carries its own provenance and their
exact schemas and protected paths agree. One provenanced arm must never lend
its paths to an unprovenanced arm; partial provenance fails closed.

Synthesizing a required protected path intersects that requirement with the
existing input schema. It may narrow a compatible `object | null` type to
`object`, but never weakens an impossible `false` schema or replaces a
scalar-only schema at the root or an intermediate child. Incompatible existing
constraints remain as an explicit intersection, even when that makes the
result unsatisfiable. Ordinary compatible object schemas stay in the canonical
top-level `properties` / `required` form.

Forwarding analysis follows only a proven factory call or its supported
direct-const-alias and `asScope` / `inSpace` modifier chains. Those derivations
preserve the source factory's exact contract and protected paths. It does not
recurse through arbitrary object containers or method receivers: an input
object having a privileged factory in one property does not make an unrelated
sibling call such as `input.text.toUpperCase()` a factory invocation.

FUSE reserves the `fvj1:` string prefix for explicit Factory codec projections.
JSON containing a malformed reserved tag is a write error; handler-file parsing
falls back to convenient bare text only when JSON parsing itself fails, never
when tagged Factory decoding fails.

Authored code may neither supply a literal for such a field nor capture a
chosen value and forward it. If a required system value or stable tool identity
is unavailable, invocation fails closed.

The same rule applies when the call occurs in a materialized `lift` or handler
callback: required paths come from trusted compiler/artifact metadata resolved
for the base factory, never from `Factory@1`, authored event/context data, or a
closure capture. An authored `asFactory` schema therefore contributes no
`frameworkProvidedPaths` contract at all: omission means "not an authority
source," not an exact empty obligation set. Exact comparison is reserved for a
compiler-owned dynamic-node contract that explicitly carries the field.

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

The repository is pre-launch. On 2026-07-12 the product/runtime owner confirmed
that deployed patterns and persistent stores need not survive this change and
approved wiping pre-launch data. The `$patternRef`, `patternTool`,
`PatternToolResult`, `{ pattern, extraParams }`, two-argument `*WithPattern`, and
sibling list-params readers and writers were therefore removed together.

Canonical writers emit Factory@1, and a supported-source inventory prevents the
removed APIs and writers from returning. `$implRef` remains because it is a
current execution-module descriptor field, not a legacy factory representation.

Factory-function `toJSON()` compatibility remains until every Fabric boundary
is proven to dispatch through registered codecs. It emits the full graph, never
the retired `$patternRef` sentinel. This does not affect canonical Factory@1
storage, hashing, memory, CLI, FUSE, or LLM boundaries.
Canonical FUSE projection must inspect the original registered callable before
JavaScript invokes a legacy `toJSON()` hook on it.

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

### Stage 4: Migrate `patternTool`

Migrate source callers to inline wrapper patterns and canonical Factory@1 tool
values.

### Stage 5: Pre-launch compatibility cleanup

Apply the owner-approved data-wipe decision, remove the retired APIs/readers,
pin their absence with source inventory, update live docs, and archive the
execution plan. Retain factory-function `toJSON()` until its separate codec-
dispatch gate passes.

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
  directly.
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
  publishes the artifact closure without adding source authority to the wire.
- Preserve synchronous speculative visibility for warm and cold by-value
  publication; hold later wire commits behind a cold lower `localSeq` while
  allowing them to read its pending overlay.
- Publish concurrent identical closures idempotently; reject different content
  under the same artifact identity as an integrity failure.
- Exercise factory publication through arrays, codec-backed Fabric instances,
  ordinary output bindings, writable query-result proxies, runtime-client, CLI,
  and FUSE.
- Preserve CFC labels on the selection read and fail closed on forged refs or
  metadata.
- Pin Stage 0's warm synchronous `run()` and cold asynchronous `setup()` split.

### Tool migration

- Use an inline pattern that captures entries as an LLM tool.
- Wrap a tool with a framework-provided `sandboxId`; verify synthetic forwarding
  from the wrapper tool identity and reject or overwrite authored/captured values
  through LLM, CLI, and FUSE invocation.
- Discover and invoke the same tool through runtime, CLI, and FUSE paths.
- Reject the removed legacy tool and sibling-list shapes.
- Verify no source caller or stored writer emits `extraParams`.

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
7. `patternTool`, `$patternRef`, `extraParams`, and sibling list params have no
   supported source writer or reader path; their pre-launch removal decision is
   recorded in the implementation plan.
