# OpaqueRef Transformer Status & Roadmap

_Last updated: 2025-09-17_

## Overview

`@commontools/ts-transformers` now houses our TypeScript AST transformers. The
package exposes the modular OpaqueRef rewrite we ship to recipe authors (via
`createModularOpaqueRefTransformer`), and `@commontools/js-runtime` now consumes
that implementation directly. This document captures the current implementation,
outstanding gaps, and the focused roadmap we intend to pursue.

## Current Implementation

### Architecture Snapshot

- **Rule-based passes** – We run a small, ordered array of rule modules
  (currently JSX expressions and schema injection) over each source file. Each
  rule performs targeted rewrites and requests imports through a shared
  transformation context.
- **Shared context** – `core/context.ts` centralises the TypeScript checker,
  cached type lookups, flag tracking (e.g., JSX depth), diagnostic reporting,
  and import management.
- **Data flow analysis** – `opaque-ref/dataflow.ts` walks expressions to collect
  reactive data flows, handles most scope boundaries, and records provenance so
  map callbacks typed as `any` can still be derived.
- **Rewrite helpers** – `opaque-ref/rewrite/**` modules handle property access,
  binary/call/template expressions, ternaries, unary `!`, and container rewrites
  using a common binding plan. Import requests are applied at the end of the
  pass.
- **Tests** – Fixture-based suites in `packages/ts-transformers/test` cover AST
  parity for JSX, schema integration, handler schema transforms, and the new map
  callback regression test.

### Recent Improvements

- **Map callback parity** – parameters annotated as `any`/`number` now derive
  correctly inside `.map` callbacks.
- **Unary `!`** – predicates like `!flag` wrap into `derive` where necessary.
- **Docs fixture** – `opaque-ref-cell-map` fixture reproduces the ct-891 case so
  we keep coverage on the new transformer.
- **Optional import handling** – the modular path defers import insertion until
  all rules run, preventing duplicate helper imports.

## Known Gaps

| Area                                                                    | Impact                                                   | Notes |
| ----------------------------------------------------------------------- | -------------------------------------------------------- | ----- |
| **Optional-chain predicates**                                           | `!cellRef?.length` still bypasses `derive`, so           |       |
| runtime may read a `Cell` eagerly.                                      | Need data flow support for                               |       |
| `PropertyAccessChain` and a rewrite that preserves optional semantics.  |                                                          |       |
| **Closures**                                                            | Functions that capture reactive values (e.g.             |       |
| `() => count + 1`) aren’t rewritten, so callbacks read opaque values at |                                                          |       |
| runtime.                                                                | Requires capture analysis and a closure rewrite rule.    |       |
| **Destructuring / spread**                                              | Patterns like `const { name } = user` or                 |       |
| `{ ...config, count: count + 1 }` still operate on raw refs.            | Object spread not yet supported.                         |       |
| **Async/await & template literals**                                     | Reactive identifiers inside                              |       |
| `await` expressions or template strings aren't wrapped automatically.   |                                                          |       |
| **Function body analysis**                                              | Only `return` statements analyzed in functions.          |       |
| Side effects and assignments are missed.                                | Causes reactive data flows to be overlooked.             |       |
| **Postfix unary operations**                                            | `x++` and `x--` not handled by emitters.                 |       |
| **Testing depth**                                                       | No unit or perf suites beyond fixtures; closure/optional |       |
| scenarios lack runtime integration coverage.                            |                                                          |       |

## Near-Term Roadmap

### Phase 0: Documentation & Planning

- ✅ Document all known gaps and limitations
- Document planned architectural improvements

### Phase 1: Foundation Cleanup

1. **✅ Rename "dependency" to "data flow"**
   - ✅ Update all type names (DependencyAnalysis → DataFlowAnalysis, etc.)
   - ✅ Update variable names throughout codebase
   - ✅ Update comments and documentation

2. **Data structure consolidation**
   - Merge internal/external scope representations
   - Create single canonical DataFlowAnalysis result
   - Eliminate duplication between nodes/dataFlows/graph

3. **✅ Fix normalization semantics** _(Partially complete, needs refactor)_
   - ✅ Stop aggressive property stripping
   - ✅ Preserve semantic differences (e.g., `a` vs `a.length`)
   - ✅ Fix parent suppression for element access
   - ⚠️ Current solution works but is architecturally unclear (see below)

