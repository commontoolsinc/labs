# Transformer Architecture Analysis

## Executive Summary

The current OpaqueRef transformer implementation demonstrates significant
architectural limitations compared to the modular, extensible design of the new
schema-generator. While functionally capable, the transformer suffers from
monolithic design, poor separation of concerns, and limited extensibility. The
schema-generator's formatter-based architecture provides a compelling blueprint
for redesigning transformers with better modularity, testability, and
maintainability.

## Detailed Analysis

### Current OpaqueRef Transformer Implementation

#### Code Organization and Structure

The OpaqueRef transformer is implemented as a single, monolithic file with
supporting utility files:

**Primary Files:**

- `opaque-ref.ts` (1,153 lines) - Main transformer implementation
- `types.ts` (395 lines) - Type detection and analysis utilities
- `transforms.ts` (1,000 lines) - Code generation and AST manipulation
- `imports.ts` (267 lines) - Import management utilities

**Architectural Issues:**

1. **Monolithic Single-Pass Design**: The transformer uses one massive visitor
   function that handles all transformation types in a single pass, creating a
   god function with complex nested conditionals.

2. **Deeply Nested Logic**: The main visitor function contains 7+ levels of
   nested if-else statements, making it difficult to follow and maintain.

3. **Mixed Responsibilities**: The transformer handles type checking, JSX
   context analysis, import management, code generation, error reporting, and
   debug logging all in one place.

4. **Complex State Management**: Multiple flags and state variables are passed
   around without proper encapsulation.

5. **Hardcoded Logic**: Transformation rules are embedded directly in
   conditional statements rather than being configurable or pluggable.

#### Separation of Concerns Issues

The current implementation violates separation of concerns principles:

**Type Detection Mixed with Transformation:**

```typescript
// From opaque-ref.ts - detection and transformation logic intertwined
if (ts.isCallExpression(node)) {
  if (ts.isPropertyAccessExpression(node.expression)) {
    const methodName = node.expression.name.text;
    const objectType = checker.getTypeAtLocation(node.expression.expression);
    if (isOpaqueRefType(objectType, checker)) {
      // Immediate transformation logic mixed with detection
      if (
        !methodExistsOnOpaqueRef && ts.isIdentifier(node.expression.expression)
      ) {
        // Complex transformation logic embedded here...
      }
    }
  }
}
```

**Context Analysis Mixed with Code Generation:**

```typescript
// Context checking, type analysis, transformation, and import management all mixed
if (ts.isConditionalExpression(node) && isInsideJsxExpression(node)) {
  const conditionContainsOpaqueRef = containsOpaqueRef(node.condition, checker);
  // ... 120+ lines of mixed logic
  return createIfElseCall(updatedNode, context.factory, sourceFile);
}
```

#### Extensibility Limitations

1. **No Plugin Architecture**: All transformations must be added to the
   monolithic visitor function.
2. **Hardcoded Transformation Types**: Debug system defines 13 transformation
   types, but they are not used architecturally.
3. **No Composition**: Different transformation strategies cannot be easily
   combined or reordered.

#### Technical Debt Examples

**1. Type System Violations:**

```typescript
const typeArguments = (sourceType as any).resolvedTypeArguments; // Unsafe cast
```

**2. String Manipulation Instead of AST:**

```typescript
const propName = ref.getText().replace(/\./g, "_"); // Fragile text manipulation
```

**3. Code Duplication:**

```typescript
// Same array defined twice in the same file
const opaqueRefMethods = ["get", "set", "key", ...]; // Line 63
// ... 40 lines later ...
const opaqueRefMethods = ["get", "set", "key", ...]; // Line 135
```

### Schema-Generator Superior Architecture

The schema-generator demonstrates superior architectural patterns with:

1. **Clear Separation via Interfaces**: TypeFormatter interface with
   supportsType/formatType methods
2. **Modular Formatter Chain**: Array of specialized formatters (CommonTools,
   Union, Intersection, Array, Primitive, Object)
3. **Unified Context Management**: GenerationContext with clean separation of
   immutable vs mutable state

## Specific Areas for Improvement

### 1. Modularity

Break the 1,150-line monolithic transformer into focused, single-responsibility
transformers using a TransformationRule interface pattern.

### 2. Extensibility

Implement plugin-based architecture with rule registration to easily add new
transformation types without modifying core code.

### 3. Error Handling

Replace basic error collection with structured error handling including context,
suggestions, and recovery strategies.

### 4. Performance

Add pre-analysis phase to identify transformation opportunities once rather than
repeatedly checking conditions.

### 5. Testing

Implement hierarchical testing strategy: unit tests for individual transformers,
integration tests for combinations, e2e for full pipeline.

## Advanced Feature Support

The current transformer architecture fundamentally limits support for advanced
JavaScript patterns that would be crucial for a production-ready reactive
system.

### Closures Support

**Current Limitation**: The transformer cannot handle OpaqueRefs captured in
closures:

```javascript
// This pattern is not supported:
const createHandler = (count: OpaqueRef<number>) => {
  return () => {
    console.log("Count is:", count + 1); // Should be derive(count, c => c + 1)
  };
};
```

**Required Architecture Changes**:

1. **Scope Analysis**: Build proper scope tree to track variable bindings
2. **Context Propagation**: Pass reactive context through closure boundaries
3. **Higher-Order Transformations**: Transform closures that capture reactive
   values
4. **Lifetime Management**: Track when reactive dependencies cross scope
   boundaries

