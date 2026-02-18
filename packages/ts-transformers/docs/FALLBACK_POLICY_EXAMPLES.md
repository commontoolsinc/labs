# Schema Injection Fallback Policy - Examples

This document shows concrete examples of how each function behaves when type
information is missing.

## Pattern: STRICTEST - Requires Explicit Types

### ✅ Pattern with explicit types (TRANSFORMS)

```typescript
// Explicit type argument
pattern<{ count: number }>((input) => {
  return { doubled: input.count * 2 };
});

// Transforms to:
pattern(toSchema<{ count: number }>(), (input) => {
  return { doubled: input.count * 2 };
});
```

```typescript
// Explicit parameter annotation
pattern((input: { count: number }) => {
  return { doubled: input.count * 2 };
});

// Transforms to:
pattern(toSchema<{ count: number }>(), (input) => {
  return { doubled: input.count * 2 };
});
```

### ❌ Pattern without types (NO TRANSFORMATION)

```typescript
// No type arguments, no parameter annotation
pattern((input) => {
  return { doubled: input.count * 2 };
});

// Does NOT transform - stays as-is
// Pattern requires explicit types, won't infer or use unknown
```

**Philosophy**: Patterns are top-level, reusable definitions. They should be
explicitly typed.

---

## Handler: MOST LENIENT - Always Transforms

### ✅ Handler with explicit types (TRANSFORMS)

```typescript
// Type arguments provided
handler<ClickEvent, ButtonState>((event, state) => {
  console.log(event.x, event.y);
});

// Transforms to:
handler(
  toSchema<ClickEvent>(),
  toSchema<ButtonState>(),
  (event, state) => {
    console.log(event.x, event.y);
  },
);
```

### ✅ Handler with parameter annotations (TRANSFORMS)

```typescript
// Parameter types provided
handler((event: ClickEvent, state: ButtonState) => {
  console.log(event.x, event.y);
});

// Transforms to:
handler(
  toSchema<ClickEvent>(),
  toSchema<ButtonState>(),
  (event, state) => {
    console.log(event.x, event.y);
  },
);
```

### ✅ Handler with NO types (STILL TRANSFORMS!)

```typescript
// No types at all
handler((event, state) => {
  console.log(event, state);
});

// Transforms to:
handler(
  toSchema<unknown>(), // Fallback to unknown!
  toSchema<unknown>(), // Fallback to unknown!
  (event, state) => {
    console.log(event, state);
  },
);

// toSchema<unknown>() generates schema: true (accepts anything)
```

### ✅ Handler with partial types (TRANSFORMS)

```typescript
// Only event typed
handler((event: ClickEvent, state) => {
  console.log(event.x);
});

// Transforms to:
handler(
  toSchema<ClickEvent>(), // From annotation
  toSchema<unknown>(), // Fallback for missing type
  (event, state) => {
    console.log(event.x);
  },
);
```

**Philosophy**: Handlers are event-driven and dynamic. Unknown events/state are
valid. Always transform, use `unknown` as fallback.

---

## Pattern: MODERATE - Flexible Transformation

### ✅ Pattern with explicit types (TRANSFORMS)

```typescript
// Type arguments as hints
pattern<{ count: number }, { doubled: number }>((input) => {
  return { doubled: input.count * 2 };
});

// Transforms to:
pattern(
  (input) => {
    return { doubled: input.count * 2 };
  },
  toSchema<{ count: number }>(),
  toSchema<{ doubled: number }>(),
);
```

### ✅ Pattern with parameter annotation (TRANSFORMS)

```typescript
// Infers from parameter type
pattern((input: { count: number }) => {
  return { doubled: input.count * 2 };
});

// Transforms to:
pattern(
  (input) => {
    return { doubled: input.count * 2 };
  },
  toSchema<{ count: number }>(), // Inferred from parameter
  toSchema<{ doubled: number }>(), // Inferred from return
);
```

### ✅ Pattern with partial types (TRANSFORMS)

```typescript
// Only input type, no return type
pattern<{ count: number }>((input) => {
  return { doubled: input.count * 2 };
});

// Transforms to:
pattern(
  (input) => {
    return { doubled: input.count * 2 };
  },
  toSchema<{ count: number }>(),
  // No result schema - pattern accepts 0, 1, or 2 schemas
);
```

### ✅ Pattern with NO types (MINIMAL TRANSFORMATION)

```typescript
// No types at all
pattern((input) => {
  return { doubled: input.count * 2 };
});

// Transforms to:
pattern(
  (input) => {
    return { doubled: input.count * 2 };
  },
  // No schemas at all - pattern allows this
);
```

**Philosophy**: Patterns are flexible. They can work with full types, partial
types, or no types. Inference is attempted but optional.

---

## Derive: MODERATE - Accepts Partial Types

