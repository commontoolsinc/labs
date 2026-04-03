# @commonfabric/ts-transformers

TypeScript AST transformers that bridge authored TypeScript patterns and the
Common Fabric runtime. Pattern authors write natural TypeScript; the transformer
pipeline rewrites supported reactive constructs into explicit schema-annotated
form for reactivity and information-flow control.

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

## Review First

For the current branch shape, start here instead of inferring architecture from
older implementation notes:

- `docs/specs/ts-transformer/ts_transformers_review_guide.md`
- `docs/specs/ts-transformer/ts_transformers_target_pattern_language_spec.md`
- `docs/specs/ts-transformer/ts_transformers_lowering_contract.md`
- `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`

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
deno task cf check --show-transformed test/fixtures/closures/map-single-capture.input.tsx
```

### Adding New Transformations

1. Create `test/fixtures/closures/my-new-case.input.tsx` with the natural
   TypeScript
2. Create `test/fixtures/closures/my-new-case.expected.tsx` with the desired
   output
3. Run `env FIXTURE=my-new-case deno task test` to iterate until it passes

## Architecture

### Pipeline

```
CastValidation
→ EmptyArrayOfValidation
→ OpaqueGetValidation
→ PatternContextValidation
→ JsxExpressionSiteRouter
→ Computed
→ Closure
→ PatternOwnedExpressionSiteLowering
→ HelperOwnedExpressionSiteLowering
→ CapabilityLowering
→ SchemaInjection
→ SchemaGenerator
```

The exact current order and behavior are documented normatively in
`docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`.

### Representative Rewrites

| Input Pattern         | Output                                    | Purpose                   |
| --------------------- | ----------------------------------------- | ------------------------- |
| `array.map(fn)`       | `array.mapWithPattern(pattern, captures)` | Explicit closure captures |
| `expr1 * expr2`       | `derive(schema, schema, inputs, fn)`      | Data flow boundary        |
| `onClick={() => ...}` | `handler(eventSchema, stateSchema, fn)`   | Handler with dual schemas |
| `Cell<T>`             | `{ type: "...", asCell: true }`           | Writable reactive ref     |
| `OpaqueRef<T>`        | structural schema without `asOpaque`      | Read-only reactive ref    |

## Additional Documentation

- `docs/specs/ts-transformer/ts_transformers_review_guide.md` - concise review
  entrypoint and read order
- `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md` -
  implemented behavior inventory
- `docs/specs/ts-transformer/ts_transformers_design_deltas.md` - hardening
  follow-ups and historical deltas
- `ISSUES_TO_FOLLOW_UP.md` - narrow internal follow-up queue for remaining live
  schema questions

## Why This Matters

The schemas enable:

- **Reactivity** - Runtime knows which values to track for re-computation
- **Taint tracking** - If secret data enters a derive, the output is tainted
- **Access control** - Can this computation see this data?
- **Audit trails** - How did this value get computed?

Pattern authors write natural TypeScript. The transformers handle the complexity
of making it secure and reactive.