### Destructuring & Spread Operators

**Current Limitation**: Cannot handle reactive destructuring or spread:

```javascript
// Unsupported patterns:
const { name, age } = person; // where person is OpaqueRef<{name: string, age: number}>
const updated = { ...baseConfig, count: count + 1 }; // reactive spread
```

**Required Architecture Changes**:

1. **Pattern Recognition System**: Identify destructuring patterns with reactive
   sources
2. **Context-Aware Transformations**: Transform destructured properties to
   maintain reactivity
3. **Spread Analysis**: Convert reactive spread operations to proper derive
   calls

### Async/Await Support

**Current Limitation**: No support for reactive values in async contexts:

```javascript
// Unsupported:
const result = await fetch(`/api/users/${userId}`); // where userId is reactive
const data = await processData(count + 1); // reactive computation in async call
```

**Required Architecture Changes**:

1. **Async Pattern Detection**: Identify await expressions with reactive
   dependencies
2. **Promise Wrapping**: Transform reactive async calls to maintain reactive
   flow
3. **Temporal Context**: Handle reactive values that change while async
   operations are pending

### Template Literals

**Current Limitation**: Limited support for reactive template literals:

```javascript
// Partially supported:
const message = `Hello ${name}, count: ${count + 1}`; // Should use derive
```

**Required Architecture**:

1. **Template Analysis**: Parse template literal expressions for reactive
   content
2. **Expression Extraction**: Convert reactive template parts to derive calls
3. **String Interpolation**: Maintain reactive updates in interpolated strings

### Advanced Object Patterns

**Current Limitation**: Cannot handle complex object manipulations:

```javascript
// Unsupported patterns:
const computed = Object.keys(data).map((key) => ({
  key,
  value: data[key] + 1,
}));
const merged = Object.assign({}, base, { count: count + 1 });
```

**Required Architecture**:

1. **Object Method Analysis**: Transform Object.* method calls with reactive
   arguments
2. **Dynamic Property Access**: Handle computed property names with reactive
   values
3. **Method Chaining**: Support reactive transformations in method chains

### Proper Scope Analysis

**Current Problem**: The transformer uses text-based heuristics instead of
proper scope analysis:

```typescript
// Current brittle approach:
const propName = ref.getText().replace(/\./g, "_"); // Text manipulation
```

**Required Architecture**:

1. **Scope Tree Building**: Build proper lexical scope representation
2. **Binding Resolution**: Track variable bindings and their reactive status
3. **Context Inheritance**: Properly handle scope nesting and context
   inheritance
4. **Symbol Table**: Maintain symbol information for reactive dependency
   tracking

## Key Recommendations

1. **Adopt Formatter-Based Architecture**: Break monolithic transformer into
   focused transformation rules using clear interfaces
2. **Improve Context Management**: Create unified transformation context with
   proper state separation
3. **Support Advanced Features**: Add plugin architecture, scope analysis, and
   context-aware transformations
4. **Enhance Testing and Quality**: Implement hierarchical testing with
   performance benchmarks
5. **Optimize Performance**: Use pre-analysis passes and cache type resolution
   results

The schema-generator architecture provides an excellent blueprint for these
improvements, demonstrating how modular design, clear interfaces, and proper
separation of concerns create maintainable and extensible systems.

# OpaqueRef Analysis: Reactive References in CommonTools Framework

## Executive Summary

OpaqueRef is a fundamental abstraction in CommonTools that enables reactive,
typed references to data that can be automatically transformed at compile-time.
It bridges the gap between imperative value manipulation (like `value + 1`) and
reactive programming by automatically converting direct value operations into
reactive derivations. The transformer provides seamless developer experience
while maintaining reactive data flow semantics.

## Detailed Analysis

### 1. Conceptual Foundation

#### What is OpaqueRef?

**File:**
`/Users/gideonwald/coding/common_tools/labs/packages/api/index.ts:36-40`

OpaqueRef is defined as an intersection type that combines:

- **OpaqueRefMethods<T>**: Core reactive operations (.get(), .set(), .map(),
  etc.)
- **Structural mirroring**: For objects, it provides reactive versions of all
  properties; for arrays, it provides reactive array elements

```typescript
export type OpaqueRef<T> =
  & OpaqueRefMethods<T>
  & (T extends Array<infer U> ? Array<OpaqueRef<U>>
    : T extends object ? { [K in keyof T]: OpaqueRef<T[K]> }
    : T);
```

#### Key Insight: Transparent Reactivity

The genius of OpaqueRef is that it **looks like the original data type** to
developers while being **reactive under the hood**. A `OpaqueRef<number>` can be
used in expressions like `count + 1`, but the transformer automatically converts
this to `derive(count, c => c + 1)`.

### 2. Transformer Implementation Architecture

**File:**
`/Users/gideonwald/coding/common_tools/labs/packages/js-runtime/typescript/transformer/opaque-ref.ts`

#### Core Transformation Strategy

The transformer operates on **three main principles**:

1. **Context-Aware Transformation**: Only transforms code within JSX
   expressions, avoiding transformation in recipe/handler definitions themselves
2. **Automatic Import Management**: Adds necessary imports (`derive`, `ifElse`,
   `toSchema`) when transformations are applied
3. **Type-Guided Analysis**: Uses TypeScript's type checker to identify
   OpaqueRef usage patterns

#### Major Transformation Categories

