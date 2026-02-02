# Pattern Testing System Specification

**Status:** Implemented (v2.1 - Discriminated Union Format)
**Author:** Claude (with Gideon, Jordan, Berni)
**Date:** 2026-01-13

## Executive Summary

This specification defines a **pattern-native testing system** where tests are themselves patterns. Test patterns (`.test.tsx` files) import and instantiate the patterns they test, define test steps using a **discriminated union format** (`{ action: ... }` or `{ assertion: ... }`), and are run via `ct test`.

**Key insight:** Tests should be patterns too. This dogfoods the pattern system, keeps testing infrastructure in userland, and allows test patterns to be inspected via CLI for debugging.

## Goals

1. **Patterns all the way down** - Tests are patterns, proving the system works
2. **Fast feedback loops** - Tests run with emulated storage (~10ms setup)
3. **Debuggability** - Inspect test patterns via CLI (`ct piece inspect`, `ct piece get`)
4. **Minimal infrastructure** - Reuse existing `piece step` machinery
5. **Self-contained tests** - Test logic lives inside actions, not external scripts

## Non-Goals

- Replacing existing CI integration tests
- Testing cross-piece linking (requires deployment)
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
3. **Defines test actions using `action()`** (for triggering events on the pattern)
4. **Defines assertions as `computed(() => boolean)`** computed from pattern state
5. **Returns a `tests` array** of discriminated union objects: `{ action: ... }` or `{ assertion: ... }`

### Test Step Format (Discriminated Union)

The `tests` array uses a discriminated union to avoid TypeScript declaration emit issues:

```typescript
type TestStep =
  | { assertion: OpaqueRef<boolean> }  // from computed(() => condition)
  | { action: Stream<void> };          // from action(() => handler.send())
```

This format keeps `action()` streams and `computed()` cells separate in the type system.

### Example Test Pattern

```tsx
/// <cts-enable />
import { action, computed, pattern, Writable } from "commontools";
import ExpenseTracker from "./expense-tracker.tsx";

// Test pattern for expense tracker
export default pattern(() => {
  // 1. Instantiate the pattern under test with initial state
  const subject = ExpenseTracker({
    expenses: Writable.of([]),
  });

  // 2. Define test actions using action() - triggers events on the pattern
  const action_add_expense = action(() => {
    subject.addExpense.send({ description: "Coffee", amount: 5, category: "food" });
  });

  const action_add_another = action(() => {
    subject.addExpense.send({ description: "Gas", amount: 40, category: "transport" });
  });

  // 3. Define assertions as computed(() => boolean)
  const assert_has_one_expense = computed(() => {
    return subject.expenses.length === 1;
  });

  const assert_total_is_45 = computed(() => {
    return subject.result.totalAmount === 45;
  });

  const assert_categories_correct = computed(() => {
    const byCategory = subject.result.byCategory;
    return byCategory.food === 5 && byCategory.transport === 40;
  });

  // 4. Return tests array using discriminated union format
  return {
    tests: [
      { action: action_add_expense },       // Runner calls .send()
      { assertion: assert_has_one_expense }, // Runner checks === true
      { action: action_add_another },
      { assertion: assert_total_is_45 },
      { assertion: assert_categories_correct },
    ],
    // Expose subject for debugging (optional)
    subject,
  };
});
```

### Test Execution Flow

The `ct test` runner processes the `tests` array **in order**:

1. For each item in `tests`:
   - If it has `action` key: call `.send()`, then `await runtime.idle()`
   - If it has `assertion` key: read `.get()`, assert it equals `true`
2. Report pass/fail for each assertion
3. Handle timeouts (5s default) for stuck tests

```
┌──────────────────────────────────────────────────────────────┐
│  tests: [                                                     │
│    { action: action1 },                                       │
│    { assertion: assert1 },                                    │
│    { action: action2 },                                       │
│    { assertion: assert2 },                                    │
│  ]                                                            │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  1. "action" in step? → step.action.send()                   │
│  2. await runtime.idle()                                     │
│  3. "assertion" in step? → step.assertion.get() === true?    │
│     ✓ PASS / ✗ FAIL                                          │
│  ... repeat for each step                                    │
└──────────────────────────────────────────────────────────────┘
```

