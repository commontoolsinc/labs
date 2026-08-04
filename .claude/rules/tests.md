---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.bench.ts"
  - "**/integration/**/*.ts"
---

# Writing tests

`docs/development/TESTING.md` is the map for everything testing — how the
suites run, how each kind of test is shaped, and a "Related documentation"
section routing to coverage, benchmarks, shadow DOM, language-model tests, and
the pattern-update gates. What follows is only the part you would otherwise
learn by failing CI.

## Wait on an event, never on a poll

`deno task check-no-waitfor` fails the build when a test imports the polling
`waitFor` from `@commonfabric/integration`. Reach for the primitive that
resolves on the thing actually happening:

- In a browser test: `awaitViewSettled(page)` for "the view is interactive",
  then `waitForText`, `clickCfButton`, `clickCfButtonAndWaitForText` and the
  rest of `packages/patterns/integration/cfc-browser-helpers.ts`.
- With no page: resolve a `defer()` from a callback the test already registers
  — a cell sink, a subscription's `next`, the scheduler's `onError`.

The full toolkit is in `docs/development/waiting-in-tests.md`. Read it before
adding a bounded poll; the section that decides the question is "Where the
polling `waitFor` stays". Its companion
`docs/development/waiting-in-tests-rationale.md` carries the argument and the
case studies, which writing a test does not need and changing the wait
machinery does.

If an event-driven wait genuinely cannot express the condition — a condition
spanning two browser pages, a headless cell read with no callback to hang on —
the exemption takes two edits, not one: add the file to `ALLOWLIST` in
`tasks/check-no-waitfor.ts` with a one-line reason, and record the same reason
under "Where the polling `waitFor` stays" in
`docs/development/waiting-in-tests.md`. A file in the allowlist with no entry in
the document is an exemption nobody can review.

The repository-wide ban on timeouts, retry loops, and sleeps applies here with
no exceptions, including in setup and teardown.

## Reaching into shadow DOM

Integration tests address components through accessibility locators rather than
by walking shadow roots. `docs/development/UI_TESTING.md` covers the
nested-shadow-root cases and the helpers for them.

## Tests that start another Deno process

Use `@commonfabric/test-support/isolated-deno`, which copies the lockfile and
runs with dependency resolution frozen. A test that resolves the graph again,
or that writes into the tree it is checking, turns an accidental dependency
change into a silent pass. "Tests that start Deno" in
`docs/development/TESTING.md` states the boundary; the `isolated-test-processes`
skill walks through applying it.
