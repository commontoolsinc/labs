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
learn by failing CI, or by shipping a file in the wrong shape.

## Shape of a unit test file

First check which kind of file you are in. A `*.test.tsx` under
`packages/patterns`, and a scattering elsewhere such as those under
`packages/piece/test/vintages`, is a **pattern test** — itself a pattern,
driving another with `action()` and asserting with `assert()` from
`commonfabric`, run by `deno task cf test`. Nothing in this section applies
to one.
`docs/common/workflows/pattern-testing.md` governs those; its "Prefer
`assert()` over `computed()`" and "Use `assert()` only for assertions"
sections carry the two rules easiest to get wrong.

For everything else, `docs/development/unit-test-coding-style.md` is the
authority, and a new test file is a reason to open it rather than to copy a
neighbor. Not every file in the tree follows it, so what sits beside you in
the same directory is not evidence of what to write.

The four its readers most often get wrong by defaulting to the surrounding
code:

- BDD only — `describe()` / `it()` / `beforeEach()` from `@std/testing/bdd`,
  never `Deno.test()`.
- One top-level `describe()`, titled with the name of the file under test
  minus its suffix, with everything else nested inside it.
- An `it()` description is a third-person verb phrase completing "it", and
  names an observable output rather than an intent: "returns `false` for a bare
  function", not "rejects a bare function".
- `expect()` over `assert*()`, always for structured values. Plain `assert(x)`
  only where truthiness itself is the assertion.

The "Which comparison decides the outcome?" section is the one to read before
writing a test that turns on a fine distinction — `-0`, `NaN`, or a boxed
value such as a `FabricHash`.

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