**Note:** For `Stream<void>`, `.send()` can be called with no arguments. The event parameter is optional when `T` is `void`.

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

  // 1. Create emulated runtime (same as piece step)
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
  const { main } = await engine.process(program, { noCheck: false, noRun: false });
  const testPatternFactory = main.default as Recipe;

  // 3. Instantiate the test pattern with proper space context
  const tx = runtime.edit();
  const resultCell = runtime.getCell(space, `test-pattern-result-${Date.now()}`, undefined, tx);
  const patternResult = runtime.run(tx, testPatternFactory, {}, resultCell);
  await tx.commit();
  await runtime.idle();

  // Keep pattern reactive
  const sinkCancel = patternResult.sink(() => {});

  // 4. Get the tests array from pattern output
  const testsCell = patternResult.key("tests") as Cell<unknown>;
  const testsValue = testsCell.get();
  if (!Array.isArray(testsValue)) {
    throw new Error("Test pattern must return { tests: TestStep[] }");
  }

  // 5. Process tests in order using discriminated union format
  const results: TestResult[] = [];
  let lastActionIndex: number | null = null;
  let assertionCount = 0;
  let actionCount = 0;

  for (let i = 0; i < testsValue.length; i++) {
    const stepValue = testsValue[i] as { action?: unknown; assertion?: unknown };

    // Check discriminated union keys
    const isAction = "action" in stepValue;
    const isAssertion = "assertion" in stepValue;

    if (!isAction && !isAssertion) {
      throw new Error(`Test step at index ${i} must have 'action' or 'assertion' key`);
    }

    if (isAction) {
      // It's an action - invoke it via .key() access
      actionCount++;
      lastActionIndex = i;
      const actionStream = testsCell.key(i).key("action") as Stream<unknown>;
      actionStream.send();  // No argument needed for void streams

      await Promise.race([
        runtime.idle(),
        timeout(TIMEOUT, `Action at index ${i} timed out after ${TIMEOUT}ms`)
      ]);

    } else {
      // It's an assertion - check the boolean value via .key() access
      assertionCount++;
      const assertCell = testsCell.key(i).key("assertion") as Cell<unknown>;
      const value = assertCell.get();
      const passed = value === true;

      results.push({
        name: `assertion_${assertionCount}`,
        passed,
        afterAction: lastActionIndex !== null ? `action_${actionCount}` : null,
        error: passed ? undefined : `Expected true, got ${JSON.stringify(value)}`,
      });
    }
  }

  // 6. Cleanup
  sinkCancel();
  engine.dispose();
  await storageManager.close();

  return { results, path: testPath };
}
```

### Key Implementation Details

- **Discriminated union detection:** Check `"action" in step` vs `"assertion" in step`
- **Cell access via `.key()`:** Access test steps through reactive cell interface
- **Void stream `.send()`:** No argument required for `Stream<void>`

---

## Test Pattern Guidelines

### Do: Use `action()` for Test Actions

Use the `action()` helper to create void streams that trigger events on the pattern:

```tsx
// ✅ Good - use action() to trigger pattern handlers
const action_add_expense = action(() => {
  subject.addExpense.send({ description: "Coffee", amount: 5, category: "food" });
});
```

### Do: Self-Contained Test Data

Test actions should contain all test data inside them:

```tsx
// ✅ Good - hardcoded test data inside action
const action_add_expense = action(() => {
  subject.addExpense.send({ description: "Coffee", amount: 5, category: "food" });
});

// ❌ Bad - test data defined elsewhere
const testData = { description: "Coffee", amount: 5, category: "food" };
const action_add_expense = action(() => {
  subject.addExpense.send(testData);
});
```

### Do: Meaningful Assertion Names

Use descriptive computed cell names:

```tsx
// ✅ Good - name describes what's being tested
const assert_total_equals_45 = computed(() => subject.result.total === 45);
const assert_items_sorted_by_date = computed(() => isSorted(subject.items));

