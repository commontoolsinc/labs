# Pattern Testing System Specification

**Status:** Implemented (Phase 1+2)
**Author:** Claude (with Gideon)
**Date:** 2026-01-07

## Executive Summary

This specification defines a **blessed path for writing unit and integration-style tests for CommonTools patterns**. The system enables pattern authors (human and LLM) to write regression-guarding tests during pattern development, complementing the existing CI integration tests.

The key insight: **Pattern logic (computeds, handlers, cell reactivity) can be tested without deploying a full charm** using the existing lightweight runtime with emulated storage.

## Goals

1. **Fast feedback loops** - Tests run in milliseconds, not seconds
2. **Isolation** - Test one pattern's logic without browser or network
3. **Granularity** - Unit test individual computeds/handlers, not just full charm flows
4. **Pattern author ownership** - Tests live alongside patterns, authored by pattern developers
5. **LLM-friendly** - Clear patterns that LLMs can follow to write good tests

## Non-Goals

- Replacing existing CI integration tests (those remain for browser/persistence testing)
- Testing cross-charm linking (requires full deployment)
- Testing UI rendering (requires browser)
- Full coverage of all patterns retroactively

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    ct dev --test                            │
│  (discovers and runs tests for a pattern)                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              @commontools/pattern-testing                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │ Runtime Factory │  │  Cell Helpers   │  │  Assertions │  │
│  │  (per-test)     │  │  (creation,     │  │  (cell,     │  │
│  │                 │  │   mutation)     │  │   handler)  │  │
│  └─────────────────┘  └─────────────────┘  └─────────────┘  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │ Handler Event   │  │   Scheduler     │  │  Pattern    │  │
│  │  Injection      │  │   Control       │  │  Loader     │  │
│  └─────────────────┘  └─────────────────┘  └─────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Runtime + StorageManager.emulate()             │
│  (In-memory, no I/O, ~10ms instantiation)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Test File Discovery

When running `ct dev pattern.tsx --test`, the CLI discovers test files using this precedence:

1. **Explicit path**: `ct dev pattern.tsx --test ./custom/path.test.ts`
2. **Sibling `__tests__` directory**: `pattern/__tests__/pattern.test.ts`
3. **Same directory**: `pattern.test.ts` next to `pattern.tsx`

For multi-file patterns:
```
packages/patterns/
├── counter.tsx
├── counter.test.ts              # Option 3: same directory
├── expense-tracker/
│   ├── main.tsx
│   ├── schemas.tsx
│   └── __tests__/               # Option 2: __tests__ directory
│       ├── main.test.ts
│       └── schemas.test.ts
```

---

## Test Levels

### Level 1: Pure Function Tests

Test helper functions extracted from patterns (no runtime needed):

```typescript
// counter-handlers.test.ts
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { nth, previous } from "./counter-handlers.ts";

describe("counter helpers", () => {
  it("nth formats ordinals correctly", () => {
    expect(nth(1)).toBe("1st");
    expect(nth(2)).toBe("2nd");
    expect(nth(3)).toBe("3rd");
    expect(nth(4)).toBe("4th");
    expect(nth(21)).toBe("21th"); // Current behavior
  });

  it("previous subtracts one", () => {
    expect(previous(5)).toBe(4);
    expect(previous(0)).toBe(-1);
  });
});
```

### Level 2: Computed Tests

Test computed derivations with the test harness:

```typescript
// expense-tracker.test.ts
import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createTestHarness, type TestHarness } from "@commontools/pattern-testing";

describe("expense tracker computeds", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("totalAmount sums expenses correctly", async () => {
    const { pattern, cells } = await harness.loadPattern(
      "./expense-tracker.tsx",
      {
        expenses: [
          { description: "Coffee", amount: 5, category: "food" },
          { description: "Gas", amount: 40, category: "transport" },
        ],
      }
    );

    await harness.idle(); // Wait for computeds to evaluate

    expect(pattern.result.totalAmount).toBe(45);
  });

  it("byCategory groups expenses", async () => {
    const { pattern } = await harness.loadPattern("./expense-tracker.tsx", {
      expenses: [
        { amount: 10, category: "food" },
        { amount: 20, category: "food" },
        { amount: 30, category: "transport" },
      ],
    });

    await harness.idle();

    expect(pattern.result.byCategory).toEqual({
      food: 30,
      transport: 30,
    });
  });

  it("handles empty expenses", async () => {
    const { pattern } = await harness.loadPattern("./expense-tracker.tsx", {
      expenses: [],
    });

    await harness.idle();

    expect(pattern.result.totalAmount).toBe(0);
    expect(pattern.result.byCategory).toEqual({});
  });
});
```