4. **Context type consolidation**
   - Create base TransformContext interface
   - Minimize context variants
   - Unify shared functionality

### Phase 2: Correctness Improvements

1. **Fix function body analysis**
   - Analyze all statements, not just returns
   - Handle side effects and assignments
   - Track data flows in intermediate computations

2. **Improve parameter detection**
   - Build parameter metadata once during analysis
   - Reuse metadata throughout pipeline
   - Eliminate redundant AST walks

3. **Test enhancements**
   - Add unit tests for data flow analysis
   - Expand fixtures with edge cases
   - Add runtime integration tests
   - Test each improvement as it's implemented

### Phase 3: Architecture Extensions

1. **Optional-chain predicate support**
   - Extend data flow normalisation to recognise optional chains
   - Update unary rule to emit `derive(cellRef, ref => !(ref?.length))`
   - Add fixtures and unit coverage

2. **Closure capture rewriting**
   - Introduce capture-aware data flow walk
   - Add closure rule for wrapped reactive values
   - Cover map callbacks, inline handlers, nested closures

### Future Extensions

- **Proactive OpaqueRef conversion**: Add new rule to automatically wrap
  non-OpaqueRef values that should be reactive, leveraging the cleaned-up
  architecture to identify candidates and apply appropriate transformations

## Longer-Term Considerations

- **Async transformations** – Once closures are handled, assess whether wrapping
  reactive values inside template literals and `await` chains is still a blocker
  for recipes.
- **Performance & diagnostics** – If rule count grows, revisit lightweight
  instrumentation (timing, rule-level debug logging) rather than the heavy
  “transformation engine” originally proposed.
- **Legacy transformer sunset** – Done. `js-runtime` now imports the modular
  transformer directly; no separate legacy copy remains in that package.

## Normalization Design & Current Issues

### Problem Statement

The normalization phase (`opaque-ref/normalise.ts`) is responsible for:

1. Deduplicating expressions that refer to the same reactive value
2. Suppressing parent expressions when child expressions are more specific

However, the current implementation conflates several concerns and relies on
indirect information flow.

### Current Implementation (2025-09-19)

#### Data Flow

1. **Analysis Phase** (`dataflow.ts`):
   - Traverses AST and creates nodes for every expression encountered
   - Builds a graph with parent-child relationships
   - Separately tracks `dataFlows` array of expressions that should become
     dependencies

2. **Normalization Phase** (`normalise.ts`):
   - Groups nodes by normalized expression text
   - Applies parent suppression: if `state.items.length` exists, suppress
     `state.items`
   - **Problem**: This incorrectly suppresses needed dependencies in cases like:
     ```typescript
     state.items[state.items.length - 1];
     // Need both state.items (array access) AND state.items.length (index computation)
     ```

3. **Current Workaround**:
   - Pass `explicitDataFlows` array to normalization
   - Build set of expression texts from explicit data flows
   - Don't suppress parents that match these texts
   - **Issue**: Relies on text matching between different normalization contexts

### Architectural Problems

1. **Conceptual Confusion**:
   - Mixes graph traversal nodes with explicit dependency requirements
   - Parent suppression logic doesn't distinguish between:
     - Traversal artifacts (intermediate nodes created while walking down)
     - Explicit dependencies (values actually needed for computation)

2. **Implementation Fragility**:
   ```typescript
   // Creating fake nodes just for text comparison
   const normalized = normaliseExpression({ expression: expr } as DataFlowNode);
   const text = normalized.getText(normalized.getSourceFile());
   ```

3. **Information Loss**:
   - By the time we normalize, we've lost the connection between:
     - Which nodes were explicitly added to `dataFlows`
     - Which nodes were just traversal artifacts

### Specific Issues Fixed

1. **Element Access with Dynamic Indices**:
   - Expression: `state.items[state.items.length - 1]`
   - Problem: Parent suppression removed `state.items`
   - Fix: Don't suppress expressions explicitly in `dataFlows`

2. **Method Calls on Computed Expressions**:
   - Expression: `(item.price * (1 - state.discount)).toFixed(2)`
   - Problem: Binary expression was being added as dependency
   - Fix: Don't treat property access as data flow when it's a method call

