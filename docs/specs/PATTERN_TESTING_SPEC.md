# Pattern Testing System Specification

**Status:** Implemented (v2 - Patterns as Tests)
**Author:** Claude (with Gideon, Jordan, Berni)
**Date:** 2026-01-07

## Executive Summary

This specification defines a **pattern-native testing system** where tests are themselves patterns. Test patterns (`.test.tsx` files) import and instantiate the patterns they test, export test cases as Streams and assertions as `Cell<boolean>`, and are run via `ct test`.

**Key insight:** Tests should be patterns too. This dogfoods the pattern system, keeps testing infrastructure in userland, and allows test patterns to be deployed as charms for debugging.

## Goals

1. **Patterns all the way down** - Tests are patterns, proving the system works
2. **Fast feedback loops** - Tests run with emulated storage (~10ms setup)
3. **Debuggability** - Deploy test patterns as charms to inspect failures
4. **Minimal infrastructure** - Reuse existing `charm step` machinery
5. **Self-contained tests** - Test logic lives inside handlers, not external scripts

## Non-Goals

- Replacing existing CI integration tests
- Testing cross-charm linking (requires deployment)
- Testing UI rendering (requires browser)
- External test runners (Jest, Vitest, etc.)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     ct test <pattern.test.tsx>              │
│  (compiles, runs, and validates test pattern results)       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Test Pattern (.test.tsx)                 │
│  ┌─────────────────┐  ┌─────────────────┐                   │
│  │ Pattern Under   │  │  Test Actions   │                   │
│  │ Test (imported) │  │  (Stream<void>) │                   │
│  └────────┬────────┘  └────────┬────────┘                   │
│           │                    │                            │
│           ▼                    ▼                            │
│  ┌─────────────────────────────────────────┐                │
│  │      Assertions (Cell<boolean>)         │                │
│  │  (computed from pattern state)          │                │
│  └─────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Runtime + StorageManager.emulate()             │
│  (In-memory, no I/O, ~10ms instantiation)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Test Pattern Structure

A test pattern is a regular pattern file with `.test.tsx` extension that:

1. **Imports the pattern under test**
2. **Instantiates it with test data**
3. **Defines test actions as handlers** (with hardcoded test data inside)
4. **Defines assertions as `Cell<boolean>`** computed from pattern state
5. **Returns a `tests` array** containing actions and assertions in order

### Example Test Pattern

```tsx
/// <cts-enable />
import { Cell, computed, handler, pattern } from "commontools";
import ExpenseTracker from "./expense-tracker.tsx";

// Test pattern for expense tracker
export default pattern<{}, {}>(() => {
  // 1. Instantiate the pattern under test with initial state
  const subject = ExpenseTracker({
    expenses: Cell.of([]),
  });

  // 2. Define test actions (handlers with void event, hardcoded test data)
  const action_add_expense = handler<void, { expenses: Cell<Expense[]> }>(
    (_event, { expenses }) => {
      expenses.push({ description: "Coffee", amount: 5, category: "food" });
    }
  )({ expenses: subject.expenses });

  const action_add_another = handler<void, { expenses: Cell<Expense[]> }>(
    (_event, { expenses }) => {
      expenses.push({ description: "Gas", amount: 40, category: "transport" });
    }
  )({ expenses: subject.expenses });

  // 3. Define assertions as Cell<boolean>
  const assert_has_one_expense = computed(() => {
    return subject.expenses.get().length === 1;
  });

  const assert_total_is_45 = computed(() => {
    return subject.result.totalAmount === 45;
  });

  const assert_categories_correct = computed(() => {
    const byCategory = subject.result.byCategory;
    return byCategory.food === 5 && byCategory.transport === 40;
  });

  // 4. Return tests array - processed in order
  // Actions (.send() called), Assertions (boolean checked)
  return {
    tests: [
      action_add_expense,       // Stream - runner calls .send()
      assert_has_one_expense,   // Cell<boolean> - runner checks === true
      action_add_another,       // Stream - runner calls .send()
      assert_total_is_45,       // Cell<boolean> - runner checks === true
      assert_categories_correct, // Cell<boolean> - runner checks === true
    ],
    // Expose subject for debugging (optional)
    subject,
  };
});
```

### Test Execution Flow

The `ct test` runner processes the `tests` array **in order**:

1. For each item in `tests`:
   - If it's a **Stream**: call `.send(undefined)`, then `await runtime.idle()`
   - If it's a **Cell<boolean>**: read `.get()`, assert it equals `true`
2. Report pass/fail for each assertion
3. Handle timeouts (5s default) for stuck tests

```
┌──────────────────────────────────────────────────────────────┐
│  tests: [action1, assert1, action2, assert2, assert3]        │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  1. action1.send(undefined)                                  │
│  2. await runtime.idle()                                     │
│  3. assert1.get() === true ?  ✓ PASS / ✗ FAIL               │
│  4. action2.send(undefined)                                  │
│  5. await runtime.idle()                                     │
│  6. assert2.get() === true ?  ✓ PASS / ✗ FAIL               │
│  7. assert3.get() === true ?  ✓ PASS / ✗ FAIL               │
└──────────────────────────────────────────────────────────────┘
```