### Level 3: Handler Tests

Test mutations and side effects.

**Important:** Handlers must be **returned from the pattern body** to be testable. This is already the recommended pattern:

```typescript
// counter.tsx - handlers are exposed on the output
interface RecipeOutput {
  value: Default<number, 0>;
  increment: Stream<void>;  // ← Exposed for external triggering
  decrement: Stream<void>;  // ← Exposed for external triggering
}

export default pattern<RecipeState, RecipeOutput>((state) => {
  return {
    // ...
    increment: increment(state),  // ← Must be in return object!
    decrement: decrement(state),  // ← Must be in return object!
  };
});
```

**Triggering handlers:** Use `.send()` directly on the handler stream (this is the existing API, not something we invent):

```typescript
// counter.test.ts
import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createTestHarness, type TestHarness } from "@commontools/pattern-testing";

describe("counter handlers", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("increment increases value by 1", async () => {
    const { pattern, cells } = await harness.loadPattern("./counter.tsx", {
      value: 0,
    });

    // Trigger the handler using .send() - this is the native API
    pattern.result.increment.send({});
    await harness.idle();

    expect(cells.value.get()).toBe(1);
  });

  it("decrement decreases value by 1", async () => {
    const { pattern, cells } = await harness.loadPattern("./counter.tsx", {
      value: 10,
    });

    pattern.result.decrement.send({});
    await harness.idle();

    expect(cells.value.get()).toBe(9);
  });

  it("handles rapid increment/decrement", async () => {
    const { pattern, cells } = await harness.loadPattern("./counter.tsx", {
      value: 5,
    });

    pattern.result.increment.send({});
    pattern.result.increment.send({});
    pattern.result.decrement.send({});
    await harness.idle();

    expect(cells.value.get()).toBe(6);
  });
});
```

### Level 4: Reactivity Tests

Test that computed values update when inputs change:

```typescript
// todo-list.test.ts
import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createTestHarness, type TestHarness } from "@commontools/pattern-testing";

describe("todo list reactivity", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("activeItems updates when item marked done", async () => {
    const { pattern, cells } = await harness.loadPattern("./todo-list.tsx", {
      items: [
        { title: "Task 1", done: false },
        { title: "Task 2", done: false },
      ],
    });

    await harness.idle();
    expect(pattern.result.activeItems).toHaveLength(2);

    // Mutate an item
    cells.items.key(0).key("done").set(true);
    await harness.idle();

    expect(pattern.result.activeItems).toHaveLength(1);
    expect(pattern.result.activeItems[0].title).toBe("Task 2");
  });

  it("count updates reactively", async () => {
    const { pattern, cells } = await harness.loadPattern("./todo-list.tsx", {
      items: [],
    });

    const counts: number[] = [];
    harness.subscribe(pattern.result.count, (value) => counts.push(value));

    cells.items.push({ title: "First", done: false });
    await harness.idle();

    cells.items.push({ title: "Second", done: false });
    await harness.idle();

    expect(counts).toEqual([0, 1, 2]);
  });
});
```

### Level 5: Cell.equals() and Identity Tests

Test object identity handling.

**Note on testability:** To test handlers, they must be exposed in the pattern output with a signature that allows external triggering. For patterns like `test-cell-equals.tsx` where handlers are bound inline in JSX with runtime values (like `index`), you have two options:

1. **Expose a testable handler** that takes the index as event data (not bound state)
2. **Test at the cell level** - directly manipulate cells to verify the logic

Here's an example testing Cell.equals() behavior at the cell level:

