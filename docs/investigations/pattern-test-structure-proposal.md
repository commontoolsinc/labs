# Proposal: Structured Tests Object

## Problem

The current test structure uses a mixed array:
```typescript
tests: [assert_initial, action_fire, assert_after_fire, ...]
```

This fails to compile because `action()` returns `HandlerFactory` and `computed()` returns 
`OpaqueCell`, and mixing them in an array triggers TypeScript's declaration emit to expand
types containing `unique symbol` computed property keys.

## Proposed Solution

Use a structured object that keeps types separate:

```typescript
tests: {
  assertions: { initial: assert_initial, afterFire: assert_after_fire, ... },
  actions: { fire: action_fire, reset: action_reset, ... },
  sequence: ['initial', 'fire', 'afterFire', 'reset', ...],
}
```

### Benefits

1. **Compiles** - No mixed arrays, so no type expansion issue
2. **Readable** - Sequence reads as a list of named steps
3. **Reusable** - Same assertion/action can appear multiple times in sequence
4. **Self-documenting** - Named keys describe what each step does

### Example

```typescript
export default pattern(() => {
  const game = Battleship({});
  
  return {
    tests: {
      assertions: {
        initialPhase: computed(() => game.game.phase === "playing"),
        isPlayer1Turn: computed(() => game.game.currentTurn === 1),
        shotRecorded: computed(() => game.game.player2.shots[9][0] === "miss"),
      },
      actions: {
        playerReady: action(() => game.playerReady.send()),
        fireMiss: action(() => game.fireShot.send({ row: 9, col: 0 })),
        passDevice: action(() => game.passDevice.send()),
      },
      sequence: [
        'initialPhase',    // ✓ game starts in playing phase
        'isPlayer1Turn',   // ✓ player 1's turn
        'playerReady',     // → player 1 ready
        'fireMiss',        // → fire at empty square
        'shotRecorded',    // ✓ miss recorded
        'passDevice',      // → pass to player 2
      ],
    },
    game,
  };
});
```

## Test Runner Changes

The test runner (`packages/cli/lib/test-runner.ts`) would need to:

1. Detect structured vs flat tests format
2. For structured format:
   - Get `tests.assertions`, `tests.actions`, `tests.sequence`
   - Iterate through `sequence` array
   - For each key, look it up in `assertions` first, then `actions`
   - If found in assertions: call `.get()` and check for `true`
   - If found in actions: call `.send({})` and wait for idle

```typescript
// Pseudocode for structured test handling
const { assertions, actions, sequence } = testsValue;

for (const stepKey of sequence) {
  if (stepKey in assertions) {
    const cell = assertions[stepKey];
    const passed = cell.get() === true;
    // record result
  } else if (stepKey in actions) {
    const stream = actions[stepKey];
    stream.send({});
    await runtime.idle();
  } else {
    throw new Error(`Unknown test step: ${stepKey}`);
  }
}
```

## Migration

Existing tests would need to be updated from:
```typescript
tests: [assert_a, action_b, assert_c]
```

To:
```typescript
tests: {
  assertions: { a: assert_a, c: assert_c },
  actions: { b: action_b },
  sequence: ['a', 'b', 'c'],
}
```

The test runner could support both formats for backwards compatibility during migration.