---

## Test Isolation

**Each test group gets a fresh pattern instance.** For now, a test pattern = one test group. Each run of `ct test` creates:

1. Fresh `StorageManager.emulate()`
2. Fresh `Runtime`
3. Fresh pattern instantiation

This ensures tests don't have interdependencies.

---

## CLI Command

### Usage

```bash
# Run a specific test pattern
ct test ./expense-tracker.test.tsx

# Run all test patterns in a directory
ct test ./patterns/

# Run with timeout override
ct test ./slow-test.test.tsx --timeout 10000
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--timeout <ms>` | Timeout per test in milliseconds | 5000 |
| `--verbose` | Show detailed execution logs | false |

### Output

```
$ ct test ./expense-tracker.test.tsx

expense-tracker.test.tsx
  ✓ assert_has_one_expense (after action_add_expense)
  ✓ assert_total_is_45 (after action_add_another)
  ✓ assert_categories_correct

3 passed, 0 failed (47ms)
```

---

## Runner Implementation

### Algorithm

```typescript
async function runTestPattern(testPath: string, options: TestOptions): Promise<TestResults> {
  const TIMEOUT = options.timeout ?? 5000;

  // 1. Create emulated runtime (same as charm step)
  const identity = await Identity.fromPassphrase("test-runner");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url)
  });
  const engine = new Engine(runtime);

  // 2. Compile and run the test pattern
  const program = await engine.resolve(
    new FileSystemProgramResolver(testPath)
  );
  const testPatternFactory = await engine.run(program);

  // 3. Instantiate the test pattern (commits initial transaction)
  const tx = runtime.edit();
  const testInstance = testPatternFactory({});
  await tx.commit();
  await runtime.idle();

  // 4. Get the tests array from pattern output
  const tests = testInstance.result?.tests;
  if (!Array.isArray(tests)) {
    throw new Error("Test pattern must return { tests: [...] }");
  }

  // 5. Process tests in order
  const results: TestResult[] = [];
  let lastActionName: string | null = null;

  for (let i = 0; i < tests.length; i++) {
    const testItem = tests[i];
    const itemName = `test_${i}`;  // TODO: extract name from handler/cell

    if (isStream(testItem)) {
      // It's an action - invoke it
      lastActionName = itemName;
      testItem.send(undefined);

      // Wait for idle with timeout
      await Promise.race([
        runtime.idle(),
        timeout(TIMEOUT, `Action ${itemName} timed out after ${TIMEOUT}ms`)
      ]);

    } else if (isCell(testItem)) {
      // It's an assertion - check the boolean value
      const passed = testItem.get() === true;
      results.push({
        name: itemName,
        passed,
        afterAction: lastActionName,
        error: passed ? undefined : `Expected true, got ${testItem.get()}`,
      });
    }
  }

  // 6. Cleanup
  engine.dispose();
  await storageManager.close();

  return { results, path: testPath };
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}
```

### Type Detection

```typescript
import { isStream, isCell } from "@commontools/runner";

// isStream(value) - returns true if value is a Stream
// isCell(value) - returns true if value is a Cell (need to add this helper)
```

---

## Test Pattern Guidelines

### Do: Self-Contained Test Actions

Test handlers should contain all test data inside them:

```tsx
// ✅ Good - hardcoded test data inside handler
const action_add_expense = handler<void, { expenses: Cell<Expense[]> }>(
  (_event, { expenses }) => {
    expenses.push({ description: "Coffee", amount: 5, category: "food" });
  }
)({ expenses: subject.expenses });
```

### Don't: Parameterized Test Actions

Test handlers take `void` events - don't try to pass data:

```tsx
// ❌ Bad - don't try to parameterize test handlers
const action_add_expense = handler<{ amount: number }, State>(
  ({ amount }, { expenses }) => {
    expenses.push({ description: "Test", amount, category: "food" });
  }
);
// The runner won't know what amount to pass!
```

### Do: Meaningful Assertion Names

Use descriptive computed cell names:

```tsx
// ✅ Good - name describes what's being tested
const assert_total_equals_45 = computed(() => subject.result.total === 45);
const assert_items_sorted_by_date = computed(() => isSorted(subject.items.get()));

// ❌ Bad - generic names
const test1 = computed(() => subject.result.total === 45);
```

### Do: Order Tests Logically

Put actions before the assertions that depend on them:

```tsx
return {
  tests: [
    action_add_item,        // First, add an item
    assert_has_one_item,    // Then, verify it was added
    action_remove_item,     // Then, remove it
    assert_empty,           // Then, verify it's empty
  ],
};
```

---

## Implementation Phases

### Phase 1: Core Runner (MVP) ✅ COMPLETE

**Deliverables:**
- [x] `ct test` command in CLI
- [x] Test pattern compilation and execution
- [x] Stream/Cell detection and processing
- [x] Basic pass/fail reporting
- [x] Timeout handling
- [x] Example test pattern

**Files created:**
- `packages/cli/commands/test.ts`
- `packages/cli/lib/test-runner.ts`
- `packages/patterns/gideon-tests/test-reactivity-computed-derive-same/index.test.tsx`