```typescript
// test-cell-equals.test.ts
import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createTestHarness, type TestHarness } from "@commontools/pattern-testing";
import { Cell } from "commontools";

describe("Cell.equals() behavior", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("selection follows correct item after list mutation", async () => {
    const { pattern, cells } = await harness.loadPattern(
      "./gideon-tests/test-cell-equals.tsx",
      {
        items: [
          { title: "Item A", description: "First" },
          { title: "Item B", description: "Second" },
        ],
        selectedItem: null,
      }
    );

    // Select the second item by setting the cell directly
    const itemB = cells.items.get()[1];
    cells.selectedItem.set(itemB);
    await harness.idle();

    expect(cells.selectedItem.get()?.title).toBe("Item B");

    // Add item at start - selection should still point to "Item B"
    cells.items.set([
      { title: "Item 0", description: "Prepended" },
      ...cells.items.get(),
    ]);
    await harness.idle();

    // Selection should still reference Item B (Cell.equals tracks identity)
    expect(cells.selectedItem.get()?.title).toBe("Item B");
  });

  it("removes correct item using Cell.equals()", async () => {
    const { pattern, cells } = await harness.loadPattern(
      "./gideon-tests/test-cell-equals.tsx",
      {
        items: [
          { title: "Keep", description: "Keep this" },
          { title: "Remove", description: "Remove this" },
          { title: "Also Keep", description: "Keep this too" },
        ],
        selectedItem: null,
      }
    );

    // Select middle item
    const itemToRemove = cells.items.get()[1];
    cells.selectedItem.set(itemToRemove);
    await harness.idle();

    // Simulate the removeSelected handler logic manually
    const selected = cells.selectedItem.get();
    if (selected) {
      const current = cells.items.get();
      const index = current.findIndex((el) => Cell.equals(selected, el));
      if (index >= 0) {
        cells.items.set(current.toSpliced(index, 1));
        cells.selectedItem.set(null);
      }
    }
    await harness.idle();

    expect(cells.items.get()).toHaveLength(2);
    expect(cells.items.get().map((i) => i.title)).toEqual(["Keep", "Also Keep"]);
    expect(cells.selectedItem.get()).toBeNull();
  });
});
```

**For better testability**, patterns should expose handlers with event-based signatures:

```typescript
// More testable pattern design
interface RecipeOutput {
  items: Cell<Item[]>;
  selectedItem: Cell<Item | null>;
  // Handler that takes index as event data, not bound state
  selectByIndex: Stream<{ index: number }>;
  removeSelected: Stream<void>;
}

export default pattern<Input, Output>(({ items, selectedItem }) => {
  // Handler defined to receive index in event
  const selectByIndex = handler<{ index: number }, { items: Cell<Item[]>; selectedItem: Cell<Item | null> }>(
    ({ index }, { items, selectedItem }) => {
      const targetItem = items.get()[index];
      if (targetItem) selectedItem.set(targetItem);
    }
  );

  return {
    items,
    selectedItem,
    selectByIndex: selectByIndex({ items, selectedItem }),
    removeSelected: removeSelected({ items, selectedItem }),
  };
});
```

Then testing becomes straightforward:

```typescript
pattern.result.selectByIndex.send({ index: 1 });
await harness.idle();
expect(cells.selectedItem.get()?.title).toBe("Item B");
```

---

## Test Harness API

### `@commontools/pattern-testing`

```typescript
/**
 * A test cell that wraps a Cell and handles transaction management automatically.
 * In tests, you can call .set(value) without worrying about transactions.
 */
export interface TestCell<T> {
  /**
   * Set the cell value. Creates a transaction, sets the value, and commits.
   * @param value - The new value to set
   */
  set(value: T): Promise<void>;

  /**
   * Get the current cell value.
   */
  get(): T;

  /**
   * Access the underlying Cell for advanced use cases.
   */
  readonly cell: Cell<T>;
}

// Core harness
export interface TestHarness {
  // Load and instantiate a pattern with initial state
  loadPattern<Input, Output>(
    patternPath: string,
    initialState: Partial<Input>
  ): Promise<{
    pattern: { result: Output; cell: Cell<Output> };
    cells: { [K in keyof Input]: TestCell<Input[K]> };  // Note: TestCell, not Cell
  }>;

  // Wait for all pending scheduler actions
  // Call this after .send() or cell mutations to let reactivity settle
  idle(): Promise<void>;

  // Subscribe to cell changes (for reactivity tests)
  subscribe<T>(cell: Cell<T>, callback: (value: T) => void): () => void;

  // Clean up runtime resources
  dispose(): Promise<void>;

  // Access underlying runtime (escape hatch)
  runtime: Runtime;
  engine: Engine;
  identity: Identity;
  space: string;
}

// Note: To trigger handlers, use the native .send() API on handler streams:
//   pattern.result.increment.send({});
//   await harness.idle();
//
// Handlers must be returned from the pattern body to be accessible.

// Factory function
export function createTestHarness(options?: {
  identity?: Identity;
  validateSchemas?: boolean;  // Default: false (opt-in for performance)
}): Promise<TestHarness>;

// Assertion helpers (Phase 3 - not yet implemented)
export function expectCell<T>(cell: Cell<T>): {
  toBe(expected: T): void;
  toEqual(expected: T): void;
  toHaveLength(length: number): void;
};

export function expectHandler<E, T>(
  handler: HandlerFactory<T, E>
): {
  toMutate<K extends keyof T>(
    cell: K,
    from: T[K],
    to: T[K]
  ): Promise<void>;
};
```

