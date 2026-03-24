# Pattern Testing Guide

This is the canonical reference for testing Common Fabric patterns.

## Preconditions

Before writing tests, verify the pattern exposes an interface that tests can
exercise:

- `pattern<Input, Output>()`
- actions typed as `Stream<T>` where tests need to call `.send()`
- bound handlers returned from the pattern when the behavior is externally
  triggered

If those are missing, fix the pattern first. Tests cannot meaningfully drive
the pattern without a testable output contract.

## Preferred Test Scope

Write tests for:

- state transitions that are awkward to verify by clicking
- regressions that are easy to reintroduce
- edge cases with real branching logic

Avoid tests for:

- code that is still only a sketch
- behavior that is obvious and cheap to validate interactively
- flows that are better validated in runtime or browser testing

## Test Command

```bash
deno task cf test <pattern>.test.tsx
```

## Test File Shape

The usual shape is:

1. instantiate the pattern under test
2. define actions that trigger output streams or bound handlers
3. define assertions as `computed(() => boolean)`
4. return the test sequence in order

```tsx
/// <cts-enable />

import { action, computed, pattern } from "commonfabric";
import Pattern from "./pattern.tsx";

export default pattern(() => {
  const instance = Pattern({ /* input */ });

  const actionDoSomething = action(() => {
    instance.someAction.send();
  });

  const assertInitialState = computed(() => instance.someField === expectedValue);
  const assertAfterAction = computed(() => instance.someField === newValue);

  return {
    tests: [
      { assertion: assertInitialState },
      { action: actionDoSomething },
      { assertion: assertAfterAction },
    ],
  };
});
```

## Key Points

- trigger actions with `.send()` when the output exposes streams
- use direct property access for assertions rather than `.get()` unless the API
  truly requires writable access
- keep scenario ordering readable; tests should tell the story of the state
  transition
- test a sub-pattern before building the next dependent layer when that helps
  isolate failures

## Done When

- the test file exists beside the pattern or in the expected local test layout
- the tests pass
- the test report explains what was covered and what was intentionally omitted
- the pattern still compiles after any interface changes made to support
  testing
- the pattern is ready for the next dependent sub-pattern or release step