### ✅ Derive with explicit types (TRANSFORMS)

```typescript
// Explicit schemas provided
derive(
  toSchema<{ count: number }>(),
  toSchema<{ doubled: number }>(),
  someValue,
  (input) => ({ doubled: input.count * 2 }),
);
// Already has schemas, no transformation needed
```

### ✅ Derive with inferred types (TRANSFORMS)

```typescript
// Infers from argument and callback
derive(someCell, (input) => {
  return { doubled: input.count * 2 };
});

// Transforms to:
derive(
  toSchema<InferredArgType>(), // Inferred from someCell
  toSchema<InferredResultType>(), // Inferred from return
  someCell,
  (input) => {
    return { doubled: input.count * 2 };
  },
);
```

### ✅ Derive with partial types (TRANSFORMS with unknown)

```typescript
// Can't infer argument type
derive(unknownValue, (input) => {
  return { value: input };
});

// Transforms to:
derive(
  toSchema<unknown>(), // Fallback to unknown
  toSchema<{ value: unknown }>(), // Inferred from return
  unknownValue,
  (input) => {
    return { value: input };
  },
);
```

### ✅ Derive with special case: empty object (TRANSFORMS)

```typescript
// Empty object literal gets sealed schema
derive({}, () => {
  return { result: "value" };
});

// Transforms to:
derive(
  toSchema<{}>(), // Empty object = sealed
  toSchema<{ result: string }>(), // Inferred from return
  {},
  () => {
    return { result: "value" };
  },
);
```

**Philosophy**: Derive is reactive transformation. It tries hard to infer types
but accepts `unknown` when inference fails.

---

## Lift: MODERATE - Infers from Implementation

### ✅ Lift with explicit types (TRANSFORMS)

```typescript
// Explicit schemas
lift(
  toSchema<{ count: number }>(),
  toSchema<{ doubled: number }>(),
  (input) => ({ doubled: input.count * 2 }),
);
// Already has schemas, no transformation needed
```

### ✅ Lift with inferred types (TRANSFORMS)

```typescript
// Infers from function signature
lift((input: { count: number }) => {
  return { doubled: input.count * 2 };
});

// Transforms to:
lift(
  toSchema<{ count: number }>(),
  toSchema<{ doubled: number }>(),
  (input) => {
    return { doubled: input.count * 2 };
  },
);
```

### ✅ Lift with partial types (TRANSFORMS with unknown)

```typescript
// Only parameter typed
lift((input: { count: number }) => {
  return processValue(input); // Return type unclear
});

// Transforms to:
lift(
  toSchema<{ count: number }>(),
  toSchema<unknown>(), // Fallback for unclear return
  (input) => {
    return processValue(input);
  },
);
```

### ✅ Lift with NO types (TRANSFORMS with unknown)

```typescript
// No types at all
lift((input) => {
  return { value: input };
});

// Transforms to:
lift(
  toSchema<unknown>(), // Fallback
  toSchema<unknown>(), // Fallback
  (input) => {
    return { value: input };
  },
);
```

**Philosophy**: Lift wraps arbitrary functions. It infers when possible but
accepts `unknown` to enable wrapping any function.

---

## Summary Table

| Function    | Explicit Types | Partial Types                  | No Types                       | Philosophy                       |
| ----------- | -------------- | ------------------------------ | ------------------------------ | -------------------------------- |
| **Pattern** | ✅ Transforms  | ✅ Transforms                  | ❌ No transform                | Strict: patterns should be typed |
| **Handler** | ✅ Transforms  | ✅ Transforms (uses `unknown`) | ✅ Transforms (uses `unknown`) | Lenient: events are dynamic      |
| **Pattern** | ✅ Transforms  | ✅ Transforms                  | ✅ Minimal transform           | Flexible: inference optional     |
| **Derive**  | ✅ Transforms  | ✅ Transforms (uses `unknown`) | ✅ Transforms (uses `unknown`) | Moderate: tries to infer         |
| **Lift**    | ✅ Transforms  | ✅ Transforms (uses `unknown`) | ✅ Transforms (uses `unknown`) | Moderate: wraps any function     |

## Key Questions for Phase 3

1. **Is Pattern's strictness intentional?**
   - Pro: Enforces good practices for reusable components
   - Con: Less flexible than other functions

2. **Is Handler's leniency intentional?**
   - Pro: Matches event-driven paradigm (unknown events are valid)
   - Con: Masks type errors, catches problems at runtime instead of compile-time

3. **Should all functions have the same policy?**
   - Pro: Consistency, easier to learn
   - Con: May fight against each function's semantic purpose

4. **What is the `unknown` schema?**
   - `toSchema<unknown>()` generates `true` (JSON Schema that accepts any value)
   - Runtime: No validation, accepts anything
   - TypeScript: Type is `unknown`, requires narrowing