### Important Usage Note: Async Cell Mutations

Because cells need transactions for mutations, `TestCell.set()` is async:

```typescript
// ✅ Correct - await the set call
await cells.firstName.set("Alice");
await harness.idle();

// ❌ Wrong - forgetting await will not properly commit the transaction
cells.firstName.set("Alice");  // Returns Promise, doesn't wait
await harness.idle();
```

### Implementation Sketch

```typescript
// packages/pattern-testing/src/harness.ts
import { Runtime, Engine } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-compiler";

export async function createTestHarness(options?: {
  identity?: Identity;
}): Promise<TestHarness> {
  const identity = options?.identity ?? await Identity.fromPassphrase("test");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const engine = new Engine(runtime);

  return {
    async loadPattern(patternPath, initialState) {
      const program = await engine.resolve(
        new FileSystemProgramResolver(patternPath)
      );
      const { main } = await engine.process(program, {
        noCheck: false,
        noRun: false,
      });

      const patternFactory = main?.default;
      if (!patternFactory) {
        throw new Error(`No default export in ${patternPath}`);
      }

      // Create cells for initial state
      const tx = runtime.edit();
      const cells: Record<string, Cell<unknown>> = {};
      for (const [key, value] of Object.entries(initialState)) {
        const cell = runtime.getCell(
          identity.did(),
          `test-${key}-${Date.now()}`,
          undefined,
          tx
        );
        cell.set(value);
        cells[key] = cell;
      }
      await tx.commit();

      // Instantiate pattern
      const result = patternFactory(cells);

      return {
        pattern: { result: result.getAsQueryResult() },
        cells: cells as any,
      };
    },

    async idle() {
      await runtime.idle();
    },

    async sendEvent(stream, event, boundState) {
      stream.send(event);
      await runtime.idle();
    },

    subscribe(cell, callback) {
      return cell.sink(callback);
    },

    async dispose() {
      await runtime.dispose();
      await storageManager.close();
    },

    runtime,
  };
}
```

---

## CLI Integration

### Command

```bash
ct dev pattern.tsx --test [test-path]
```

### Options

| Flag | Description |
|------|-------------|
| `--test` | Run tests for the pattern |
| `--test ./path.test.ts` | Run specific test file |
| `--watch` | Re-run tests on file changes (Phase 2) |
| `--filter <name>` | Run only tests matching name |

### Output

Uses standard Deno test output format:

```
$ ct dev counter.tsx --test

running 5 tests from ./counter.test.ts
counter helpers ...
  nth formats ordinals correctly ... ok (1ms)
  previous subtracts one ... ok (0ms)
counter handlers ...
  increment increases value by 1 ... ok (12ms)
  decrement decreases value by 1 ... ok (11ms)
  handles rapid increment/decrement ... ok (15ms)

ok | 5 passed | 0 failed (45ms)
```

---

## Implementation Phases

### Phase 1: Core Infrastructure (MVP) ✅ COMPLETED

**Deliverables:**
- [x] `@commontools/pattern-testing` package with `createTestHarness()`
- [x] `loadPattern()` - pattern compilation and instantiation
- [x] `idle()` - scheduler synchronization
- [x] `dispose()` - cleanup
- [x] `ct dev --test` command (basic discovery)
- [ ] Documentation with counter example

**Test coverage enabled:**
- Pure function tests (Level 1)
- Basic computed tests (Level 2)

**Estimated scope:** ~500 LOC

### Phase 2: Handler and Reactivity Testing ✅ COMPLETED

**Deliverables:**
- [x] Handler triggering via native `.send()` API on result streams
- [x] `subscribe()` - cell change observation
- [x] Cell mutation helpers via `TestCell` wrapper (`cells.foo.set()`)
- [x] Test file discovery (`__tests__/` subdirectory)