**A. JSX Expression Transformations** (Lines 1074-1089)

- **Input**: `<div>{count + 1}</div>`
- **Output**: `<div>{derive(count, c => c + 1)}</div>`

**B. Ternary to IfElse Conversion** (Lines 891-1010)

- **Input**: `{isActive ? "Yes" : "No"}`
- **Output**: `{ifElse(isActive, "Yes", "No")}`

**C. Method Call Handling** (Lines 126-204)

- **Array methods on OpaqueRef**: `values.map(...)` → `values.get().map(...)`
- **OpaqueRef methods preserved**: `.get()`, `.set()`, `.map()` remain unchanged

**D. Schema Injection** (Lines 206-373)

- **Type arguments to runtime schemas**: `handler<Event, State>(...)` →
  `handler(toSchema<Event>(), toSchema<State>(), ...)`

### 3. Type System Integration

**File:**
`/Users/gideonwald/coding/common_tools/labs/packages/js-runtime/typescript/transformer/types.ts`

#### OpaqueRef Detection Logic

The `isOpaqueRefType` function (Lines 14-107) handles complex type scenarios:

- **Union types**: `OpaqueRef<T> | undefined`
- **Intersection types**: OpaqueRef itself is an intersection
- **Type references**: Generic type instantiations
- **Type aliases**: Various naming patterns

#### Reactive Dependency Collection

The `collectOpaqueRefs` function (Lines 295-366) intelligently identifies
reactive dependencies while avoiding:

- **Function parameters**: Callback parameters shouldn't be treated as reactive
  dependencies
- **Event handlers**: `onClick` handlers receive functions, not reactive values
- **Already dereferenced values**: `.get()` calls return plain values, not
  OpaqueRefs

### 4. Transformation Examples

#### Basic Arithmetic in JSX

**Input**
(`/Users/gideonwald/coding/common_tools/labs/packages/js-runtime/test/fixtures/jsx-expressions/opaque-ref-operations.input.tsx`):

```tsx
<div>
  <p>Next: {count + 1}</p>
  <p>Double: {count * 2}</p>
  <p>Total: {price * 1.1}</p>
</div>;
```

**Output**:

```tsx
<div>
  <p>Next: {derive(count, (count) => count + 1)}</p>
  <p>Double: {derive(count, (count) => count * 2)}</p>
  <p>Total: {derive(price, (price) => price * 1.1)}</p>
</div>;
```

#### Complex Conditional Logic

The transformer handles nested ternary expressions and complex conditions by:

1. **Converting conditions to ifElse calls**
2. **Wrapping computed conditions in derive**
3. **Managing multiple reactive dependencies**

### 5. Developer Experience Design

#### Seamless Syntax

Developers write **intuitive, imperative-looking code**:

```tsx
const isEligible = age >= 18 && hasPermission;
const result = isActive ? computeResult() : fallback;
```

The transformer automatically converts this to **reactive equivalents** without
changing the mental model.

#### Error Mode

The transformer can operate in `"error"` mode instead of `"transform"` mode,
reporting where transformations would be needed:

- **JSX expression with OpaqueRef computation should use derive()**
- **Ternary operator with OpaqueRef condition should use ifElse()**

This helps teams migrate existing code or enforce reactive patterns.

### 6. Integration with CommonTools Ecosystem

#### Factory Functions

The transformer recognizes and handles factory functions specially:

- **ModuleFactory**, **HandlerFactory**, **RecipeFactory** expect `Opaque<T>`
  parameters
- Object literal reconstruction optimization: `{a: ref.a, b: ref.b}` → `ref`
  when all properties are included

#### Schema Integration

Type arguments are automatically converted to runtime schema calls:

- `recipe<InputType>(...)` → `recipe(toSchema<InputType>(), ...)`
- `handler<EventType, StateType>(...)` →
  `handler(toSchema<EventType>(), toSchema<StateType>(), ...)`

### 7. Architecture Insights

#### Compile-Time vs Runtime Behavior

**Compile-time**: The transformer analyzes TypeScript AST and rewrites
expressions **Runtime**: The rewritten code uses reactive primitives (`derive`,
`ifElse`) that maintain data flow

#### Performance Considerations

- **Selective transformation**: Only JSX expressions are transformed, avoiding
  overhead in business logic
- **Dependency optimization**: Intelligent collection of reactive dependencies
  prevents unnecessary recomputation
- **Import tree-shaking**: Only necessary reactive utilities are imported

#### Boundary Management

The transformer carefully manages boundaries between:

- **Reactive context** (JSX expressions) vs **imperative context** (recipe
  bodies)
- **OpaqueRef methods** vs **regular methods** on reactive data
- **Factory parameters** (expect Opaque) vs **regular function parameters**

## Recent Changes and Development Trends

Based on the refactor plan
(`/Users/gideonwald/coding/common_tools/labs/packages/schema-generator/refactor_plan.md`),
the OpaqueRef transformer is being moved from `packages/js-runtime` to a
dedicated `packages/ts-transformers` package as part of a broader architectural
cleanup.

**Key trends**:

1. **Separation of concerns**: AST transformers separated from runtime
   integration
2. **Better testing infrastructure**: Fixture-based tests for transformation
   verification
3. **Cleaner module boundaries**: Schema generation vs AST transformation
   clearly separated

## Recommendations

### For Framework Development

1. **Preserve the seamless DX**: The transparent syntax is OpaqueRef's killer
   feature