// ❌ Bad - generic names
const test1 = computed(() => subject.result.total === 45);
```

### Do: Use Discriminated Union Format

Wrap actions and assertions in their respective object format:

```tsx
// ✅ Good - discriminated union format
return {
  tests: [
    { action: action_add_item },
    { assertion: assert_has_one_item },
    { action: action_remove_item },
    { assertion: assert_empty },
  ],
};

// ❌ Bad - flat array (causes TypeScript declaration emit issues)
return {
  tests: [action_add_item, assert_has_one_item, action_remove_item, assert_empty],
};
```

### Do: Order Tests Logically

Put actions before the assertions that depend on them:

```tsx
return {
  tests: [
    { action: action_add_item },     // First, add an item
    { assertion: assert_has_one_item }, // Then, verify it was added
    { action: action_remove_item },  // Then, remove it
    { assertion: assert_empty },     // Then, verify it's empty
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

- **Better debugging** - Deploy test pattern as piece
- **Consistency** - Tests use the same patterns as production
- **Simplicity** - No separate test harness to maintain

The `@commontools/pattern-testing` package has been removed from the codebase.

---

## Design Decisions

### Why patterns as tests?

1. **Dogfooding** - If patterns can't test themselves, something is wrong
2. **Debuggability** - Inspect test pattern state via CLI commands
3. **Minimal infrastructure** - Reuse `piece step` machinery
4. **Composability** - Test patterns can link to other patterns

### Why discriminated union format?

1. **Type safety** - Avoids TypeScript declaration emit errors with mixed arrays
2. **Explicit intent** - Clear whether a step is an action or assertion
3. **Extensible** - Can add more step types in the future (e.g., `{ wait: ms }`)

### Why sequential array instead of parallel?

1. **Simpler mental model** - Order matters, easy to reason about
2. **Explicit dependencies** - Actions before assertions is clear
3. **Deterministic** - Same order every time

### Why `action()` for test actions?

1. **Self-contained** - Tests don't need external test data
2. **Simpler runner** - Just call `.send()` (no arguments for void)
3. **Readable** - Test data is visible in the action body

### Why `computed(() => boolean)` for assertions?

1. **Reactive** - Assertions are computed from live pattern state
2. **Pattern-native** - Uses the same Cell system as patterns
3. **Debuggable** - Can inspect assertion cell values via CLI

---

## Success Criteria

1. **Test patterns run in < 100ms** for typical patterns
2. **Test patterns can be deployed as pieces** for debugging
3. **The runner correctly detects Stream vs Cell<boolean>**
4. **Timeouts prevent infinite loops from hanging CI**
5. **Error messages identify which assertion failed and why**

---

## Appendix: Full Example

### Pattern Under Test

```tsx
// counter.tsx
/// <cts-enable />
import { Cell, Default, handler, NAME, pattern, UI, type Stream } from "commontools";

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
import { Writable, action, computed, pattern } from "commontools";
import Counter from "./counter.tsx";

export default pattern(() => {
  // Instantiate counter with initial value
  const counter = Counter({ value: Writable.of(0) });

  // Test actions - use action() to create void streams
  const action_increment = action(() => {
    counter.increment.send();  // No argument needed for void streams
  });

  const action_increment_twice = action(() => {
    counter.increment.send();
    counter.increment.send();
  });

  const action_decrement = action(() => {
    counter.decrement.send();
  });

  // Assertions - computed(() => boolean)
  const assert_starts_at_zero = computed(() => counter.value === 0);
  const assert_is_one = computed(() => counter.value === 1);
  const assert_is_three = computed(() => counter.value === 3);
  const assert_is_two = computed(() => counter.value === 2);

  return {
    tests: [
      { assertion: assert_starts_at_zero },  // Initial state check
      { action: action_increment },
      { assertion: assert_is_one },          // After 1 increment
      { action: action_increment_twice },
      { assertion: assert_is_three },        // After 2 more increments
      { action: action_decrement },
      { assertion: assert_is_two },          // After 1 decrement
    ],
  };
});
```

### Running the Test

```bash
$ deno task ct test ./counter.test.tsx

counter.test.tsx
  ✓ assertion_1
  ✓ assertion_2 (after action_1)
  ✓ assertion_3 (after action_2)
  ✓ assertion_4 (after action_3)

4 passed, 0 failed (32ms)
```
