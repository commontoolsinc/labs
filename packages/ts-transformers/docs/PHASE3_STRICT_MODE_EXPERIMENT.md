# Phase 3: Strict Mode Experiment - Results

## Experiment Overview

**Goal**: Make all functions strict like Recipe (require explicit types, no
`unknown` fallback)

**Hypothesis**: The lenient behavior (using `unknown` fallback) is accidental,
not intentional

**Method**: Remove `unknown` fallbacks from Handler, Derive, and Lift inference
paths

## Test Results

**Total tests run**: 19 test suites **Tests passing (baseline)**: All tests
passed before changes **Tests passing (strict mode)**: 5 test suites **Tests
failing (strict mode)**: 14 test suites

### ❌ Test Failures (14 total)

#### Handler Failures (3)

1. **handler-event-only**: Only event typed, state should get unknown
   ```typescript
   handler((event: IncrementEvent, _state) => {
     console.log("increment by", event.amount);
   });
   ```
   - **Why it failed**: Strict mode requires BOTH event AND state to be typed
   - **Is this valid code?** YES - partial typing is common for handlers

2. **handler-no-annotations**: No type annotations at all
   ```typescript
   handler((event, state) => {
     console.log("event:", event, "state:", state);
   });
   ```
   - **Why it failed**: No types available
   - **Is this valid code?** YES - generic/dynamic handlers are valid

3. **handler-existing-reference**: Handler with closures
   - **Why it failed**: Inference path with partial types
   - **Is this valid code?** YES

#### Lift Failures (1)

1. **lift-untyped**: No type annotations
   ```typescript
   lift((value) => value * 2);
   ```
   - **Why it failed**: Can't infer types
   - **Is this valid code?** DEBATABLE - could be a bug or could be intentional

#### Pattern/Recipe Failures (6)

1. **counter-pattern**: Pattern with complex JSX return
2. **counter-recipe**: Recipe with complex JSX return
3. **counter-recipe-no-name**: Recipe with JSX, no name
4. **pattern-array-map**: Pattern with array mapping
5. **recipe-array-map**: Recipe with array mapping
6. **pattern-statements-vs-jsx**: Pattern inference with JSX
7. **recipe-statements-vs-jsx**: Recipe inference with JSX

   - **Why they failed**: Can't infer return type from complex JSX structures
   - **Is this valid code?** YES - JSX patterns/recipes are common

#### Integration Failures (4)

1. **opaque-ref-integration**: OpaqueRef transformer integration
2. **nested-default-optional**: Complex type inference
3. **handler-object-literal**: Handler with object literal state
4. Various closure transformation tests

## Analysis: Bugs vs Valid Code

### ✅ Valid Code That Broke (Most Failures)

**Handler partial typing** - Common and intentional:

```typescript
// Only care about the event, not the state
handler((event: ClickEvent, _state) => {
  analytics.track(event);
});
```

**Verdict**: This is valid, common code that SHOULD work

**Handler with no types** - Dynamic/generic handlers:

```typescript
// Generic debug handler
handler((event, state) => {
  console.log("Debug:", event, state);
});
```

**Verdict**: This is valid for debugging, logging, forwarding

**Complex return type inference** - JSX and complex structures:

```typescript
pattern((state) => {
  return {
    [UI]: <div>{state.count}</div>,
    count: state.count,
  };
});
```

**Verdict**: TypeScript can't always infer complex return types - valid code

### ⚠️ Potentially Buggy Code

**Lift with no types**:

```typescript
lift((value) => value * 2);
```

**Verdict**: AMBIGUOUS - could be intentional (polymorphic) or a bug (forgot
types)

## Key Findings

### 1. Handler Leniency Is Intentional

Handler's ability to accept partial types is NOT a bug - it's essential for
common patterns:

- Debug/logging handlers (no need for precise types)
- Event-only handlers (don't care about state)
- State-only handlers (don't care about event details)

**Breaking these would harm developer experience significantly.**

### 2. JSX Return Type Inference Is Hard

TypeScript often can't infer return types from complex JSX structures. Requiring
explicit types would force developers to write:

```typescript
// Current (works):
pattern((state: State) => {
  return <div>{state.count}</div>;
});

// Strict mode would require:
pattern<State, ComplexJSXReturnType>((state: State) => {
  return <div>{state.count}</div>;
});
```

**This is significantly worse DX for a common case.**

### 3. Different Functions Have Different Needs

The test failures reveal **semantically meaningful differences**:

| Function           | Partial Types Valid? | Reason                                |
| ------------------ | -------------------- | ------------------------------------- |
| **Handler**        | ✅ YES               | Event-driven, dynamic nature          |
| **Lift**           | ⚠️ MAYBE             | Could be polymorphic OR buggy         |
| **Pattern/Derive** | ✅ YES               | Complex returns hard to type          |
| **Recipe**         | ❌ NO                | Top-level definitions should be typed |

## Recommendations

### ❌ Do NOT Enforce Uniform Strict Mode

The experiment shows that **strict mode breaks valid, common code patterns**.

The lenient behavior is NOT accidental - it serves real use cases:

- Handler's unknown fallback enables dynamic/debug handlers
- Pattern/Derive/Lift's partial type support handles complex inference cases

### ✅ Keep Differentiated Policies

**Recommendation**: Document the intentional design differences

| Function    | Policy   | Rationale                                  |
| ----------- | -------- | ------------------------------------------ |
| **Recipe**  | Strict   | Top-level, reusable - should be well-typed |
| **Handler** | Lenient  | Event-driven, dynamic - unknown is valid   |
| **Pattern** | Flexible | Complex JSX returns - inference optional   |
| **Derive**  | Moderate | Reactive transform - tries to infer        |
| **Lift**    | Moderate | Wraps functions - tries to infer           |

### ✅ Improve Documentation

Instead of enforcing uniformity, document the design:

1. **Why** each function has its policy
2. **When** to use explicit types vs relying on inference/fallback
3. **Examples** of common patterns for each function

### ⚠️ Consider Warnings (Not Errors)

For potentially buggy cases like `lift((x) => x * 2)`, consider:

- TypeScript compiler warnings (not transformation failures)
- Linter rules to encourage explicit types
- Documentation about when types are recommended vs required

## Conclusion

**The unification hypothesis was WRONG** for fallback policies.

The current differentiated behavior is **intentional and correct**:

- Recipe's strictness enforces quality for reusable components
- Handler's leniency enables dynamic event handling
- Pattern/Derive/Lift's flexibility handles complex type inference

**Breaking changes from strict mode**: 14 test failures, mostly valid code

**Recommendation**: Revert strict mode changes, document the intentional design

## Next Steps

1. **Revert Phase 3 changes** (strict mode experiment)
2. **Update Phase 3 in master plan**: Mark as "investigated, differences are
   intentional"
3. **Create design documentation**: Explain why each function has its policy
4. **Consider Phase 4**: Type parameter handling (may still be valuable)

## Files for Cleanup

To revert strict mode:

- `packages/ts-transformers/src/transformers/schema-injection.ts`
  - Lines 464-486 (Handler)
  - Lines 582-591 (Derive)
  - Lines 655-676 (Lift)