2. **Improve error messages**: When transformations fail, provide clear guidance
3. **Extend pattern coverage**: Consider supporting more JavaScript patterns
   (destructuring, async/await)

### For Recipe Developers

1. **Embrace the abstraction**: Write natural JavaScript, let the transformer
   handle reactivity
2. **Understand the boundaries**: Know when you're in reactive vs imperative
   contexts
3. **Use TypeScript**: The transformer relies heavily on type information for
   correctness

### For CommonTools Adoption

1. **Educational materials**: The concept of "transparent reactivity" needs
   clear explanation
2. **Migration tooling**: Error mode can help teams identify needed changes
3. **Performance profiling**: Monitor the overhead of reactive transformations
   in complex UIs

## Technical Debt and Future Work

1. **Complex expression support**: Template literals, destructuring, and spread
   operations could be better supported
2. **Performance optimization**: Minimize reactive dependencies in complex
   expressions
3. **Error handling**: Better error messages for unsupported patterns
4. **Documentation**: The transformation rules should be documented for recipe
   developers

---

This analysis reveals that OpaqueRef represents a sophisticated approach to
reactive programming that prioritizes developer experience while maintaining the
benefits of reactive data flow. The transformer is a critical piece of
infrastructure that enables CommonTools' vision of "reactive by default"
development.

# Transformer Architecture Re-implementation Plan

## Executive Summary

This plan details the step-by-step re-architecture of the CommonTools
transformer system, moving from a monolithic, brittle implementation to a
modular, extensible, and testable architecture. The new design follows the
successful patterns from the schema-generator refactor, implementing a
plugin-based transformation system with proper separation of concerns.

## ⚠️ Important Disclaimer

**This implementation plan represents our best understanding and estimates as of
this moment in time, before we have begun undertaking any of this extremely
complex architectural work.**

All aspects of this plan—including timelines, architectural decisions,
implementation phases, and technical approaches—are **subject to change** as we
proceed and learn more about:

- The true complexity of the existing codebase integration points
- Performance implications of the new architecture
- Unforeseen technical challenges in supporting advanced JavaScript features
- Testing and migration complexities that only become apparent during
  implementation
- Feedback from actual usage and development experience

This plan should be treated as a **living document** that will evolve based on
empirical evidence, practical constraints, and lessons learned during the
implementation process. We expect significant refinements and iterations as we
progress through each phase.

## 📚 Required Reading for Implementation Context

**For any future implementation work on this transformer re-architecture, the
following files must be read in their entirety to have complete context:**

### Core Analysis Documents

1. **`/Users/gideonwald/coding/common_tools/labs/packages/transformers/OPAQUE_REF_ANALYSIS.md`**
   - Comprehensive understanding of OpaqueRef concept and reactive programming
     model
   - Current transformer behavior and developer experience design
   - Integration patterns with CommonTools ecosystem

2. **`/Users/gideonwald/coding/common_tools/labs/packages/transformers/TRANSFORMER_ARCHITECTURE_ANALYSIS.md`**
   - Detailed analysis of current implementation problems and technical debt
   - Comparison with schema-generator's superior architecture patterns
   - Specific examples of "hackiness" and extensibility limitations
   - Requirements for advanced features (closures, destructuring, async/await)

3. **`/Users/gideonwald/coding/common_tools/labs/packages/transformers/IMPLEMENTATION_PLAN.md`**
   (this file)
   - Complete implementation strategy and phase breakdown
   - Architectural component definitions and interfaces
   - Testing requirements and success metrics

### Current Implementation (Legacy Code to Understand/Replace)

4. **`/Users/gideonwald/coding/common_tools/labs/packages/js-runtime/typescript/transformer/opaque-ref.ts`**
   - Monolithic transformer implementation that needs to be re-architected
   - Understanding of all current transformation patterns and edge cases
   - Legacy logic that must be preserved during migration

5. **`/Users/gideonwald/coding/common_tools/labs/packages/js-runtime/typescript/transformer/types.ts`**
   - Type detection utilities and OpaqueRef identification logic
   - Current approach to type analysis that needs improvement

6. **`/Users/gideonwald/coding/common_tools/labs/packages/js-runtime/typescript/transformer/transforms.ts`**
   - Code generation and AST manipulation utilities
   - Current transformation patterns and techniques

7. **`/Users/gideonwald/coding/common_tools/labs/packages/js-runtime/typescript/transformer/imports.ts`**
   - Import management system that needs to be centralized

### Schema-Generator Architecture Reference (Success Pattern to Follow)

8. **`/Users/gideonwald/coding/common_tools/labs/packages/schema-generator/src/schema-generator.ts`**
   - Main engine architecture with formatter chain pattern
   - Context management and state separation approach
   - Plugin orchestration and delegation patterns

9. **`/Users/gideonwald/coding/common_tools/labs/packages/schema-generator/src/interface.ts`**
   - Clean interface definitions for formatters and context
   - Type definitions that should be adapted for transformers

10. **`/Users/gideonwald/coding/common_tools/labs/packages/schema-generator/src/formatters/common-tools-formatter.ts`**
    - Example of complex, focused formatter implementation
    - Pattern for handling CommonTools-specific logic

### Testing Infrastructure and Requirements

11. **`/Users/gideonwald/coding/common_tools/labs/packages/js-runtime/test/fixture-based.test.ts`**
    - Current fixture-based testing approach and infrastructure
    - Test organization and failure reporting patterns
    - Existing test categories that need to be migrated