**Implementation Notes:**
- Cells are wrapped in `TestCell<T>` interface for automatic transaction management
- `TestCell.set(value)` is async and creates/commits transactions automatically
- Tests must `await` cell mutations: `await cells.foo.set(value)`

**Test coverage enabled:**
- Handler tests (Level 3)
- Reactivity tests (Level 4)
- Cell.equals() tests (Level 5)

**Estimated scope:** ~300 LOC additional

### Phase 3: Developer Experience

**Deliverables:**
- [ ] `--watch` mode for TDD
- [ ] Assertion helpers (`expectCell`, `expectHandler`)
- [ ] `--filter` for running specific tests
- [ ] Better error messages with pattern context
- [ ] Test result caching

**Estimated scope:** ~400 LOC additional

### Phase 4: LLM Authoring Support

**Deliverables:**
- [ ] Test scaffolding templates
- [ ] `ct dev --test --scaffold` to generate test skeleton
- [ ] Documentation for LLM pattern → test generation
- [ ] Example tests for each pattern complexity level

**Estimated scope:** ~200 LOC + documentation

---

## Migration Path

### Existing Tests

The existing integration tests (`packages/patterns/integration/`) remain unchanged. They test browser rendering, persistence, and full charm lifecycle.

### gideon-tests Patterns

The manual test patterns in `gideon-tests/` can be incrementally converted to automated tests:

1. Extract the "WHAT THIS TESTS" section as test descriptions
2. Convert "MANUAL VERIFICATION STEPS" to automated assertions
3. Keep the pattern itself as a visual debugging tool

Example conversion:
```typescript
// Before: test-cell-equals.tsx has manual verification comments
// After: test-cell-equals.test.ts has automated assertions

/*
 * MANUAL VERIFICATION STEPS (from pattern comments):
 * 1. Click "Add Item" several times
 * 2. Click on different items to select them
 * 3. Verify only one item is highlighted
 */

// Becomes:
it("only one item highlighted at a time", async () => {
  // ... automated test
});
```

---

## Design Decisions

### Schema validation testing
**Opt-in.** The harness will not automatically validate cell values against schemas by default. Pattern authors can opt-in via a harness option if needed:
```typescript
const harness = await createTestHarness({ validateSchemas: true });
```

### Snapshot testing
**Deferred.** Not included in MVP. Snapshot testing can create brittle tests and computed values are usually better tested with explicit assertions. Can be added in Phase 3+ based on user demand.

### Test isolation
**Fresh harness per `it()` block via `beforeEach`/`afterEach`.** Tests can share the harness *variable declaration* within a `describe()` block, but each test gets a fresh runtime:
```typescript
describe("counter", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness(); // Fresh per test
  });

  afterEach(async () => {
    await harness.dispose(); // Clean up
  });

  it("test 1", ...); // Gets fresh harness
  it("test 2", ...); // Gets fresh harness
});
```

### Handler testing
**Use native `.send()` API.** Handlers must be returned from the pattern body to be testable. See Level 3 examples for details.

### Multi-file patterns (schemas.tsx)
**The harness is for patterns, not utilities.** Files like `schemas.tsx` typically contain:

| Content | How to Test |
|---------|-------------|
| Type definitions (interfaces) | No tests needed - TypeScript validates |
| Utility functions | Standard unit tests (no harness) |
| Shared constants | Standard unit tests (no harness) |

Example for utility functions in schemas:
```typescript
// schemas.test.ts - no harness needed
import { formatCurrency, validateExpense } from "./schemas.tsx";

it("formatCurrency handles decimals", () => {
  expect(formatCurrency(10.5)).toBe("$10.50");
});
```

---

## Success Criteria

1. **A pattern author can write their first test in < 5 minutes** (with docs)
2. **Tests run in < 100ms** for typical patterns
3. **The gideon-tests patterns can be converted to automated tests**
4. **LLMs can generate reasonable tests from pattern code** (Phase 4)
5. **Test failures provide actionable error messages**

---

## Appendix: Reference Files

- Existing cell tests: `packages/runner/test/cell.test.ts`
- Integration test example: `packages/patterns/integration/counter.test.ts`
- CLI dev command: `packages/cli/commands/dev.ts`
- Runtime factory: `packages/cli/lib/dev.ts`
- Manual test patterns: `packages/patterns/gideon-tests/`
