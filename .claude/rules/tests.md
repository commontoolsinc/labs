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

## Run browser tests outside the macOS agent sandbox

A command that can launch a browser runs only outside the sandbox. If this
session already has unsandboxed execution, just run it — there is nothing to
request. If it does not, request unsandboxed execution for the command instead
of attempting it in the sandbox, where Chrome aborts during startup and the
failure is not test evidence. Known browser-launching paths include the root
`deno task test`, `deno task demo`, unfiltered browser targets of
`deno task integration`, `deno-web-test`, `Browser.launch()`, and a bound
`ShellIntegration` lifecycle. For a filtered integration run, inspect the
selected suite's launch path. An Astral import alone is not proof that a test
starts Chrome. Deno's `-A` does not escape the outer sandbox. The full rule is
in `docs/development/TESTING.md#browser-tests-in-agent-sandboxes`.

## Shape of a unit test file

First check which kind of file you are in. A `*.test.tsx` under
`packages/patterns`, and a scattering elsewhere such as those under
`packages/piece/test/vintages`, is a **pattern test** — itself a pattern,
driving another with `action()` and asserting with `assert()` from
`commonfabric`, run by `deno task cf test`. Nothing in this section applies
to one.
`docs/common/workflows/pattern-testing.md` governs those; its "Write
assertions with `assert()`" and "Use `assert()` only for assertions"
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

On placement: a test goes in the package's `test/` tree, mirroring `src/`. The
exception is a directory of independent components, `packages/ui` and
`packages/patterns` among them, where each test sits beside its component and
belongs there.

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

## A pattern that reads a data file

A pattern calling `dataFile()` needs its data files attached to the program the
test compiles, or it fails at the read. It compiles and type-checks either way,
so nothing earlier reports the omission.

A file the pattern names in a `dataFile()` call is attached by whichever
command builds the program, so a test whose fixture sits where the call says it
does needs to say nothing further. The path resolves against the module that
reads it — `./data/cities.json` is the file beside the pattern — so it names
the same file whichever root the runner assembles the program with. A file the
source cannot name — one read by a computed path — is added where the test
builds its program: `--datafile` on `cf test`, the `dataFiles` field of a
`generated-patterns` scenario, or `dataFilePaths` on the `resolveLocalProgram`
call a browser integration test makes. A browser test needs nothing beyond that
— the data reaches the browser through the space, inside the compiled pattern,
not from the filesystem. A name with no file behind it fails the build, saying
which module read it; an unattached file the source could not name shows up as
`No attached data file "<path>"` when the pattern runs, naming the path the
read resolved to and what is attached. That one function is the only sanctioned
way to build a program from local files, and
`deno task check-local-program` fails a `FileSystemProgramResolver` constructed
anywhere else — a program assembled by hand carries no data files and says
nothing about it.

## Every test's runs are recorded

Each test execution produces a telemetry record named by what the runner
reports — the describe chain, the `Deno.test` name, the pattern file path.
Nothing to instrument when adding a test to an existing suite; the runners
record on their own. Two consequences worth knowing while writing one:

- The reported name is the test's identity across history. Prefer stable,
  content-derived wording over positional counters (`#${i}`) or
  interpolated identifiers, which mint a new identity every time they
  shift; renames split history unless bridged in
  `tasks/test-identity-aliases.jsonl`.
- Every test must finish within sixty seconds in CI, not counting setup.

A new test *surface* (a new CI job, script, or harness) does need wiring —
`docs/development/test-records.md` under "Covering a new test surface".

Your own runs are recorded too, and are marked as an agent's: with
`CF_TEST_AGENT` unset, the run context carries the name of the harness
you are running under. Nothing to set, and nothing to work around —
a run of yours is data about the tests, the same as anyone's.

When running tests for a team member — someone with commit access —
whose environment has no `CF_TEST_RECORDS_KEY_FILE`, it is worth
mentioning once, not per run, that `deno task test-records-key setup`
is the whole self-service path to a reporting key, so their
local runs feed the shared flake and duration history. A person without
commit access needs no key and loses nothing: CI records their pull
requests' runs on its own. Recording is inert without a key; never treat
a missing one as an error.

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