12. **`/Users/gideonwald/coding/common_tools/labs/packages/schema-generator/test/utils.ts`**
    - Testing utilities and patterns from successful refactor
    - Approaches to program creation, type analysis, and assertion patterns

### Project Context and Guidelines

13. **`/Users/gideonwald/coding/common_tools/labs/packages/schema-generator/refactor_plan.md`**
    - Lessons learned from successful schema-generator refactor
    - Phase-based approach and deliverable organization
    - Testing strategy and migration approaches

14. **`/Users/gideonwald/coding/common_tools/labs/CLAUDE.md`**
    - Project-wide guidelines for code style, formatting, and conventions
    - Build and test procedures, error handling patterns
    - Repository organization and best practices

### API and Type Definitions

15. **`/Users/gideonwald/coding/common_tools/labs/packages/api/index.ts`**
    - Core CommonTools API including OpaqueRef type definitions
    - Understanding of reactive primitives (derive, ifElse, etc.)
    - Integration patterns with the larger framework

**Note**: These files represent the complete knowledge base required for
implementation. Missing any of these files will result in incomplete
understanding of requirements, existing patterns, or architectural constraints.

## Current State Analysis

### Existing Implementation Issues

- **Monolithic Design**: Single 1,152-line `opaque-ref.ts` file handling all
  transformation types
- **Mixed Responsibilities**: Type detection, transformation, import management,
  and code generation all intertwined
- **Poor Extensibility**: No plugin architecture, hardcoded transformation rules
- **Limited Scope Analysis**: Text-based heuristics instead of proper AST
  analysis
- **Technical Debt**: Type system violations, string manipulation, code
  duplication

### Existing Test Infrastructure

- Fixture-based testing system already in place (`fixture-based.test.ts`)
- Test categories: AST Transformation, JSX Expression, Handler Schema, Schema
  Transform
- 4 main fixture directories with input/expected file pairs
- Good test utilities and diff visualization

## Target Architecture

### Core Design Principles

1. **Plugin-Based Architecture**: Each transformation type as a focused plugin
2. **Proper Scope Analysis**: AST-based analysis replacing text heuristics
3. **Context Management**: Unified transformation context with clear state
   separation
4. **Extensibility First**: Easy addition of new transformation rules
5. **Performance Optimization**: Pre-analysis phases and intelligent caching

### Architectural Components

```
TransformationEngine
├── Core/
│   ├── TransformationContext (unified context management)
│   ├── ScopeAnalyzer (proper lexical scope analysis)
│   ├── TypeAnalyzer (centralized type detection)
│   └── ImportManager (centralized import handling)
├── Transformers/
│   ├── BaseTransformer (shared transformation interface)
│   ├── JSXExpressionTransformer (derive calls in JSX)
│   ├── TernaryTransformer (ifElse conversions)
│   ├── MethodCallTransformer (OpaqueRef method handling)
│   ├── SchemaInjectionTransformer (type-to-schema conversion)
│   ├── ClosureTransformer (reactive closure handling)
│   ├── DestructuringTransformer (reactive destructuring)
│   ├── AsyncTransformer (async/await patterns)
│   └── TemplateTransformer (template literal handling)
├── Analysis/
│   ├── DependencyCollector (reactive dependency identification)
│   ├── ContextDetector (JSX vs imperative context)
│   └── PatternMatcher (transformation opportunity detection)
└── Testing/
    ├── TransformerTestSuite (unit test framework for transformers)
    ├── IntegrationTestRunner (combination testing)
    └── PerformanceBenchmarks (performance regression detection)
```

## Implementation Phases

### Phase 1: Core Infrastructure (Week 1-2)

#### Phase 1.1: Base Architecture Setup

**Deliverables:**

- `src/core/TransformationContext.ts` - Unified context management
- `src/core/BaseTransformer.ts` - Abstract transformer interface
- `src/core/TransformationEngine.ts` - Main orchestration engine
- `src/core/types.ts` - Core type definitions

**Key Components:**

```typescript
// TransformationContext.ts
export interface TransformationContext {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly factory: ts.NodeFactory;

  // Mutable state
  imports: ImportManager;
  diagnostics: TransformationDiagnostic[];
  performance: PerformanceMetrics;

  // Analysis caches
  typeCache: Map<ts.Node, ts.Type>;
  scopeCache: Map<ts.Node, ScopeInfo>;
  opaqueRefCache: Map<ts.Type, boolean>;
}

// BaseTransformer.ts
export abstract class BaseTransformer {
  abstract readonly name: string;
  abstract readonly priority: number;

  abstract canTransform(node: ts.Node, context: TransformationContext): boolean;
  abstract transform(node: ts.Node, context: TransformationContext): ts.Node;
  abstract reportDiagnostics(): TransformationDiagnostic[];
}

// TransformationEngine.ts
export class TransformationEngine {
  private transformers: BaseTransformer[] = [];

  register(transformer: BaseTransformer): void;
  unregister(transformerName: string): void;
  transform(
    sourceFile: ts.SourceFile,
    context: TransformationContext,
  ): ts.SourceFile;
}
```

#### Phase 1.2: Analysis Infrastructure

**Deliverables:**

- `src/analysis/ScopeAnalyzer.ts` - Proper lexical scope analysis
- `src/analysis/TypeAnalyzer.ts` - Centralized type detection
- `src/analysis/DependencyCollector.ts` - Reactive dependency identification

