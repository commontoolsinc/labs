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
- **Dependency analysis** – `opaque-ref/dependency.ts` walks expressions to
  collect reactive dependencies, handles most scope boundaries, and records
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
| runtime may read a `Cell` eagerly.                                      | Need dependency support for                              |       |
| `PropertyAccessChain` and a rewrite that preserves optional semantics.  |                                                          |       |
| **Closures**                                                            | Functions that capture reactive values (e.g.             |       |
| `() => count + 1`) aren’t rewritten, so callbacks read opaque values at |                                                          |       |
| runtime.                                                                | Requires capture analysis and a closure rewrite rule.    |       |
| **Destructuring / spread**                                              | Patterns like `const { name } = user` or                 |       |
| `{ ...config, count: count + 1 }` still operate on raw refs.            |                                                          |       |
| **Async/await & template literals**                                     | Reactive identifiers inside                              |       |
| `await` expressions or template strings aren’t wrapped automatically.   |                                                          |       |
| **Testing depth**                                                       | No unit or perf suites beyond fixtures; closure/optional |       |
| scenarios lack runtime integration coverage.                            |                                                          |       |

## Near-Term Roadmap

1. **Optional-chain predicate support**
   - Extend dependency normalisation to recognise optional property/element
     chains.
   - Update the unary rule to emit `derive(cellRef, ref => !(ref?.length))`.
   - Add fixtures and unit coverage.

2. **Closure capture rewriting**
   - Introduce a capture-aware dependency walk that builds a lightweight scope
     tree.
   - Add a closure rule that wraps captured reactive values in derives inside
     arrow functions/function expressions.
   - Cover map callbacks, inline handlers, and nested closures.

3. **Destructuring & spread support (scoped exploration)**
   - Evaluate the minimal rewrites needed for object/array destructuring and
     object spreads; prioritise the patterns used in recipes once closure work
     lands.

4. **Test enhancements**
   - Add focused unit tests for the new dependency helpers.
   - Expand fixtures with optional-chain, closure, and destructuring scenarios.
   - Wire a smoke runtime test that exercises the modular transformer end-to-end
     (likely in `js-runtime`).

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
