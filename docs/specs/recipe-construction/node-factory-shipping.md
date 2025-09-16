# Serializable Node Factories

## Goals

- Allow lifts, handlers, and recipes to return reusable node factories that can
  be shipped across spaces or persisted and later instantiated.
- Support partial application via a `.curry(value, argIndex = 0)` helper that
  yields another shippable node factory reflecting the bound argument.
- Use a versioned sigil format (`nodeFactory@1`) that closely mirrors the graph
  snapshot schema while capturing the additional data required to rehydrate the
  factory and any curry operations performed on it.

## User Experience

- Any node factory created by `lift`, `handler`, or builder helpers returns a
  callable object that also exposes `.toJSON()` producing the `nodeFactory@1`
  sigil.
- Recipes may return node factories or pass them into other lifts/recipes. When
  the runtime encounters a `nodeFactory@1` payload (e.g., via `Cell.get()` or as
  a recipe input), it materializes a callable node factory automatically.
- `.curry(value, argIndex = 0)` returns a new factory that records the bound
  argument. Currying is composable; each successive call appends metadata so the
  runtime can reconstruct the applied arguments before instantiation.

## Sigil Shape

Serialized form:

```json
{
  "/": {
    "nodeFactory@1": {
      "module": ReactiveModuleDescriptor | EventHandlerDescriptor,
      "program": RuntimeProgram,
      "curried": [
        {
          "index": 0,
          "value": Binding
        }
      ],
      "argumentSchema": JSONSchema,
      "resultSchema": JSONSchema | null,
      "metadata": Record<string, JSONValue> | null
    }
  }
}
```

Notes:

- `module` matches the descriptors used in `graph-snapshot.md`, including
  implementation references and descriptor-level `argumentSchema`/`resultSchema`.
- `program` stores the complete `RuntimeProgram` (as defined in
  `packages/runner/src/harness/types.ts`) so the runtime knows how to load the
  compiled artifact and entry symbol.
- `curried` is ordered; each entry binds `value` to the given `index` (0-based by
  default). `Binding` mirrors the nested binding structure from the snapshot so
  bound values can include cell links.
- `argumentSchema` on the sigil represents the effective schema after all
  currying. It must continue to describe array/prefix-array inputs.
- `resultSchema` is optional and may be omitted/`null` for handlers.
- `metadata` carries optional helper information (e.g., helper names) and may be
  omitted if unused.

## Runtime Behavior

- Deserialization: When the runtime reads a value containing the `nodeFactory@1`
  sigil, it constructs a callable factory that:
  1. Applies stored currying bindings before invoking the underlying module.
  2. Exposes `.curry` to append additional entries to `curried` and returns a new
     serialized-aware wrapper.
  3. Implements `.toJSON()` to emit the sigil.
- Invocation: Calling the materialized factory schedules a node instantiation
  identical to calling the original lift/handler. Inputs are merged with stored
  curry bindings using positional logic (array inputs) or schema-derived names.
- Integration with snapshots: When a recipe instantiates a node from a serialized
  factory, the resulting node appears in the graph snapshot exactly like a
  regular node (same descriptor, inputs, etc.). The factory sigil itself can also
  be stored in recipe state for later reuse.

## Builder Integration

- Builders surface `.curry` on node factories returned from `lift`, `handler`,
  `.map`, etc. Currying prior to returning from a recipe automatically serializes
  the bound arguments.
- Recipes accepting factories receive them as callable objects. Internally the
  runtime keeps the sigil available so passing the factory back to storage or
  another recipe preserves currying metadata.

## Open Questions

- Do we need an explicit way to specify argument names alongside indexes for
  currying when dealing with object-shaped schemas?
- Should we limit the size of serialized `RuntimeProgram` payloads by hashing or
  referencing a shared cache entry instead of embedding the entire program?
- How do we ensure backwards compatibility if the module descriptor expands? The
  sigil version (`nodeFactory@1`) gives us room to add future revisions.