### Recommended Refactor

#### Option A: Mark at Creation

- Add `isExplicit` flag to DataFlowNode
- Set during node creation based on whether it's added to `dataFlows`
- Parent suppression only suppresses non-explicit parents

#### Option B: Separate Tracking

- Keep `dataFlows` and graph nodes completely separate
- Use graph only for understanding relationships
- Use `dataFlows` directly for dependencies

#### Option C: Rethink Parent Suppression

- Instead of suppressing, track "access paths"
- Know that `state.items.length` implies traversal through `state.items`
- But distinguish traversal from actual dependency needs

### Test Coverage Recommendations

See "Test Coverage Analysis" section below for comprehensive testing strategy.

## Test Coverage Analysis

### Current Coverage

#### Fixture-Based Tests (`test/fixtures/`)

**Strengths**:

- Good coverage of common patterns
- Tests full transformation pipeline
- Easy to add new cases

**Weaknesses**:

- Black-box testing only
- Hard to test specific edge cases
- No visibility into intermediate states

#### Specific Test Files:

1. `jsx-property-access.expected.tsx` - Tests element access, property chains
2. `jsx-complex-mixed.expected.tsx` - Tests method calls, array operations
3. `map-callbacks.test.ts` - Tests callback parameter handling

### Critical Gaps in Coverage

1. **Parent Suppression Edge Cases**:
   - Multiple uses of same base with different property accesses
   - Deeply nested property chains with multiple references
   - Mixed computed and static accesses

2. **Method Call Variations**:
   - Chained method calls: `expr.method1().method2()`
   - Methods returning reactive values
   - Methods with reactive arguments

3. **Complex Element Access**:
   - Nested element access: `arr[arr[0]]`
   - Multiple dynamic indices: `matrix[i][j]`
   - Mixed property and element: `obj.arr[obj.index]`

4. **Normalization Edge Cases**:
   - Parenthesized expressions at different levels
   - Type assertions in various positions
   - Non-null assertions combined with other operations

### Recommended Test Additions

#### 1. Unit Tests for Normalization

Create `test/opaque-ref/normalise.test.ts`:

```typescript
// Test parent suppression logic directly
// Test expression normalization rules
// Test explicit data flow preservation
```

#### 2. New Fixtures

**`test/fixtures/jsx-expressions/element-access-complex.input.tsx`**:

```typescript
// Nested element access
state.matrix[state.row][state.col];
// Multiple references to same array
state.items[0] + state.items[state.items.length - 1];
// Computed index from multiple sources
state.arr[state.a + state.b];
```

**`test/fixtures/jsx-expressions/method-chains.input.tsx`**:

```typescript
// Chained methods
state.text.trim().toLowerCase().includes("test");
// Methods with reactive args
state.items.slice(state.start, state.end);
// Array method chains
state.items.filter((x) => x > state.threshold).map((x) => x * state.factor);
```

**`test/fixtures/jsx-expressions/parent-suppression-edge.input.tsx`**:

```typescript
// Same base, different properties in one expression
state.user.name + " (age: " + state.user.age + ")";
// Deeply nested with multiple refs
state.config.theme.colors.primary + state.config.theme.fonts.body;
```

#### 3. Integration Tests

Create `test/integration/`:

- Test that runtime correctly handles transformed code
- Verify reactivity works as expected
- Test performance characteristics

#### 4. Property-Based Tests

Use a property-based testing framework to:

- Generate random valid TypeScript expressions
- Verify transformations preserve semantics
- Check invariants (no duplicates, all deps captured)

### Testing Strategy for Refactor

1. **Before Refactor**:
   - Add all recommended tests
   - Ensure they pass with current implementation
   - Document expected behaviors

2. **During Refactor**:
   - Use tests as safety net
   - Add tests for any bugs discovered
   - Keep all tests passing

3. **After Refactor**:
   - Verify no regressions
   - Add tests for new architecture
   - Document new invariants

## Architectural Refactor Plan: Explicit Dependency Tracking

_Added: 2025-09-23_

### Problem Statement

The current implementation conflates two distinct concepts:

1. **Graph traversal nodes** - Every expression encountered while walking the
   AST
2. **Explicit dependencies** - Actual reactive values that need to be tracked

