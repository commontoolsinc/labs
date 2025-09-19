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
- **Data flow analysis** – `opaque-ref/dependency.ts` walks expressions to
  collect reactive data flows, handles most scope boundaries, and records
  provenance so map callbacks typed as `any` can still be derived.
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
| runtime may read a `Cell` eagerly.                                      | Need data flow support for                              |       |
| `PropertyAccessChain` and a rewrite that preserves optional semantics.  |                                                          |       |
| **Closures**                                                            | Functions that capture reactive values (e.g.             |       |
| `() => count + 1`) aren’t rewritten, so callbacks read opaque values at |                                                          |       |
| runtime.                                                                | Requires capture analysis and a closure rewrite rule.    |       |
| **Destructuring / spread**                                              | Patterns like `const { name } = user` or                 |       |
| `{ ...config, count: count + 1 }` still operate on raw refs.            | Object spread not yet supported.                         |       |
| **Async/await & template literals**                                     | Reactive identifiers inside                              |       |
| `await` expressions or template strings aren't wrapped automatically.   |                                                          |       |
| **Function body analysis**                                              | Only `return` statements analyzed in functions.          |       |
| Side effects and assignments are missed.                                | Causes reactive data flows to be overlooked.           |       |
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

3. **Fix normalization semantics**
   - Stop aggressive property stripping
   - Preserve semantic differences (e.g., `a` vs `a.length`)
   - Clarify parent suppression logic

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

## References

- `packages/ts-transformers/src/opaque-ref/transformer.ts`
- `packages/ts-transformers/src/opaque-ref/dependency.ts`
- `packages/ts-transformers/src/opaque-ref/rewrite/**`
- `packages/ts-transformers/test/fixtures`
- `packages/schema-generator/docs/refactor_plan.md` (historical context; see
  Linear tickets for remaining work)
