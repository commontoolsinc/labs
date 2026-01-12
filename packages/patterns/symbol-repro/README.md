# CELL_BRAND / CELL_INNER_TYPE Declaration Emit Issue

## Summary

TypeScript's declaration emit fails with "private name 'CELL_BRAND'" when a pattern
returns an array containing `HandlerFactory` mixed with any other branded cell type.

## Root Cause

**The issue is a mismatch between pre-transformation types and post-transformation code.**

1. TypeScript's declaration emit runs on **pre-transformation** code
2. `action()` has type `ActionFunction` which returns `HandlerFactory<T, void>`
3. At runtime, the CTS transformer rewrites `action(() => ...)` to `handler(...)({...})`
4. But declaration emit sees the untransformed types

When TypeScript tries to emit a declaration for an array containing `HandlerFactory`
mixed with other cell types, it must expand the union type. This expansion hits:

```
HandlerFactory<T, R>
  → Handler<T, R>
    → { with: (inputs: Opaque<StripCell<T>>) => Stream<R> }
      → StripCell uses AnyBrandedCell<infer U>
        → AnyBrandedCell has [CELL_BRAND] and [CELL_INNER_TYPE]
          → These are `unique symbol` = "private names" ❌
```

## Why action() + computed() FAILS but handler()({}) + computed() WORKS

| Expression | Type | In Mixed Array |
|------------|------|----------------|
| `action(() => ...)` | `HandlerFactory<void, void>` | ❌ FAILS |
| `action(() => ...)({})` | `Stream<void>` | ✅ Works |
| `handler(...)` | `HandlerFactory<T, E>` | ❌ FAILS |
| `handler(...)({...})` | `Stream<E>` | ✅ Works |
| `computed(() => ...)` | `OpaqueCell<T>` | ✅ Works |

The key distinction:
- **Uncalled** handler/action = `HandlerFactory` = triggers expansion = ❌
- **Called** handler/action = `Stream` = no expansion needed = ✅

## What Triggers the Issue

An array in the pattern's return value containing BOTH:
1. `HandlerFactory` (uncalled `action()` or `handler()`)
2. Any other branded cell type (`OpaqueCell`, `Stream`, etc.)

## What Does NOT Trigger the Issue

| Scenario | Result |
|----------|--------|
| Array with only `action()` results (homogeneous HandlerFactory) | ✅ Works |
| Array with only `computed()` results (homogeneous OpaqueCell) | ✅ Works |
| Array with only bound `handler()` results (homogeneous Stream) | ✅ Works |
| Array with `Stream` + `OpaqueCell` (no HandlerFactory) | ✅ Works |
| Array with called `action()({})` + `computed()` | ✅ Works |
| Separate arrays for HandlerFactory and other types | ✅ Works |
| Array with `action()` + `computed()` (mixed) | ❌ FAILS |
| Array with uncalled `handler()` + `computed()` (mixed) | ❌ FAILS |

## Workarounds

### 1. Call action() to get Stream (recommended for test patterns)
```typescript
// Instead of:
const inc = action(() => count.set(count.get() + 1));
return { tests: [inc, isZero] };  // ❌ FAILS

// Do:
const incFactory = action(() => count.set(count.get() + 1));
const inc = incFactory({});  // Converts HandlerFactory to Stream
return { tests: [inc, isZero] };  // ✅ Works
```

### 2. Use bound handlers at module scope
```typescript
const inc = handler<void, { count: Cell<number> }>(
  (_, { count }) => count.set(count.get() + 1)
);

export default pattern(() => {
  const count = Cell.of(0);
  return { tests: [inc({ count }), isZero] };  // ✅ Works - already a Stream
});
```

### 3. Separate arrays by type
```typescript
return {
  actions: [inc],       // HandlerFactory array
  assertions: [isZero], // OpaqueCell array
};  // ✅ Works - no mixing
```

## Test Files

| File | Description | Result |
|------|-------------|--------|
| `01-action-only.tsx` | Array with only action() | ✅ Works |
| `02-computed-only.tsx` | Array with only computed() | ✅ Works |
| `03-handler-only.tsx` | Array with bound handlers (Streams) | ✅ Works |
| `04-handler-plus-computed.tsx` | Bound handlers + computed | ✅ Works |
| `05-action-plus-computed-FAILS.tsx` | action() + computed() | ❌ FAILS |
| `06-action-plus-handler-FAILS.tsx` | action() + bound handler | ❌ FAILS |
| `07-action-not-in-array.tsx` | Separate arrays | ✅ Works |
| `08-action-called.tsx` | action()({}) + computed() | ✅ Works |
| `09-handler-uncalled.tsx` | Uncalled handler + computed | ❌ FAILS |
| `10-two-handler-factories.tsx` | Two uncalled handlers | ✅ Works |
| `11-stream-plus-opaquecell.tsx` | Stream + OpaqueCell | ✅ Works |
| `12-summary.tsx` | Working example with fix | ✅ Works |

## Long-term Fix Options

1. **Change `unique symbol` to `symbol`** in API - breaks type inference elsewhere
2. **Skip declaration check for test patterns** - pragmatic but doesn't fix root cause
3. **Make transformer run before type checking** - architectural change
4. **Export symbol type aliases** - TypeScript limitation prevents this from working