**Key Features:**

- Proper symbol resolution replacing text-based heuristics
- Scope tree construction for closure analysis
- Cached type analysis for performance
- Reactive dependency graph construction

### Phase 2: Basic Transformers (Week 2-3)

#### Phase 2.1: Core OpaqueRef Transformers

**Deliverables:**

- `src/transformers/JSXExpressionTransformer.ts` - Convert JSX expressions to
  derive calls
- `src/transformers/TernaryTransformer.ts` - Convert ternary operators to ifElse
- `src/transformers/MethodCallTransformer.ts` - Handle OpaqueRef method calls

**Migration Strategy:**

1. Extract existing logic from monolithic `opaque-ref.ts`
2. Refactor into focused transformer classes
3. Maintain backward compatibility with existing tests
4. Add unit tests for individual transformers

#### Phase 2.2: Schema Transformation

**Deliverables:**

- `src/transformers/SchemaInjectionTransformer.ts` - Type argument to runtime
  schema conversion
- Integration with existing schema-generator package
- Proper handling of complex generic types

### Phase 3: Advanced Features (Week 3-4)

#### Phase 3.1: Scope-Aware Transformations

**Deliverables:**

- `src/transformers/ClosureTransformer.ts` - Handle reactive values in closures
- `src/transformers/DestructuringTransformer.ts` - Reactive destructuring
  patterns
- Advanced scope analysis for context propagation

#### Phase 3.2: Modern JavaScript Patterns

**Deliverables:**

- `src/transformers/AsyncTransformer.ts` - async/await with reactive values
- `src/transformers/TemplateTransformer.ts` - Template literal handling
- `src/transformers/SpreadTransformer.ts` - Spread operator transformations

### Phase 4: Quality Assurance & Performance (Week 4-5)

#### Phase 4.1: Testing Infrastructure

**Deliverables:**

- `test/unit/` - Unit tests for individual transformers
- `test/integration/` - Integration tests for transformer combinations
- `test/performance/` - Performance benchmarks and regression tests
- Migrate existing fixture tests to new architecture

#### Phase 4.2: Performance Optimization

**Deliverables:**

- Pre-analysis phase to identify transformation opportunities
- Intelligent caching of type resolution and scope analysis
- Performance benchmarks and optimization
- Memory usage optimization for large codebases

### Phase 5: Migration & Documentation (Week 5-6)

#### Phase 5.1: Migration from js-runtime

**Deliverables:**

- Update `@commontools/js-runtime` to use new transformer package
- Maintain backward compatibility during transition
- Comprehensive migration guide

#### Phase 5.2: Documentation & Examples

**Deliverables:**

- Architecture documentation
- Plugin development guide
- Transformation rule reference
- Migration examples and best practices

## Detailed Component Specifications

### 1. TransformationContext

```typescript
export interface TransformationContext {
  // Immutable TypeScript context
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly factory: ts.NodeFactory;
  readonly options: TransformerOptions;

  // Analysis state (cached)
  readonly typeAnalyzer: TypeAnalyzer;
  readonly scopeAnalyzer: ScopeAnalyzer;
  readonly dependencyCollector: DependencyCollector;

  // Mutable transformation state
  imports: ImportManager;
  diagnostics: TransformationDiagnostic[];
  performance: PerformanceTracker;

  // Utility methods
  isInsideJSXExpression(node: ts.Node): boolean;
  isOpaqueRefType(type: ts.Type): boolean;
  collectReactiveDependencies(node: ts.Node): ts.Node[];
  reportDiagnostic(diagnostic: TransformationDiagnostic): void;
}
```

### 2. BaseTransformer Interface

```typescript
export abstract class BaseTransformer {
  abstract readonly name: string;
  abstract readonly priority: number; // Higher priority = runs first
  abstract readonly dependencies: string[]; // Transformer dependencies

  // Lifecycle methods
  abstract canTransform(node: ts.Node, context: TransformationContext): boolean;
  abstract transform(node: ts.Node, context: TransformationContext): ts.Node;

  // Optional hooks
  beforeTransform?(context: TransformationContext): void;
  afterTransform?(context: TransformationContext): void;

  // Diagnostics
  getDiagnostics(): TransformationDiagnostic[];
  clearDiagnostics(): void;
}
```

### 3. Advanced Feature Support

#### Closure Handling

```typescript
export class ClosureTransformer extends BaseTransformer {
  // Transform: const handler = () => count + 1
  // To: const handler = () => derive(count, c => c + 1)

  canTransform(node: ts.Node): boolean {
    return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
  }

  transform(node: ts.ArrowFunction, context: TransformationContext): ts.Node {
    const reactiveDependencies = this.findCapturedReactiveDependencies(
      node,
      context,
    );
    if (reactiveDependencies.length > 0) {
      return this.wrapInDeriveCall(node, reactiveDependencies, context);
    }
    return node;
  }
}
```

#### Destructuring Support

```typescript
export class DestructuringTransformer extends BaseTransformer {
  // Transform: const { name, age } = person; // where person is OpaqueRef
  // To: const name = derive(person, p => p.name); const age = derive(person, p => p.age);

  canTransform(node: ts.Node): boolean {
    return ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name);
  }

  transform(
    node: ts.VariableDeclaration,
    context: TransformationContext,
  ): ts.Node[] {
    // Convert destructuring to multiple derive calls
  }
}
```

#### Async/Await Support

