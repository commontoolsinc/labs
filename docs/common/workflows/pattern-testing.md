# Pattern Testing

Write automated tests for patterns using the same reactive system.

## Prerequisites

Before writing tests, ensure your pattern:

1. **Uses `pattern<Input, Output>()`** - Single-type patterns can't be properly tested
2. **Exports actions as `Stream<T>`** - Required for `instance.action.send()` to work

```typescript
// Shown at module scope.
// Pattern must have explicit Output type with Stream<T> for testable actions
interface MyOutput {
  count: number;
  increment: Stream<void>;  // ← Enables testing via .send()
}

export default pattern<MyInput, MyOutput>(({ count }) => {
  const increment = incrementHandler({ count });
  return { count, increment };  // ← Must return bound handler
});
```

If your pattern uses `pattern<State>()`, fix the pattern first. See [Pattern Types](../concepts/pattern.md#always-use-dual-type-parameters). A pattern that doesn't export its actions can still be driven through its UI — see [Firing a handler the pattern does not export](#firing-a-handler-the-pattern-does-not-export).

## Overview

Test patterns are patterns that test other patterns. They:
- Import and instantiate the pattern under test
- Define test actions using `action()`
- Define assertions using `assert(() => boolean)`
- Return a `tests` array that the runner executes sequentially

Test files end in `.test.tsx` and are run with `deno task cf test`.

## Quick Example

```tsx
// Shown at module scope.
import { action, assert, pattern } from "commonfabric";
import Counter from "./counter.tsx";

export default pattern(() => {
  // 1. Instantiate pattern under test with plain values
  const counter = Counter({ value: 0 });

  // 2. Define actions (trigger events on the pattern)
  const action_increment = action(() => {
    counter.increment.send();
  });

  // 3. Define assertions (reactive booleans that report their operands)
  const assert_is_zero = assert(() => counter.value === 0);
  const assert_is_one = assert(() => counter.value === 1);

  // 4. Return tests array
  return {
    tests: [
      { assertion: assert_is_zero },
      { action: action_increment },
      { assertion: assert_is_one },
    ],
  };
});
```

**Note:** Pass plain values when instantiating patterns in tests. The runtime creates independent writable cells automatically. Use `new Writable()` only when you need to test shared state behavior. See [Writable](../concepts/types-and-schemas/writable.md#passing-values-to-pattern-inputs) for details.

## Running Tests

```bash
# Run a specific test
deno task cf test packages/patterns/my-pattern/main.test.tsx

# Run with verbose output
deno task cf test packages/patterns/my-pattern/main.test.tsx --verbose

# Run all tests in a directory
deno task cf test packages/patterns/my-pattern/
```

## Test Step Format

Tests use a **discriminated union** format:

```tsx
// Shown inside a pattern body.
return {
  tests: [
    { action: action_do_something },     // Runner calls .send()
    { assertion: assert_something },     // Runner checks === true
  ],
};
```

Each step is either `{ action: Stream<void> }` or `{ assertion: boolean }`.

## Writing Actions

Use `action()` to create void streams that trigger events on the pattern:

```tsx
// Shown inside a pattern body.
// Trigger a void handler
const action_reset = action(() => {
  game.reset.send();  // No argument needed for Stream<void>
});

// Trigger a handler with data
const action_add_item = action(() => {
  list.addItem.send({ name: "Test Item", quantity: 5 });
});

// Multiple operations in one action
const action_setup_game = action(() => {
  game.playerReady.send();
  game.startGame.send();
});
```

### Firing a handler the pattern does not export

A handler bound only in JSX can still be fired, so a pattern that keeps its
behaviour behind a button does not have to change to be tested. The prop carries
a stream whether the handler was written inline or bound from module scope. Walk
the rendered tree to the node, read the prop, and send it an event:

```tsx
// Shown at module scope.
import { action, pattern, UI } from "commonfabric";
import { findElementByText, propsOf } from "../test/vnode-helpers.ts";
import MapDemo from "./map-demo.tsx";

export default pattern(() => {
  const subject = MapDemo({ areasOfInterest: [] });

  const action_add_area = action(() => {
    const button = findElementByText(subject[UI], "cf-button", "+ Add Area");
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  return { tests: [{ action: action_add_area }], subject };
});
```

`packages/patterns/map-demo.test.tsx` drives both an inline arrow and a bound
handler this way.

Prefer an exported `Stream<T>` when you own the pattern: it states the entry
point in the output type. Use the tree walk when the handler belongs to the UI
and exporting it would only serve the test.

## Writing Assertions

Use `assert()` to create reactive boolean assertions:

```tsx
// Shown for illustration only.
// Simple equality
const assert_count_is_5 = assert(() => counter.value === 5);

// Complex conditions
const assert_all_items_valid = assert(() => {
  return list.items.every(item => item.quantity > 0);
});

// Multiple conditions
const assert_game_ready = assert(() => {
  return game.phase === "ready" && game.players.length === 2;
});
```

### Prefer `assert()` over `computed()`

Write new assertions with `assert()`. Most test patterns in the repository
still use `computed()`, which a step also accepts — but a failing `computed()`
assertion can only ever report the boolean it produced:

```
✗ assertion_1
    Expected true, got false
```

The comparison ran inside your own closure, so its operands were gone before
the runner saw anything. `assert()` records them as the assertion runs and
reports them on failure:

```
✗ assertion_1
    total <= budget
      total  = 45
      budget = 30
```

Each operand is labelled with the source text you wrote. `assert()` reports:

- the operands of the top-level operator — `total` and `budget` above
- the arguments of a call — `assert(() => inRange(value, low, high))` reports
  `value`, `low` and `high`
- for `&&`, `||`, `??` and `?:`, which side failed and the values behind it —
  `assert(() => x > 0 && y < 10)` reports `x > 0 = false` along with `x`

Short-circuiting is preserved, so an operand the assertion never evaluated is
never reported: if `x > 0` is false, `&&` never reads `y`, and nothing about
`y` appears. Literal operands are left out, since a literal renders to the text
you already wrote.

Values render the same way the rest of the runner renders them, so a mismatched
object or array shows its contents rather than `[object Object]`.

When a call's arguments say nothing — `items.every((i) => i.ok)`, whose only
argument is a function, or `items.includes("x")`, whose only argument is a
literal — the value reported is the receiver, `items`.

An assertion that recorded no operands at all has nothing to explain itself
with, so it reports the verdict alongside what you wrote:

```
✗ assertion_1
    Expected true, got false: ready
```

That usually means the assertion was a bare value. Compare it against what you
expect — `assert(() => ready === true)` — and the operands appear.

### Use `assert()` only for assertions

`assert()` carries a record of what it recorded, not a bare boolean, and a
record is always truthy. An `assert()` used as a *condition* would always take
the true branch:

```tsx
// Shown for illustration only.
const ready = assert(() => count.value === 5);
// Wrong: `ready` is a record, so this is always "yes".
const label = ifElse(ready, "yes", "no");
```

Reach for `computed()` for a reactive boolean you intend to read as a value,
and keep `assert()` for a test step's `assertion`.

Keep assertions deterministic. Do not call `safeDateNow()`,
`nonPrivateRandom()`, `Date.now()`, or `Math.random()` inside the assertion
itself. If the pattern stamps a timestamp or random ID, assert that the value
exists or changed in the expected place.

## Test Organization

### Naming Conventions

Use descriptive names that explain what the test verifies:

```tsx
// Shown for illustration only.
// Actions: action_<what_it_does>
const action_add_first_item = action(() => { ... });
const action_remove_all_items = action(() => { ... });

// Assertions: assert_<expected_state>
const assert_list_empty = assert(() => list.items.length === 0);
const assert_total_is_100 = assert(() => cart.total === 100);
```

### Logical Ordering

Put actions before the assertions that depend on them:

```tsx
// Shown inside a pattern body.
return {
  tests: [
    // Initial state
    { assertion: assert_starts_empty },

    // Add items
    { action: action_add_item },
    { assertion: assert_has_one_item },

    // Modify items
    { action: action_update_item },
    { assertion: assert_item_updated },

    // Remove items
    { action: action_remove_item },
    { assertion: assert_empty_again },
  ],
};
```

## Debugging Failed Tests

When a test fails, use the CLI to inspect pattern state:

### 1. Run with Verbose Mode

```bash
deno task cf test ./main.test.tsx --verbose
```

This shows which action ran before each assertion failure. An `assert()`
failure already names its operands and their values, which is usually enough to
see what went wrong without deploying anything.

### 2. Deploy and Inspect

Deploy the test pattern and use CLI commands to inspect state:

```bash
# Deploy the test pattern
deno task cf piece new ./main.test.tsx

# Get the piece ID from the output, then inspect
deno task cf piece inspect --piece <PIECE_ID>

# Get specific values
deno task cf piece get subject/items --piece <PIECE_ID>

# Step through manually
deno task cf piece call tests/0/action --piece <PIECE_ID>
deno task cf piece step --piece <PIECE_ID>
deno task cf piece get tests/1/assertion --piece <PIECE_ID>
```

### 3. Expose Debug Data

Add extra fields to your test pattern for debugging:

```tsx
// Shown for illustration only.
return {
  tests: [...],
  // Expose internals for debugging
  subject,
  debugState: computed(() => ({
    phase: game.phase,
    turn: game.currentTurn,
    scores: game.scores,
  })),
};
```

## Common Patterns

### Testing Initial State

```tsx
// Shown inside a pattern body.
// Verify pattern initializes correctly
const assert_initial_count = assert(() => counter.value === 0);
const assert_initial_empty = assert(() => list.items.length === 0);

return {
  tests: [
    { assertion: assert_initial_count },
    { assertion: assert_initial_empty },
    // ... actions and more assertions
  ],
};
```

### Testing State Transitions

```tsx
// Shown inside a pattern body.
const action_start = action(() => game.start.send());
const action_pause = action(() => game.pause.send());
const action_resume = action(() => game.resume.send());

const assert_playing = assert(() => game.phase === "playing");
const assert_paused = assert(() => game.phase === "paused");

return {
  tests: [
    { action: action_start },
    { assertion: assert_playing },
    { action: action_pause },
    { assertion: assert_paused },
    { action: action_resume },
    { assertion: assert_playing },
  ],
};
```

### Testing Computed Values

```tsx
// Shown inside a pattern body.
const action_add_items = action(() => {
  cart.addItem.send({ price: 10, quantity: 2 });
  cart.addItem.send({ price: 5, quantity: 4 });
});

const assert_total_correct = assert(() => {
  // 10*2 + 5*4 = 40
  return cart.total === 40;
});
```

## Best Practices

1. **Self-contained test data**: Keep test data inside actions, not external variables
2. **One thing per assertion**: Each assertion should verify one specific condition
3. **Meaningful names**: Names should describe expected state, not implementation
4. **Test edge cases**: Include actions for empty states, boundaries, error conditions
5. **Expose subject**: Return the pattern under test for CLI debugging

## See Also

- [Testing Handlers via CLI](./handlers-cli-testing.md) - Manual CLI testing workflow
- [Pattern Testing Spec](../../specs/PATTERN_TESTING_SPEC.md) - Technical specification
- [Coverage in CI](../../development/COVERAGE.md) - How the pattern unit tests run here feed the coverage-debt gate
- [Patterns package test lanes](../../../packages/patterns/deno.jsonc) - Where each kind of test (plain Deno unit test, pattern test, integration test) lives in the patterns package and how each is discovered and run
