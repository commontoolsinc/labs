# TypeScript Type Inference Investigation Results

## Executive Summary

This document summarizes our investigation into TypeScript's type inference behavior when types are underspecified or ambiguous. We specifically explored when TypeScript infers `any` vs `unknown`, with focus on unused/unreferenced parameters and object fields.

## Key Findings

### 1. TypeScript Strongly Prefers `any` Over `unknown`

**Result:** TypeScript infers `any` in 64.8% of underspecified cases (non-strict mode), and `unknown` in only 1.9% of cases.

The only scenario where TypeScript infers `unknown` automatically is:
- **Catch clause exception variables** in strict mode (TypeScript 4.0+)

```typescript
// Non-strict mode
try { throw err; } catch (e) { }  // e: any

// Strict mode
try { throw err; } catch (e) { }  // e: unknown
```

### 2. Unused/Unreferenced Function Parameters

**Finding:** Function parameters without type annotations **always** infer as `any`, regardless of whether they are used or not.

```typescript
// Completely unused - infers 'any'
function test1(x) { return 42; }

// Used but not constrained - infers 'any'
function test2(x) { console.log(x); return x; }

// Used in operations - still infers 'any'
function test3(x) { return x + 1; }

// Handler pattern - both parameters infer 'any'
const handler = (event, state) => state.value++;
```

**Key insight:** TypeScript does not analyze how parameters are used to narrow their types. Usage does not affect inference.

### 3. Object Fields Without Type Annotations

**Finding:** Object field inference depends on the initializer and strict mode.

| Scenario | Non-Strict Mode | Strict Mode |
|----------|----------------|-------------|
| `{ x: undefined }` | `{ x: any }` | `{ x: undefined }` |
| `{ x: null }` | `{ x: any }` | `{ x: null }` |
| `{ x?: number }` (no init) | `{ x?: number }` | `{ x?: number \| undefined }` |

```typescript
// Non-strict
const obj1 = { x: undefined };  // { x: any }
const obj2 = { x: null };       // { x: any }

// Strict
const obj1 = { x: undefined };  // { x: undefined }
const obj2 = { x: null };       // { x: null }
```

### 4. Class Fields

**Finding:** Class fields without type annotations or initializers infer as `any`.

```typescript
class Test {
  field1;              // any (both modes)
  field2 = undefined;  // any (non-strict), undefined (strict)
  field3?;             // any (both modes)
}
```

### 5. Variable Declarations

| Scenario | Type |
|----------|------|
| `let x;` (no initializer) | `any` |
| `let x = undefined;` | `any` (non-strict), `undefined` (strict) |
| `const x = noReturnFunc();` | `void` |
| `const x = [];` | `any[]` (inferred as empty array) |

### 6. Type Parameters vs. `any`/`unknown`

**Important distinction:** Type parameters like `<T>` are **not** `any` or `unknown`. They are type variables (TypeFlags = 262144).

```typescript
function identity<T>(x: T): T { return x; }
// T is a type parameter, not 'any'
// x has type 'T', which is constrained by usage
```

### 7. Rest Parameters

Rest parameters without type annotations infer as `any[]`:

```typescript
function test(...args) { return args; }
// args: any[]
```

### 8. Destructured Parameters

Destructured parameters without annotations infer the destructured shape with `any` for fields:

```typescript
function test({ x, y }) { return x; }
// parameter type: { x: any; y: any }
```

## When `unknown` Is Inferred

Based on our comprehensive testing, TypeScript infers `unknown` in exactly **ONE** scenario:

### Catch Clause Exception (Strict Mode Only)

```typescript
// TypeScript 4.0+ with strict mode
try {
  throw new Error("test");
} catch (e) {
  // e: unknown (strict)
  // e: any (non-strict)
}
```

This change was introduced in TypeScript 4.0 as a safety improvement, since exceptions can be any type.

## When `unknown` Is NOT Inferred

TypeScript does **NOT** infer `unknown` in these scenarios:
- ❌ Unused function parameters
- ❌ Unreferenced function parameters
- ❌ Parameters that are only logged/returned
- ❌ Object fields without initializers
- ❌ Class fields without annotations
- ❌ Variables without initializers
- ❌ Empty arrays
- ❌ Promise executor parameters
- ❌ Callback parameters
- ❌ Event handler parameters

All of these infer `any` instead.

## Implications for Schema Generation

### Our Current Approach

When generating schemas for handler event parameters, we encounter:

```typescript
handler((event, state) => { ... })
//       ^^^^^  ^^^^^
//       any    any (if not annotated)
```

### The Challenge

1. TypeScript infers `any` for the event parameter when not annotated
2. We need to decide: should we treat `any` as `true` (permissive) or something else?
3. `any` in TypeScript means "escape hatch" - no type checking
4. `unknown` means "safe any" - requires narrowing before use

### Key Question

**When we encounter `any` in our schema generator, should we:**

**Option A:** Treat it as `true` (accept any value)
- Pros: Matches TypeScript's permissive behavior
- Cons: Less type safety at runtime

**Option B:** Treat it as `{}` (empty schema)
- Pros: More restrictive, catches more errors
- Cons: Might be too strict for legitimate use cases

**Option C:** Distinguish between explicit `any` and inferred `any`
- Pros: Can handle intentional vs accidental `any` differently
- Cons: More complex, requires tracking intent

## Test Files

Three test files were created to explore these behaviors:

1. **type-inference-exploration.ts** - Comprehensive survey of 54 scenarios
2. **type-inference-strict.ts** - Comparison of strict vs non-strict mode
3. **type-inference-focused.ts** - Deep dive into unused parameters and object fields

Run them with:
```bash
deno run --allow-read --allow-env test/type-inference-exploration.ts
deno run --allow-read --allow-env test/type-inference-strict.ts
deno run --allow-read --allow-env test/type-inference-focused.ts
```

## Recommendations

1. **Document the behavior:** Make it clear that unused handler event parameters will generate permissive schemas
2. **Consider warnings:** Could emit warnings when `any` is inferred for important types
3. **Encourage explicit typing:** Documentation should recommend explicit type annotations for handlers
4. **Be consistent:** Whatever we choose for `any`, apply it consistently across the codebase

## References

- TypeScript 4.0 Release Notes: Catch clause variables (unknown in strict mode)
- TypeScript Handbook: Type Inference
- Our test results: 64.8% `any`, 1.9% `unknown` in underspecified scenarios