```typescript
export class AsyncTransformer extends BaseTransformer {
  // Transform: const result = await fetch(`/api/users/${userId}`); // where userId is reactive
  // To: const result = await fetch(derive(userId, id => `/api/users/${id}`));

  canTransform(node: ts.Node): boolean {
    return ts.isAwaitExpression(node) &&
      this.containsReactiveValues(node.expression, context);
  }
}
```

## Testing Strategy

### Unit Testing

```typescript
// test/unit/transformers/JSXExpressionTransformer.test.ts
describe("JSXExpressionTransformer", () => {
  let transformer: JSXExpressionTransformer;
  let context: TransformationContext;

  beforeEach(() => {
    transformer = new JSXExpressionTransformer();
    context = createMockContext();
  });

  it("transforms simple arithmetic in JSX expressions", () => {
    const input = parseCode("<div>{count + 1}</div>");
    const result = transformer.transform(input, context);
    expect(result.getText()).toContain("derive(count, count => count + 1)");
  });

  it("does not transform outside JSX expressions", () => {
    const input = parseCode("const result = count + 1;");
    expect(transformer.canTransform(input, context)).toBe(false);
  });
});
```

### Integration Testing

```typescript
// test/integration/transformer-combinations.test.ts
describe("Transformer Combinations", () => {
  it("handles JSX expressions with ternary operators", async () => {
    const input = "<div>{isActive ? count + 1 : 0}</div>";
    const result = await transformWithEngine(input, [
      new JSXExpressionTransformer(),
      new TernaryTransformer(),
    ]);
    expect(result).toContain("ifElse(isActive, derive(count, c => c + 1), 0)");
  });
});
```

### Performance Testing

```typescript
// test/performance/benchmarks.test.ts
describe("Performance Benchmarks", () => {
  it("handles large files within performance thresholds", async () => {
    const largeFile = generateLargeTypeScriptFile(10000); // 10k lines
    const startTime = performance.now();
    await transformWithEngine(largeFile, allTransformers);
    const endTime = performance.now();
    expect(endTime - startTime).toBeLessThan(5000); // 5 seconds max
  });
});
```

## Migration Strategy

### Phase 1: Parallel Implementation

1. Keep existing monolithic transformer functional
2. Implement new architecture in parallel
3. Ensure test parity between old and new systems
4. Performance comparison between implementations

### Phase 2: Gradual Migration

1. Replace transformers one at a time
2. Start with JSX expression transformer (most isolated)
3. Migrate tests incrementally
4. Maintain backward compatibility

### Phase 3: Full Cutover

1. Remove old monolithic implementation
2. Update all consumers to use new API
3. Complete test migration
4. Performance verification

## Risk Mitigation

### Technical Risks

1. **Performance Regression**: Comprehensive benchmarking and optimization
   phases
2. **Breaking Changes**: Extensive test coverage and gradual migration
3. **Complex AST Patterns**: Incremental implementation with thorough testing
4. **Type Analysis Complexity**: Fallback mechanisms and error handling

### Mitigation Strategies

1. **Feature Flags**: Enable/disable new transformers individually
2. **Rollback Plan**: Keep old implementation as fallback
3. **Monitoring**: Performance and error tracking in production
4. **Documentation**: Comprehensive migration guides and examples

This implementation plan provides a clear roadmap for transforming the
monolithic transformer implementation into a modular, extensible, and
maintainable architecture that supports advanced JavaScript patterns while
maintaining backward compatibility and high performance.

# SAMPLE implementation of transformers/src/core/types.ts:

import ts from "typescript";

/**

- Unified context for TypeScript AST transformations - contains all state in one
  place
- Modeled after schema-generator's GenerationContext pattern _/ export interface
  TransformationContext { // Immutable context (set once) /_* TypeScript program
  instance _/ readonly program: ts.Program; /_* TypeScript type checker _/
  readonly checker: ts.TypeChecker; /_* Source file being transformed _/
  readonly sourceFile: ts.SourceFile; /_* TypeScript node factory for creating
  new AST nodes _/ readonly factory: ts.NodeFactory; /_* Transformer options */
  readonly options: TransformerOptions;

// Analysis state (cached for performance) /** Type analysis cache to avoid
repeated type checking _/ typeCache: Map<ts.Node, ts.Type>; /_* Scope analysis
cache for lexical scope information _/ scopeCache: Map<ts.Node, ScopeInfo>; /_*
OpaqueRef type detection cache */ opaqueRefCache: Map<ts.Type, boolean>;

// Mutable transformation state /** Import management for adding reactive
utilities _/ imports: ImportManager; /_* Transformation diagnostics and errors
_/ diagnostics: TransformationDiagnostic[]; /_* Performance tracking metrics */
performance: PerformanceMetrics;

// Context flags /** Current JSX expression depth (0 = not in JSX expression) _/
jsxExpressionDepth: number; /_* Whether we're in a reactive context that
requires transformation _/ inReactiveContext: boolean; /_* Stack of
transformation phases being applied */ transformationStack: string[]; }

/**

- Configuration options for the transformation engine _/ export interface
  TransformerOptions { /_*
  - Mode of operation:
  -
    - 'transform': Transform the code (default)
  -
    - 'error': Report errors instead of transforming */ mode: "transform" |
      "error";

/** Enable debug logging for transformations */ enableDebugLogging: boolean;

/** Enable performance profiling */ enableProfiling: boolean;

/** Custom transformer configurations */ transformerConfigs: Map<string,
unknown>; }

