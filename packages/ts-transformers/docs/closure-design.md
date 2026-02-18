# Closure Transformation Design

_Status: Complete for OpaqueRef/Cell Map Callbacks_

## Problem & Solution

Map callbacks on reactive arrays that capture variables from outer scope need
those values passed explicitly:

```typescript
// Input
state.items.map((item) => item.price * state.discount);

// Output
state.items.mapWithPattern(
  pattern(({ element, params: { discount } }) => element.price * discount),
  { discount: state.discount },
);
```

## Key Design Decisions

1. **Standalone Transformer**: Runs FIRST in pipeline on clean AST
2. **Node Identity Scope Detection**: Simple `===` checks work because we run
   before other transformers
3. **Selective Capture**: Only capture local/parameter scope variables, NOT
   module-level constants or functions
4. **Unified Runtime**: Single `map` builtin with conditional logic; separate
   `mapWithPattern()` method for clarity

## Architecture

### Pipeline Order

```
Closure → SchemaInjection → OpaqueRefJSX → SchemaGenerator
```

**Why First?** TypeChecker references original AST. Running first means node
identity (`===`) works for scope detection.

### Runtime Integration

**Two Methods, One Builtin**:

- `map(fn)` - Legacy mode: wraps function in pattern, passes
  `{ element, index, array }`
- `mapWithPattern(pattern, params)` - Closure mode: pre-wrapped pattern, passes
  `{ element, index, array, params }`

Both call the same `map` builtin which uses conditional logic based on `params`
presence.

**Benefits**:

- Stack traces clearly show `mapWithPattern` for transformed calls
- Compile-time errors for incorrect transformations
- Backward compatible with existing map usage

## Capture Rules

**DO Capture**:

- Variables from parent function scopes
- Variables from parent callback scopes (nested maps)
- Both reactive (OpaqueRef) and plain values

**DON'T Capture**:

- Module-scoped constants/functions (available everywhere)
- Function declarations (can't serialize)
- JSX element names
- Callback's own parameters
- Global built-ins

## What We Transform

**Transform**: `OpaqueRef<T[]>.map()` and `Cell<T[]>.map()` with captures
**Don't Transform**: Plain `T[].map()` or reactive maps without captures

## Known Limitations

- **Nested callbacks**: Type inference limitation when inner callback captures
  from outer callback parameter (test documents this)
- **Method chains**: Special handling for `filter().map()` patterns to detect
  origin is reactive array

## Future Phases

**Phase 2**: Event handler transformation with state mutations **Phase 3**:
Generic closure support with lift/curry pattern
