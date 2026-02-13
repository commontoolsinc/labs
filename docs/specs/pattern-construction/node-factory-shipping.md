# Serializable Node Factories

## Goals

- Allow lifts (and thus patterns) and handlers to return reusable node factories
  that can be shipped across spaces or persisted and later instantiated.
- Support partial application via a `.curry(value, argIndex = 0)` helper that
  yields another shippable node factory reflecting the bound argument.
- Use a versioned sigil format (`nodeFactory@1`) that closely mirrors the graph
  snapshot schema while capturing the additional data required to rehydrate the
  factory and any curry operations performed on it.

## User Experience

- Any node factory created by `lift`, `handler`, or builder helpers returns a
  callable object that also exposes `.toJSON()` producing the `nodeFactory@1`
  sigil.
- Passing a node factory as part of the argument to `Cell.set()` & co, or
  calling another factory with it, automatically converts it into it's JSON
  representation.
- Patterns may return node factories or pass them into other lifts/patterns. When
  the runtime encounters a `nodeFactory@1` payload (e.g., via `Cell.get()` or as
  a pattern input), it materializes a callable node factory automatically.
- `.curry(value, argIndex = 0)` returns a new factory that records the bound
  argument. Currying is composable; each successive call appends metadata so the
  runtime can reconstruct the applied arguments before instantiation.

## Sigil Shape

Serialized form:

```ts
{
  "/": {
    "nodeFactory@1":
      & BoxedNodeFactory
      & CurriedArguments
      & (ReactiveNodeNarrowedSchema | HandlerNodeNarrowedSchema)
  }
}
```

Notes:

- `BoxedNodeFactory` the descriptors used in `graph-snapshot.md`, including
  implementation references and descriptor-level `argumentSchema`/`resultSchema`
  and link to implemention.
- `CurriedArguments` contains the lists the arguments that are being supplied
  already, index defaulting to 0 or +1 the previous index.
  - For event handlers, 0 is the event stream. If it is curried, then the
    resulting function looks like a reactive node factory that can be called
    with state to bind. If it isn't curried, the result is a stream factory,
    just like the original, but bound to state.
- `ReactiveNodeNarrowedSchema | HandlerNodeNarrowedSchema` are optional
  constraints due to currying over the original schemas in the module.

## Runtime Behavior

- Deserialization: When the runtime reads a value containing the `nodeFactory@1`
  sigil, it constructs a callable factory that:
  1. Applies stored currying bindings before invoking the underlying module.
  2. Exposes `.curry` to append additional entries to `curried` and returns a
     new serialized-aware wrapper.
  3. Implements `.toJSON()` to emit the sigil.
- Invocation: Calling the materialized factory schedules a node instantiation
  identical to calling the original lift/handler. Inputs are merged with stored
  curry bindings using positional logic (array inputs) or schema-derived names.
- Integration with snapshots: When a pattern instantiates a node from a
  serialized factory, the resulting node appears in the graph snapshot exactly
  like a regular node (same descriptor, inputs, etc.). The factory sigil itself
  can also be stored in pattern state for later reuse.

## Builder Integration

- Builders surface `.curry` on node factories returned from `lift`, `handler`,
  `.map`, etc. Currying prior to returning from a pattern automatically serializes
  the bound arguments.
- Patterns accepting factories receive them as callable objects. Internally the
  runtime keeps the sigil available so passing the factory back to storage or
  another pattern preserves currying metadata.

## Rollout

- This is blocked on multi-argument `lift`.
- However, we can start with curried `pattern` (which later become a variant of
  `lift`) and instead of treating it as multiple inputs merge the input object
  instead on call. The first use-case is for actions, so we can even do this
  just there.
