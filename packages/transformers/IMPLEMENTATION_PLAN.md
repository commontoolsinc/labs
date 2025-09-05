# Transformer Architecture Re-implementation Plan

## Executive Summary

This plan details the step-by-step re-architecture of the CommonTools transformer system, moving from a monolithic, brittle implementation to a modular, extensible, and testable architecture. The new design follows the successful patterns from the schema-generator refactor, implementing a plugin-based transformation system with proper separation of concerns.

## ⚠️ Important Disclaimer

**This implementation plan represents our best understanding and estimates as of this moment in time, before we have begun undertaking any of this extremely complex architectural work.** 

All aspects of this plan—including timelines, architectural decisions, implementation phases, and technical approaches—are **subject to change** as we proceed and learn more about:

- The true complexity of the existing codebase integration points
- Performance implications of the new architecture  
- Unforeseen technical challenges in supporting advanced JavaScript features
- Testing and migration complexities that only become apparent during implementation
- Feedback from actual usage and development experience

This plan should be treated as a **living document** that will evolve based on empirical evidence, practical constraints, and lessons learned during the implementation process. We expect significant refinements and iterations as we progress through each phase.

## 📚 Required Reading for Implementation Context

**For any future implementation work on this transformer re-architecture, the following files must be read in their entirety to have complete context:**

### Core Analysis Documents
1. **`/Users/gideonwald/coding/common_tools/labs/packages/transformers/OPAQUE_REF_ANALYSIS.md`**
   - Comprehensive understanding of OpaqueRef concept and reactive programming model
   - Current transformer behavior and developer experience design
   - Integration patterns with CommonTools ecosystem

2. **`/Users/gideonwald/coding/common_tools/labs/packages/transformers/TRANSFORMER_ARCHITECTURE_ANALYSIS.md`**
   - Detailed analysis of current implementation problems and technical debt
   - Comparison with schema-generator's superior architecture patterns
   - Specific examples of "hackiness" and extensibility limitations
   - Requirements for advanced features (closures, destructuring, async/await)

3. **`/Users/gideonwald/coding/common_tools/labs/packages/transformers/IMPLEMENTATION_PLAN.md`** (this file)
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

**Note**: These files represent the complete knowledge base required for implementation. Missing any of these files will result in incomplete understanding of requirements, existing patterns, or architectural constraints.

## Current State Analysis

### Existing Implementation Issues
- **Monolithic Design**: Single 1,152-line `opaque-ref.ts` file handling all transformation types
- **Mixed Responsibilities**: Type detection, transformation, import management, and code generation all intertwined
- **Poor Extensibility**: No plugin architecture, hardcoded transformation rules
- **Limited Scope Analysis**: Text-based heuristics instead of proper AST analysis
- **Technical Debt**: Type system violations, string manipulation, code duplication

### Existing Test Infrastructure
- Fixture-based testing system already in place (`fixture-based.test.ts`)
- Test categories: AST Transformation, JSX Expression, Handler Schema, Schema Transform
- 4 main fixture directories with input/expected file pairs
- Good test utilities and diff visualization

## Target Architecture

### Core Design Principles
1. **Plugin-Based Architecture**: Each transformation type as a focused plugin
2. **Proper Scope Analysis**: AST-based analysis replacing text heuristics
3. **Context Management**: Unified transformation context with clear state separation
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
  transform(sourceFile: ts.SourceFile, context: TransformationContext): ts.SourceFile;
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
- `src/transformers/JSXExpressionTransformer.ts` - Convert JSX expressions to derive calls
- `src/transformers/TernaryTransformer.ts` - Convert ternary operators to ifElse
- `src/transformers/MethodCallTransformer.ts` - Handle OpaqueRef method calls

**Migration Strategy:**
1. Extract existing logic from monolithic `opaque-ref.ts`
2. Refactor into focused transformer classes
3. Maintain backward compatibility with existing tests
4. Add unit tests for individual transformers

#### Phase 2.2: Schema Transformation
**Deliverables:**
- `src/transformers/SchemaInjectionTransformer.ts` - Type argument to runtime schema conversion
- Integration with existing schema-generator package
- Proper handling of complex generic types

### Phase 3: Advanced Features (Week 3-4)

#### Phase 3.1: Scope-Aware Transformations
**Deliverables:**
- `src/transformers/ClosureTransformer.ts` - Handle reactive values in closures
- `src/transformers/DestructuringTransformer.ts` - Reactive destructuring patterns
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
    const reactiveDependencies = this.findCapturedReactiveDependencies(node, context);
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
  
  transform(node: ts.VariableDeclaration, context: TransformationContext): ts.Node[] {
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
1. **Performance Regression**: Comprehensive benchmarking and optimization phases
2. **Breaking Changes**: Extensive test coverage and gradual migration
3. **Complex AST Patterns**: Incremental implementation with thorough testing
4. **Type Analysis Complexity**: Fallback mechanisms and error handling

### Mitigation Strategies
1. **Feature Flags**: Enable/disable new transformers individually
2. **Rollback Plan**: Keep old implementation as fallback
3. **Monitoring**: Performance and error tracking in production
4. **Documentation**: Comprehensive migration guides and examples

## Success Metrics

### Quality Metrics
- **Test Coverage**: >95% line coverage for all new components
- **Bug Reduction**: 50% reduction in transformation-related issues
- **Maintainability**: Reduced complexity scores (< 10 per function)

### Performance Metrics
- **Transformation Speed**: No regression vs current implementation
- **Memory Usage**: < 20% increase in peak memory usage
- **Caching Efficiency**: > 80% cache hit rate for type analysis

### Extensibility Metrics
- **Plugin Development**: < 2 hours to implement basic transformer
- **Testing**: < 30 minutes to add comprehensive tests for new transformer
- **Documentation**: Complete API documentation and examples

## Timeline Summary

| Phase | Duration | Key Deliverables | Dependencies |
|-------|----------|------------------|--------------|
| Phase 1 | Week 1-2 | Core infrastructure, base classes | None |
| Phase 2 | Week 2-3 | Basic transformers, schema integration | Phase 1 |
| Phase 3 | Week 3-4 | Advanced features, scope analysis | Phase 2 |
| Phase 4 | Week 4-5 | Testing, performance optimization | Phase 3 |
| Phase 5 | Week 5-6 | Migration, documentation | Phase 4 |

**Total Duration**: 6 weeks
**Key Milestones**: 
- Week 2: Core architecture complete
- Week 3: Basic transformation parity achieved  
- Week 4: Advanced features implemented
- Week 5: Performance optimization complete
- Week 6: Full migration and documentation

This implementation plan provides a clear roadmap for transforming the monolithic transformer implementation into a modular, extensible, and maintainable architecture that supports advanced JavaScript patterns while maintaining backward compatibility and high performance.