/**

- Information about lexical scope at a given AST node _/ export interface
  ScopeInfo { /_* Scope type _/ type: ScopeType; /_* Parent scope (null for
  global scope) _/ parent: ScopeInfo | null; /_* Variables declared in this
  scope _/ declarations: Map<string, ts.Symbol>; /_* Variables captured from
  outer scopes _/ captures: Map<string, ts.Symbol>; /_* Whether this scope is
  reactive (contains OpaqueRef values) _/ isReactive: boolean; /_* AST node that
  created this scope */ node: ts.Node; }

/**

- Types of lexical scopes */ export enum ScopeType { Global = "global", Module =
  "module", Function = "function", Arrow = "arrow", Block = "block", Class =
  "class", Loop = "loop", Conditional = "conditional", }

/**

- Manager for import statements and module dependencies _/ export interface
  ImportManager { /_* Add an import from @commontools/api */
  addCommonToolsImport(name: string): void;

/** Check if an import already exists */ hasImport(moduleName: string,
importName: string): boolean;

/** Get all required imports for the current transformation */
getRequiredImports(): ImportStatement[];

/** Clear all tracked imports */ clear(): void; }

/**

- Represents an import statement to be added _/ export interface ImportStatement
  { /_* Module to import from _/ module: string; /_* Named imports _/ names:
  string[]; /_* Default import name (if any) _/ defaultName?: string; /_*
  Whether this is a type-only import */ typeOnly: boolean; }

/**

- Diagnostic information about transformations _/ export interface
  TransformationDiagnostic { /_* Severity level _/ severity: DiagnosticSeverity;
  /_* Error/warning message _/ message: string; /_* Transformation type that
  generated this diagnostic _/ transformationType: string; /_* Source location
  _/ location: { file: string; line: number; column: number; start: number; end:
  number; }; /_* Optional suggested fix _/ suggestion?: string; /_* Related
  diagnostic information */ related?: TransformationDiagnostic[]; }

/**

- Severity levels for diagnostics */ export enum DiagnosticSeverity { Error = 0,
  Warning = 1, Information = 2, Hint = 3, }

/**

- Performance tracking metrics _/ export interface PerformanceMetrics { /_*
  Start time of transformation _/ startTime: number; /_* Time spent in each
  transformation phase _/ phaseTimings: Map<string, number>; /_* Number of nodes
  visited _/ nodesVisited: number; /_* Number of transformations applied _/
  transformationsApplied: number; /_* Cache hit rates */ cacheHitRates:
  Map<string, { hits: number; misses: number }>; }

/**

- Information about a reactive dependency _/ export interface ReactiveDependency
  { /_* The AST node representing the dependency _/ node: ts.Node; /_* The
  variable name or access path _/ identifier: string; /_* The TypeScript type of
  the dependency _/ type: ts.Type; /_* Whether this dependency is an OpaqueRef
  _/ isOpaqueRef: boolean; /_* Scope where this dependency is declared */
  declarationScope: ScopeInfo; }

/**

- Result of a transformation operation _/ export interface TransformationResult
  { /_* The transformed AST node _/ node: ts.Node; /_* Whether any
  transformation was applied _/ transformed: boolean; /_* Additional imports
  required by the transformation _/ requiredImports: string[]; /_* Diagnostics
  generated during transformation */ diagnostics: TransformationDiagnostic[]; }

/**

- Transformation rule priority levels
- Higher numbers = higher priority (executed first) _/ export enum
  TransformationPriority { /_* Highest priority - core OpaqueRef method handling
  _/ Critical = 1000, /_* High priority - JSX expression transformations _/ High
  = 800, /_* Normal priority - general transformations _/ Normal = 500, /_* Low
  priority - cleanup and optimization _/ Low = 200, /_* Lowest priority - final
  cleanup */ Cleanup = 100, }

/**

- Supported transformation types (for debugging and categorization) */ export
  enum TransformationType { JSXExpression = "jsx-expression", TernaryOperator =
  "ternary-operator", MethodCall = "method-call", SchemaInjection =
  "schema-injection", ClosureCapture = "closure-capture", Destructuring =
  "destructuring", AsyncAwait = "async-await", TemplateString =
  "template-string", SpreadOperator = "spread-operator", BinaryExpression =
  "binary-expression", PropertyAccess = "property-access", }

/**

- Context detection helpers for determining transformation applicability _/
  export interface ContextDetector { /_* Check if node is inside a JSX
  expression */ isInsideJSXExpression(node: ts.Node): boolean;

/** Check if node is in a reactive context */ isInReactiveContext(node:
ts.Node): boolean;

/** Check if node is in an event handler */ isInEventHandler(node: ts.Node):
boolean;

/** Get the current scope for a node */ getCurrentScope(node: ts.Node):
ScopeInfo | null; }

/**

- Pattern matching utilities for identifying transformation opportunities _/
  export interface PatternMatcher { /_* Check if expression contains OpaqueRef
  values */ containsOpaqueRef(node: ts.Expression): boolean;

/** Identify reactive dependencies in an expression */
findReactiveDependencies(node: ts.Expression): ReactiveDependency[];

/** Check if a method call is on an OpaqueRef */ isOpaqueRefMethodCall(node:
ts.CallExpression): boolean;

/** Check if a property access is on an OpaqueRef */
isOpaqueRefPropertyAccess(node: ts.PropertyAccessExpression): boolean; }
