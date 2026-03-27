# Pattern Testing

Write automated tests for patterns using the same reactive system.

## Prerequisites

Before writing tests, ensure your pattern:

1. **Uses `pattern<Input, Output>()`** - Single-type patterns can't be properly tested
2. **Exports actions as `Stream<T>`** - Required for `instance.action.send()` to work

```typescript
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

If your pattern uses `pattern<State>()` or doesn't export actions, fix the pattern first. See [Pattern Types](../concepts/pattern.md#always-use-dual-type-parameters).

## Overview

Test patterns are patterns that test other patterns. They:
- Import and instantiate the pattern under test
- Define test actions using `action()`
- Define assertions using `computed(() => boolean)`
- Return a `tests` array that the runner executes sequentially

Test files end in `.test.tsx` and are run with `deno task ct test`.

## Quick Example

```tsx
/// <cts-enable />
import { action, computed, pattern } from "commontools";
import Counter from "./counter.tsx";

export default pattern(() => {
  // 1. Instantiate pattern under test with plain values
  const counter = Counter({ value: 0 });

  // 2. Define actions (trigger events on the pattern)
  const action_increment = action(() => {
    counter.increment.send();
  });

  // 3. Define assertions (computed booleans)
  const assert_is_zero = computed(() => counter.value === 0);
  const assert_is_one = computed(() => counter.value === 1);

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

**Note:** Pass plain values when instantiating patterns in tests. The runtime creates independent writable cells automatically. Use `Writable.of()` only when you need to test shared state behavior. See [Writable](../concepts/types-and-schemas/writable.md#passing-values-to-pattern-inputs) for details.

## Running Tests

```bash
# Run a specific test
deno task ct test packages/patterns/my-pattern/main.test.tsx

# Run with verbose output
deno task ct test packages/patterns/my-pattern/main.test.tsx --verbose

# Run all tests in a directory
deno task ct test packages/patterns/my-pattern/
```

## Test Step Format

Tests use a **discriminated union** format:

```tsx
return {
  tests: [
    { action: action_do_something },     // Runner calls .send()
    { uiEvent: { attr: { name: "data-ui-action", value: "Submit" } } },
    { assertion: assert_something },     // Runner checks === true
  ],
};
```

Each step is one of:
- `{ action: Stream<void> }`
- `{ uiEvent: UiEventSpec }`
- `{ assertion: boolean }`
- `{ labelAssertion: LabelAssertionSpec }`
- `{ runtimeErrorAssertion: RuntimeErrorAssertionSpec }`

`uiEvent` is for testing UI-declared event integrity. Instead of calling an
exported stream directly, the runner:
- pulls the target pattern's `[UI]` output
- finds a node by path or attribute selector
- mints a `CfcEventEnvelope` from the node's declared labels
- dispatches that envelope through the bound event stream

This is useful when you want to verify behavior that depends on a handler being
invoked through a trusted UI surface rather than by directly calling `.send()`.
Traversal follows composed UI structure, including mapped child arrays rendered
through parent containers, so a parent list test can target a child row button
by selector.

If the pattern intentionally rejects an event and logs a runtime error, return
`allowRuntimeErrors: true` from the test pattern and assert the specific error
after the action:

```tsx
return {
  allowRuntimeErrors: true,
  tests: [
    {
      uiEvent: {
        target: "subject",
        attr: {
          name: "data-ui-action",
          value: "DangerousAction",
        },
      },
    },
    { assertion: assert_state_did_not_change },
    {
      runtimeErrorAssertion: {
        includes: [
          "CfcEventIntegrityViolationError",
          "DangerousAction",
        ],
      },
    },
  ],
};
```

## Writing Actions

Use `action()` to create void streams that trigger events on the pattern:

```tsx
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

## Writing UI Events

Use `uiEvent` when the test should simulate an event coming from declared UI:

```tsx
return {
  tests: [
    {
      uiEvent: {
        target: "subject",
        attr: {
          name: "data-ui-action",
          value: "SubmitDirectCommand",
        },
        sourceGestureId: "gesture-test-submit",
      },
    },
  ],
};
```

Selectors can use:
- `path`: relative to `/$UI` by default, such as `"/children/3"`
- `attr`: match a UI node by declared prop like `data-ui-action`
- `occurrence`: pick the Nth attr match when there are multiple matches

`uiEvent` can also assert what was minted before dispatch:
- `integrityIncludes`: atom patterns that must appear on the minted event
- `traceIncludesPaths`: composed UI traversal paths that must be present
- `expectedNodePath`: exact resolved node path that must be targeted

When tracing a trusted UI event back to authored code, treat the implementation
identity as:

- concrete `CodeHash(...)` for enforcement
- explicit code-origin metadata (`bundleLocation`, `sourceLocation`) for
  developer-facing diagnostics and trust configuration

Do not rely on function `.name` alone as the trust primitive. It is only a
display surface for the same underlying code origin.

Use `schema` when the authored manual JSON schema carries UI IFC labels that are
not recoverable from TypeScript-generated runtime schema metadata alone.

For repeated child UI, prefer an attribute selector plus `occurrence`:

```tsx
{
  uiEvent: {
    target: "list",
    attr: {
      name: "data-ui-action",
      value: "ShareReviewedMessage",
    },
    occurrence: 0,
    integrityIncludes: [
      {
        type: "https://commonfabric.org/cfc/atom/UiPlacement",
        surface: "InboxList",
        slot: "message-row",
      },
      {
        type: "https://commonfabric.org/cfc/atom/UiActionContract",
        action: "ShareReviewedMessage",
      },
    ],
    traceIncludesPaths: ["/$UI/children/2/children/0/0"],
    sourceGestureId: "gesture-first-share-click",
  },
}
```

## Guarding Handlers By Event Integrity

Use `requireEventIntegrity()` on a module-scope `handler()` when the mutation
should only run if the current event carries specific CFC integrity atoms:

```tsx
import { handler, requireEventIntegrity } from "commontools";

const guardedShare = requireEventIntegrity(
  handler((_: void, { shared }) => {
    shared.set(!shared.get());
  }),
  [{
    type: "https://commonfabric.org/cfc/atom/UiActionContract",
    action: "ShareReviewedMessage",
  }],
  { label: "ShareReviewedMessage" },
);
```

If the current event is missing one of the required atoms, the handler body does
not run and the runtime records a `CfcEventIntegrityViolationError`.

If you need a reviewer-facing explanation of *which* handler or lift is being
trusted, use the explicit code origin associated with the handler's
implementation identity. Enforcement should still key on `CodeHash(...)`, with
code origin acting as the bridge back to the authored `.tsx` source.

## Writing Assertions

Use `computed()` to create reactive boolean assertions:

```tsx
// Simple equality
const assert_count_is_5 = computed(() => counter.value === 5);

// Complex conditions
const assert_all_items_valid = computed(() => {
  return list.items.every(item => item.quantity > 0);
});

// Multiple conditions
const assert_game_ready = computed(() => {
  return game.phase === "ready" && game.players.length === 2;
});
```

## Test Organization

### Naming Conventions

Use descriptive names that explain what the test verifies:

```tsx
// Actions: action_<what_it_does>
const action_add_first_item = action(() => { ... });
const action_remove_all_items = action(() => { ... });

// Assertions: assert_<expected_state>
const assert_list_empty = computed(() => list.items.length === 0);
const assert_total_is_100 = computed(() => cart.total === 100);
```

### Logical Ordering

Put actions before the assertions that depend on them:

```tsx
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
deno task ct test ./main.test.tsx --verbose
```

This shows which action ran before each assertion failure.

### 2. Deploy and Inspect

Deploy the test pattern and use CLI commands to inspect state:

```bash
# Deploy the test pattern
deno task ct piece new ./main.test.tsx

# Get the piece ID from the output, then inspect
deno task ct piece inspect --piece <PIECE_ID>

# Get specific values
deno task ct piece get subject/items --piece <PIECE_ID>

# Step through manually
deno task ct piece call tests/0/action --piece <PIECE_ID>
deno task ct piece step --piece <PIECE_ID>
deno task ct piece get tests/1/assertion --piece <PIECE_ID>
```

### 3. Expose Debug Data

Add extra fields to your test pattern for debugging:

```tsx
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
// Verify pattern initializes correctly
const assert_initial_count = computed(() => counter.value === 0);
const assert_initial_empty = computed(() => list.items.length === 0);

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
const action_start = action(() => game.start.send());
const action_pause = action(() => game.pause.send());
const action_resume = action(() => game.resume.send());

const assert_playing = computed(() => game.phase === "playing");
const assert_paused = computed(() => game.phase === "paused");

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
const action_add_items = action(() => {
  cart.addItem.send({ price: 10, quantity: 2 });
  cart.addItem.send({ price: 5, quantity: 4 });
});

const assert_total_correct = computed(() => {
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
