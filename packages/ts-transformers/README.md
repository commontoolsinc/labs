# @commontools/ts-transformers

TypeScript AST transformers that bridge natural TypeScript code and the
CommonTools runtime. Pattern authors write idiomatic TypeScript; the
transformers rewrite it into schema-annotated form for reactivity and
information flow control (IFC).

## What It Does

The transformers analyze TypeScript at compile time and:

1. **Convert TypeScript types to JSON Schemas** -
   `interface State { items: Array<{ price: number }> }` becomes a
   runtime-inspectable schema
2. **Make closure captures explicit** - Hidden variable captures become explicit
   parameters with schemas
3. **Annotate data flow boundaries** - Every `derive`, `handler`, and
   `mapWithPattern` gets input/output schemas

Example transformation:

```typescript
// Input: Natural TypeScript
state.items.map((item) => item.price * state.discount);

// Output: Schema-annotated form
state.items.mapWithPattern(
  pattern(
    inputSchema,
    outputSchema,
    ({ element: item, params: { state } }) =>
      derive(
        deriveInputSchema,
        deriveOutputSchema,
        { item, state },
        ({ item, state }) => item.price * state.discount,
      ),
  ),
  { state: { discount: state.discount } },
);
```

## Development

### Commands

```bash
deno task test              # Run all tests
deno task check             # Type-check sources
deno task fmt               # Format code
deno task lint              # Lint code
```

### Fixture-Based Testing

Tests are driven by input/expected file pairs in `test/fixtures/`:

```
test/fixtures/closures/
├── map-single-capture.input.tsx      # What the pattern author writes
├── map-single-capture.expected.tsx   # What the transformer produces
├── handler-event-param.input.tsx
├── handler-event-param.expected.tsx
└── ... (96 closure fixtures)
```

To run a specific fixture:

```bash
env FIXTURE=map-single-capture deno task test
```

To see transformed output:

```bash
deno task ct check --show-transformed test/fixtures/closures/map-single-capture.input.tsx
```

### Adding New Transformations

1. Create `test/fixtures/closures/my-new-case.input.tsx` with the natural
   TypeScript
2. Create `test/fixtures/closures/my-new-case.expected.tsx` with the desired
   output
3. Run `env FIXTURE=my-new-case deno task test` to iterate until it passes

## Architecture

### Transformation Pipeline

```
Closure → SchemaInjection → OpaqueRefJSX → SchemaGenerator
```

The closure transformer runs first on clean AST so TypeChecker node identity
works for scope detection.

### Key Transformations

| Input Pattern         | Output                                   | Purpose                   |
| --------------------- | ---------------------------------------- | ------------------------- |
| `array.map(fn)`       | `array.mapWithPattern(pattern, captures)` | Explicit closure captures |
| `expr1 * expr2`       | `derive(schema, schema, inputs, fn)`     | Data flow boundary        |
| `onClick={() => ...}` | `handler(eventSchema, stateSchema, fn)`  | Handler with dual schemas |
| `Cell<T>`             | `{ type: "...", asCell: true }`          | Writable reactive ref     |
| `OpaqueRef<T>`        | `{ type: "...", asOpaque: true }`        | Read-only reactive ref    |

## Documentation

- `docs/closure-design.md` - Closure transformation design decisions
- `docs/handler-closures-design.md` - Event handler transformation
- `docs/hierarchical-params-spec.md` - Nested parameter handling
- `ISSUES_TO_FOLLOW_UP.md` - Known issues and open questions

## Why This Matters

The schemas enable:

- **Reactivity** - Runtime knows which values to track for re-computation
- **Taint tracking** - If secret data enters a derive, the output is tainted
- **Access control** - Can this computation see this data?
- **Audit trails** - How did this value get computed?

Pattern authors write natural TypeScript. The transformers handle the complexity
of making it secure and reactive.
