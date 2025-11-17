# Closure Implementation Roadmap

_Status: Phase 1 Complete_

## Current Status

✅ **Phase 1 Complete**: Map callback transformation with selective capture
fully working

### What We Built

**Closure Transformer** (`src/closures/transformer.ts`)

- Transforms `OpaqueRef<T[]>.map()` and `Cell<T[]>.map()` callbacks with
  captures
- Emits `mapWithPattern(recipe(...), params)` calls
- Uses node identity for scope detection (runs first in pipeline)
- Selectively captures variables (excludes module-scoped and function
  declarations)

**Unified Map Builtin** (`packages/runner/src/builtins/map.ts`)

- Single builtin handles both legacy and closure-transformed modes
- Conditional logic based on `params` presence
- Legacy: `{ element, index, array }`
- Closure: `{ element, index, array, params }`

**OpaqueRef/Cell Methods** (`packages/runner/src/builder/opaque-ref.ts`)

- `map(fn)` - Legacy mode
- `mapWithPattern(recipe, params)` - Closure mode
- Both call unified `map` builtin

### Test Coverage

**15 of 16 tests pass**. The failing test (`map-nested-callback`) documents a
known type inference limitation with nested callbacks.

Test categories:

- Basic captures (single, multiple, nested properties)
- Selective filtering (module-scoped, handlers excluded)
- Edge cases (destructuring, templates, conditionals, type assertions)
- Method chains (filter→map)
- Plain arrays (not transformed)
- Cell arrays (transformed)

## Future Phases

### Phase 2: Event Handlers (Planned)

Transform event handlers with state mutations:

```typescript
// Input
<button onClick={() => state.count++}>

// Output
<button onClick={handler(
  (_, {count}) => count.set(count.get() + 1),
  {count: state.count}
)}>
```

**Open Questions**:

- Does runtime have `handler()` helper?
- How to detect which captures need mutable vs read-only access?

### Phase 3: Generic Closures (Planned)

Transform arbitrary closures:

```typescript
// Input
const computed = () => state.a + state.b;

// Output
const computed = lift(({ a, b }) => a + b).curry({ a: state.a, b: state.b });
```

**Open Questions**:

- Does runtime support `.curry()` method?
- Alternative pattern if not available?

## Recent API Changes (October 2025 Rebase)

During rebase onto main, integrated these API changes:

**Import Management**: Now centralized through `ImportRequirements`

```typescript
// Before: const id = getHelperIdentifier(factory, sourceFile, "recipe");
// After:  const id = context.imports.getIdentifier(context, { name: "recipe", module: "commontools" });
```

**Transformer Context**: Renamed for clarity

```typescript
// Before: context.transformation
// After:  context.tsContext
```

**Emitter Returns**: Simplified - helpers managed by imports, emitters return
only expressions

## Key Files

**Implementation**:

- `src/closures/transformer.ts` - Main transformer
- `packages/runner/src/builtins/map.ts` - Unified builtin
- `packages/runner/src/builder/opaque-ref.ts` - Method implementations
- `src/ct-pipeline.ts` - Pipeline configuration

**Analysis**:

- `src/ast/call-kind.ts` - Recognizes `mapWithPattern` for dataflow analysis

**Tests**:

- `test/fixtures/closures/` - 16 fixture test pairs
- `test/opaque-ref/map-callbacks.test.ts` - Integration test