### Phase 2: Developer Experience

**Deliverables:**
- [ ] Better assertion error messages (show expected vs actual)
- [ ] Test name extraction from cell/handler definitions
- [ ] `--verbose` mode with execution trace
- [ ] Directory scanning for `*.test.tsx` files
- [ ] Exit codes for CI integration

### Phase 3: Advanced Features

**Deliverables:**
- [ ] `--watch` mode for TDD
- [ ] Test pattern scaffolding (`ct test --scaffold pattern.tsx`)
- [ ] Parallel test execution
- [ ] Test coverage reporting (which pattern paths were exercised)

---

## Migration from v1

The v1 approach (external test harness with `@commontools/pattern-testing` package) has been deprecated and removed. The pattern-native approach provides:

- **Better debugging** - Deploy test pattern as charm
- **Consistency** - Tests use the same patterns as production
- **Simplicity** - No separate test harness to maintain

The `@commontools/pattern-testing` package has been removed from the codebase.

---

## Design Decisions

### Why patterns as tests?

1. **Dogfooding** - If patterns can't test themselves, something is wrong
2. **Debuggability** - Deploy a test pattern to inspect why it fails
3. **Minimal infrastructure** - Reuse `charm step` machinery
4. **Composability** - Test patterns can link to other patterns

### Why sequential array instead of parallel?

1. **Simpler mental model** - Order matters, easy to reason about
2. **Explicit dependencies** - Actions before assertions is clear
3. **Deterministic** - Same order every time

### Why void handlers instead of parameterized?

1. **Self-contained** - Tests don't need external test data
2. **Simpler runner** - Just call `.send(undefined)`
3. **Readable** - Test data is visible in the handler body

### Why Cell<boolean> instead of assertions?

1. **Reactive** - Assertions are computed from live pattern state
2. **Pattern-native** - Uses the same Cell system as patterns
3. **Debuggable** - Can inspect assertion cell values in deployed charm

---

## Success Criteria

1. **Test patterns run in < 100ms** for typical patterns
2. **Test patterns can be deployed as charms** for debugging
3. **The runner correctly detects Stream vs Cell<boolean>**
4. **Timeouts prevent infinite loops from hanging CI**
5. **Error messages identify which assertion failed and why**

---

## Appendix: Type Detection Helpers

The runner needs to distinguish Streams from Cells:

```typescript
// From packages/runner/src/cell.ts
export function isStream<T = any>(value: any): value is Stream<T> {
  return (value instanceof CellImpl && (value as any).isStream?.());
}

// Need to add (or may already exist):
export function isCell<T = any>(value: any): value is Cell<T> {
  return value instanceof CellImpl;
}
```

---

## Appendix: Full Example

### Pattern Under Test

```tsx
// counter.tsx
/// <cts-enable />
import { Cell, Default, handler, NAME, pattern, UI } from "commontools";

const increment = handler<void, { value: Cell<number> }>(
  (_, { value }) => value.set(value.get() + 1)
);

const decrement = handler<void, { value: Cell<number> }>(
  (_, { value }) => value.set(value.get() - 1)
);

interface Input { value: Default<number, 0>; }
interface Output { value: number; increment: Stream<void>; decrement: Stream<void>; }

export default pattern<Input, Output>(({ value }) => ({
  [NAME]: "Counter",
  [UI]: <div>{value}</div>,
  value,
  increment: increment({ value }),
  decrement: decrement({ value }),
}));
```

### Test Pattern

```tsx
// counter.test.tsx
/// <cts-enable />
import { Cell, computed, handler, pattern } from "commontools";
import Counter from "./counter.tsx";

export default pattern<{}, {}>(() => {
  // Instantiate counter with initial value
  const counter = Counter({ value: Cell.of(0) });

  // Test actions
  const action_increment = handler<void, {}>(() => {
    counter.increment.send(undefined);
  })({});

  const action_increment_twice = handler<void, {}>(() => {
    counter.increment.send(undefined);
    counter.increment.send(undefined);
  })({});

  const action_decrement = handler<void, {}>(() => {
    counter.decrement.send(undefined);
  })({});

  // Assertions
  const assert_starts_at_zero = computed(() => counter.value.get() === 0);
  const assert_is_one = computed(() => counter.value.get() === 1);
  const assert_is_three = computed(() => counter.value.get() === 3);
  const assert_is_two = computed(() => counter.value.get() === 2);

  return {
    tests: [
      assert_starts_at_zero,    // Initial state check
      action_increment,
      assert_is_one,            // After 1 increment
      action_increment_twice,
      assert_is_three,          // After 2 more increments
      action_decrement,
      assert_is_two,            // After 1 decrement
    ],
  };
});
```

### Running the Test

```bash
$ ct test ./counter.test.tsx

counter.test.tsx
  ✓ assert_starts_at_zero
  ✓ assert_is_one (after action_increment)
  ✓ assert_is_three (after action_increment_twice)
  ✓ assert_is_two (after action_decrement)

4 passed, 0 failed (32ms)
```
