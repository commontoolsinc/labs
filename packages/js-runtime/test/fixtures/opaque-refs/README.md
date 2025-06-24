# OpaqueRef Transformation Test Fixtures

This directory contains test fixtures for the OpaqueRef TypeScript transformer. The transformer automatically converts operations on reactive values (OpaqueRef) into their reactive equivalents using `derive()`.

## What is OpaqueRef?

OpaqueRef is a type that represents a reactive value in CommonTools. It combines:
- The actual value type (e.g., `string`, `number`, `{ name: string }`)
- Methods for reactivity (`.get()`, `.set()`, etc.)

When you create a reactive value with `cell()`, you get an OpaqueRef:
```typescript
const count = cell(0); // count is OpaqueRef<number>
```

## Transformation Examples

### Simple Operations
- `count + 1` → `derive(count, _v => _v + 1)`
- `name.toUpperCase()` → `derive(name, _v => _v.toUpperCase())`
- `user.age > 18` → `derive(user.age, _v => _v > 18)`

### Multiple OpaqueRefs
- `firstName + " " + lastName` → `derive({ firstName, lastName }, ({ firstName: _v1, lastName: _v2 }) => _v1 + " " + _v2)`

### Property Access
- `person.name` → `person.name` (no transformation - returns OpaqueRef<string>)
- `person.name.length` → `derive(person.name, _v => _v.length)` (accessing property on OpaqueRef)

## Current Limitations

### Array Methods (Not Yet Supported)
```typescript
const items = cell([1, 2, 3]);
const doubled = items.map(x => x * 2);  // ❌ Not transformed
const filtered = items.filter(x => x > 2); // ❌ Not transformed
```
**Why:** Array methods on OpaqueRef<T[]> need special handling because:
1. The callback `x => x * 2` needs to be aware if `x` is an OpaqueRef
2. The result should probably be `OpaqueRef<number[]>` not `Array<OpaqueRef<number>>`
3. Requires deeper AST transformation of the callback function

### Async Operations (Not Yet Supported)
```typescript
const url = cell("https://api.example.com");
const data = await fetch(url); // ❌ Not transformed
```
**Why:** Async operations with OpaqueRef require special handling:
1. `await` unwraps promises, but should it also unwrap OpaqueRef?
2. Should this create a derived async computation?
3. How to handle errors in reactive async operations?

### Destructuring (Partially Supported)
```typescript
const user = cell({ name: "John", age: 25 });
const { name, age } = user; // ❌ Not transformed - name and age are not OpaqueRef
```
**Why:** Destructuring extracts values, losing the reactive wrapper.

## Test Files

- `binary-expressions.input/expected.ts` - Basic arithmetic and comparison operations
- `multiple-refs.input/expected.ts` - Operations involving multiple OpaqueRef values
- `nested-ternary.input/expected.ts` - Conditional expressions with OpaqueRef
- `property-access-and-methods.input/expected.ts` - Property access and method calls
- `function-calls-with-opaque.input/expected.ts` - Function calls with OpaqueRef arguments
- `jsx-expressions/*.tsx` - JSX expressions with OpaqueRef values
- `multiple-refs-operations.input/expected.ts` - Complex operations with multiple OpaqueRefs including string concatenation

## Future Enhancements

1. **Array method support** - Transform `items.map(...)` to maintain reactivity
2. **Async/await support** - Handle promises with OpaqueRef values
3. **Destructuring support** - Maintain reactivity through destructuring
4. **Performance optimizations** - Minimize derive calls for complex expressions
5. **Source maps** - Better debugging experience for transformed code