action Builder - Known Limitations & Future Work

  1. Type System Cast

  Location: packages/runner/src/builder/opaque-ref.ts:89

  return opaqueRefWithCell<T>(undefined, schema, "stream") as unknown as Stream<T>;

  Issue: The stream() function uses as unknown as to bridge a type gap. The runtime creates a Stream cell, but opaqueRefWithCell is typed to return
  OpaqueRef<T>.

  Why it exists: The cell's getAsOpaqueRefProxy() method always returns OpaqueRef<T> regardless of cell kind. Fixing this properly would require deeper
  changes to how cells are typed throughout the system.

  Impact: Low - contained to one location, runtime behavior is correct.

  ---
  2. Arrow Functions Only

  Location: packages/ts-transformers/src/closures/strategies/action-strategy.ts

  Issue: Only arrow function callbacks are supported:
  - ✅ action(() => count.set(count.get() + 1))
  - ❌ action(function() { count.set(count.get() + 1) })

  Why it exists: Matches the existing HandlerStrategy behavior for JSX event handlers. The RecipeBuilder.buildHandlerCallback is typed for ArrowFunction
   only.

  To fix (documented in action-strategy.ts):
  1. Update RecipeBuilder.buildHandlerCallback to accept FunctionExpression
  2. Update strategy to use isFunctionLikeExpression instead of unwrapArrowFunction
  3. Update HandlerStrategy for consistency
  4. Add test cases for function expression callbacks

  ---
  3. Event Parameter Type Inference

  Issue: When using action with an event parameter but no type annotation, the event type may not be correctly inferred.

  - ✅ action((e: MyEvent) => doSomething(e)) - explicit type works
  - ⚠️ action((e) => doSomething(e)) - inference untested

  Impact: Medium - users should add type annotations for event parameters.

  To verify: Add test fixtures for untyped event parameters.

  ---
  4. Untested Edge Cases

  The following scenarios have no dedicated test coverage:

  | Scenario                          | Risk   | Notes                                      |
  |-----------------------------------|--------|--------------------------------------------|
  | Action with no captures           | Low    | Should work, generates empty params object |
  | Nested actions                    | Medium | Action inside action callback              |
  | Action in conditionals            | Medium | condition ? action(...) : action(...)      |
  | Action with complex capture trees | Low    | Deeply nested object captures              |
  | Action in loops                   | Medium | items.map(() => action(...))               |

  ---
  5. No Integration Testing

  Issue: The action primitive is not yet used in any real patterns in packages/patterns/.

  Recommendation: Before wider rollout, add a simple pattern that uses action to validate the full end-to-end experience (compile → deploy → runtime
  execution).

  ---
  6. Documentation

  Issue: No user-facing documentation exists for the action primitive.

  Needed:
  - Add to docs/common/PATTERNS.md with examples
  - Add to pattern cookbook/examples
  - Document relationship to handler (action is to handler as computed is to lift)

  ---
  Summary

  | Issue                  | Severity | Effort to Fix        |
  |------------------------|----------|----------------------|
  | Type cast in stream()  | Low      | High (architectural) |
  | Arrow functions only   | Low      | Medium               |
  | Event type inference   | Medium   | Low (add tests)      |
  | Untested edge cases    | Medium   | Low (add fixtures)   |
  | No integration testing | Medium   | Low                  |
  | Documentation          | Medium   | Low                  |