This leads to complex expressions like `state.items.filter(...).length` being
incorrectly added as dependencies when only `state.items` and `state.filter`
should be tracked.

### Current Behavior (Problematic)

When analyzing `state.items.filter(i => i.name.includes(state.filter)).length`:

1. Creates nodes for every sub-expression during traversal
2. Adds many expressions to `dataFlows` array
3. Relies on text-matching in normalization to suppress parents
4. Results in incorrect dependencies being added

### Proposed Solution: Explicit Dependency Marking

#### 1. Add `isExplicit` Flag to DataFlowNode

```typescript
export interface DataFlowNode {
  readonly id: number;
  readonly expression: ts.Expression;
  readonly canonicalKey: string;
  readonly parentId: number | null;
  readonly scopeId: number;
  readonly isExplicit: boolean; // NEW: Marks actual dependencies vs traversal artifacts
}
```

#### 2. Set Flag During Analysis

Mark nodes as explicit ONLY when they represent actual reactive dependencies:

```typescript
// In analyzeExpression, when we identify a reactive value:
if (isOpaqueRefType(type, checker)) {
  const node = recordDataFlow(expression, scope, parentId, true); // isExplicit = true
  return {
    containsOpaqueRef: true,
    requiresRewrite: false,
    dataFlows: [expression], // Add to dataFlows
    localNodes: [node],
  };
}

// For computed expressions (like property access on call results):
if (ts.isCallExpression(expression.expression)) {
  const node = recordDataFlow(expression, scope, parentId, false); // isExplicit = false
  return {
    containsOpaqueRef: true,
    requiresRewrite: true,
    dataFlows: target.dataFlows, // Propagate from target, don't add this expression
    localNodes: [node],
  };
}
```

#### 3. Update Normalization Logic

Replace fragile text-matching with explicit flag check:

```typescript
// In normaliseDataFlows:
for (const [canonicalKey, group] of grouped.entries()) {
  // Only suppress parents if ALL nodes in the group are non-explicit
  const hasExplicitNode = group.nodes.some((node) => node.isExplicit);

  if (!hasExplicitNode) {
    // Check if any child is explicit - if so, suppress this parent
    for (const node of group.nodes) {
      if (hasExplicitChildInGraph(node, nodesById)) {
        suppressed.add(canonicalKey);
        break;
      }
    }
  }
}
```

#### 4. Implementation Steps

1. **Update DataFlowNode interface** - Add `isExplicit` field
2. **Update recordDataFlow** - Accept and store `isExplicit` parameter
3. **Update analyzeExpression** - Pass correct `isExplicit` value based on
   context:
   - `true` for direct reactive value access (`state.items`)
   - `false` for computed expressions (`state.items.filter(...).length`)
4. **Update normaliseDataFlows** - Use flag instead of text matching
5. **Remove workaround** - Delete the `explicitDataFlows` parameter and
   text-matching logic
6. **Clean up logging** - Remove debug console.logs after verification

### Expected Benefits

1. **Correctness**: Only actual dependencies are tracked
2. **Clarity**: Explicit distinction between traversal and dependencies
3. **Maintainability**: No more fragile text-matching
4. **Performance**: Simpler normalization logic

### Test Cases to Verify

After implementation, these patterns should work correctly:

1. `state.items.filter(...).length` → Only `state.items` and `state.filter` as
   dependencies
2. `state.text.trim().length` → Only `state.text` as dependency
3. `state.arrays.nested[0].items.length` → Appropriate nested dependencies
4. `(item.price * (1 - state.discount)).toFixed(2)` → Only base values, not
   method calls

### Migration Risk

Low risk because:

- Changes are localized to dataflow analysis
- Existing tests will catch regressions
- Can be rolled back if issues arise

## References

- `packages/ts-transformers/src/opaque-ref/transformer.ts`
- `packages/ts-transformers/src/opaque-ref/dataflow.ts`
- `packages/ts-transformers/src/opaque-ref/rewrite/**`
- `packages/ts-transformers/src/opaque-ref/normalise.ts` (needs refactor)
- `packages/ts-transformers/test/fixtures`
- `packages/schema-generator/docs/refactor_plan.md` (historical context; see
  Linear tickets for remaining work)
