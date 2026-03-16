# Pattern Testing Guide

This is the agent-neutral reference for testing Common Fabric patterns.

## Preconditions

Before writing tests, verify the pattern exposes an interface that tests can
exercise:

- `pattern<Input, Output>()`
- actions typed as `Stream<T>` where tests need to call `.send()`
- bound handlers returned from the pattern when the behavior is externally
  triggered

If those are missing, fix the pattern before writing tests.

## Preferred Test Scope

Write tests for:

- state transitions that are awkward to verify by clicking
- regressions that are easy to reintroduce
- edge cases with real branching logic

Avoid tests for:

- code that is still only a sketch
- behavior obvious from the implementation and easy to validate interactively

## Test Command

```bash
deno task ct test <pattern>.test.tsx
```

## Minimal Test Shape

Tests should:

- instantiate the pattern
- trigger actions through returned streams
- assert state through computed booleans
- keep the scenario ordering readable

## Completion Standard

- the test file exists beside the pattern or in the expected local test layout
- tests pass
- the test report explains what was covered and what was intentionally omitted
