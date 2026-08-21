## Testing

### Running Tests

**From workspace root** (recommended):

```bash
# Run all tests (includes unit and integration)
deno task test

# Run tests for specific package
cd packages/runner
deno task test
```

**Important:** Always use `deno task test` from the root, NOT `deno test`, as the task includes necessary flags.

### Browser tests in agent sandboxes

Headless Chrome registers with AppKit and needs Launch Services and
WindowServer, which the macOS agent sandbox can deny, aborting Chrome during
startup. That abort is an artifact of the sandbox rather than a test result,
and the same sandbox reproduces it. So a browser command runs outside the
sandbox: when the harness reports the session as already unsandboxed, run the
command; when it reports otherwise, request unsandboxed execution instead of
trying it there first. Read that from the harness's own report of the session,
not from an escalation option being available — a harness may offer one to a
session that has no sandbox to escape.

The following repository commands and test paths launch a browser:

- The root `deno task test` command, which reaches browser-backed workspace
  package tests.
- The unfiltered root `deno task integration` command. With no target, it
  includes browser tests from `shell` and `patterns`. Unfiltered target runs
  for `shell`, `patterns`, and `patterns-reload` also include browser tests.
- A filtered integration run when the selected test launches a browser. A
  package name associated with browser tests does not by itself establish that
  a filtered test launches one.
- The `deno task demo` command.
- Tests that run `deno-web-test`, call `Browser.launch()`, or bind a
  `ShellIntegration` lifecycle.

An `@astral/astral` import alone is not proof that a test launches Chrome. It
can be a type-only import or support a fake browser. When it is not clear
whether a focused test starts a browser, inspect its suite setup and launch
call path before running it.

Deno's `-A` flag changes Deno's permission checks but does not escape the outer
agent sandbox. Chrome's `--no-sandbox` flag disables a different protection;
do not add it as a workaround.

If a browser command did run inside the agent sandbox, disregard its
browser-startup failure and rerun it outside the sandbox before interpreting
the test result.

### Tests that start Deno

For deliberate import-map and lockfile changes, follow the
[dependency maintenance guide](DEPENDENCIES.md). This section covers the
separate requirement that verification tests preserve the checked-in graph.

Dependency installation and verification are separate parts of CI. Installation
may fetch registry metadata and package contents. Verification must use the
dependency graph recorded in `deno.lock` without resolving package versions
again.

Use `@commonfabric/test-support/isolated-deno` when a test starts another Deno
process. Its check helper copies the lockfile and runs `deno check` with frozen
dependency resolution. A generated config may change compiler options, but it
must preserve the root config's imports and workspace members. Package imports
already come from each workspace member's config and must not be copied into
the generated root config.

This boundary keeps a verification test independent of mutable registry
metadata. It also makes an accidental dependency graph change fail as an
out-of-date lockfile instead of silently resolving a different graph.

Both helpers start the Deno that is running the test, found through
`Deno.execPath()`. Starting the program named `deno` instead would find whatever
copy comes first on `PATH`, which is a different version than the pin in
`mise.toml` on any machine whose shell Deno is not that pin. The versions share
one cache directory and each reads transpiled sources only from its own part of
it, so a test that collects a coverage profile under one version and reports it
under the other gets a report with every file missing.

Deno resolves an allowlist entry of `deno` through `PATH` as well, so
`--allow-run=deno` refuses the very binary the test is running under. Name that
binary instead of widening the grant. A task line can compute it, because `deno`
inside one runs the Deno running the task whatever `PATH` says:

```
--allow-run=$(deno eval "console.log(Deno.execPath())")
```

A test launched from a script can read `Deno.execPath()` directly, as
`packages/dashboard/test/runner.ts` does with `--allow-run=${Deno.execPath()},git`.

That a task's `deno` is the running one rather than one found on `PATH` is what
makes the computed form name the right binary, so
`packages/test-support/src/isolated-deno.test.ts` holds it in place: it runs a
task with a decoy `deno` as the only entry on the child's `PATH` and fails if the
decoy is the one that runs.

### Test Structure

- **Unit tests**: Use `@std/testing/bdd` (`describe`/`it`) with `@std/expect` for assertions
- **Integration tests**: Executable scripts that test end-to-end workflows against a running API
- **Test files**: Named `*.test.ts`

**Unit test example:**

```typescript
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { isDeepFrozen } from "@commonfabric/data-model/deep-freeze";

describe("deep-freeze", () => {
  describe("isDeepFrozen()", () => {
    it("returns `false` for a plain unfrozen object", () => {
      expect(isDeepFrozen({ a: 1 })).toBe(false);
    });
  });
});
```

Note the shape: one top-level `describe()` named after the file under test, a
nested `describe()` per function, and an `it()` reading as a verb phrase that
completes the word "it".
[Unit test coding style](unit-test-coding-style.md) covers that shape in full:
where a test file goes, what it is called, how class and function tests nest,
which assertions to reach for, and the matcher traps that produce a green test
proving nothing.

**Integration test example:**

Integration tests are executable scripts that connect to a real backend and test full workflows. They are located in `packages/runner/integration/` and follow this pattern:

```typescript
// Shown for illustration only.
#!/usr/bin/env -S deno run -A

import { Runtime } from "@commonfabric/runner";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { env } from "@commonfabric/integration";
const { API_URL } = env;

console.log("=== TEST: My Integration Test ===");

async function test() {
  const identity = await Identity.fromPassphrase("test operator");

  const runtime = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  // Test your workflow here
  // ...

  await runtime.dispose();

  // Return results or throw on failure
}

await test();
console.log("Done");
Deno.exit(0);
```

**Key characteristics of integration tests:**
- Start with shebang: `#!/usr/bin/env -S deno run -A`
- Connect to real API using `env.API_URL` from `@commonfabric/integration`
- Test complete workflows (runtime, storage, pieces)
- Use `console.log` for output and `Deno.exit(1)` for failures
- Run as part of CI against deployed backend

**Adding integration tests:**

When adding runtime features, consider adding integration tests to `packages/runner/integration/` that verify the feature works end-to-end. See existing tests like `basic-persistence.test.ts` or `array_push.test.ts` for examples.

### Recording browser integration tests as video demos

Selected `patterns` and `shell` browser integration tests can be recorded with
the same local servers, browser identities, UI events, waits, assertions, and
cleanup used by the normal integration suite:

```bash
deno task demo patterns cfc-render-policy-demo
deno task demo patterns cfc-render-policy-demo lunch-poll-vote
deno task demo patterns lunch-poll-vote --output=tmp/demos/lunch-poll.mp4
```

Each file filter must resolve to exactly one `*.test.ts` file. The command runs
each complete file sequentially because its `it` blocks may share suite setup
and browser state. Every invocation writes an `index.html` video gallery beside
the test-named MP4s and versioned diagnostic manifests beneath `tmp/demos/`.
The gallery uses relative links, so its complete directory can be copied or
served as-is.

With one filter, `--output=PATH` copies the final MP4 to a chosen file. With
multiple filters, `--output=DIRECTORY` copies the named MP4s and a portable
`index.html` gallery into that directory.

FFmpeg must be installed and available as `ffmpeg`, or its path must be set in
`FFMPEG`. Normal integration tests do not require FFmpeg. Useful options are
`--keep-frames`, `--viewport=WIDTHxHEIGHT`, and `--port-offset=N`.

Presentation mode modifies the existing browser interaction paths rather than
using demo-only clicks or typing. Inputs type with a readable character delay,
clicks show an injected cursor, and labeled scenario steps appear as captions.
All presentation behavior is disabled during `deno task integration`.

Tests with multiple `ShellIntegration` instances retain their independent
browsers and identities. Each page is recorded against one shared timeline and
the streams are composed afterward: two participants are side by side, while
three or four use a 2-by-2 grid. Configure stable labels and colors through the
shell's `presentation` metadata.

If a test, browser capture, or FFmpeg encode fails, the command exits nonzero
and retains its manifest and available intermediate streams under the printed
run directory.

## Patterns that read data files

A pattern calling `dataFile()` reads a file attached to the program under test.
The call names the file, and that is the declaration every test path reads:
`resolveLocalProgram` attaches what the source asks for, so a pattern under
test behaves the way it does deployed without the test restating anything. The
path resolves against the module that reads it, so `./data/cities.json` is the
file beside the pattern under whichever root the test's own runner assembles
the program with — a test lane rooted at `packages/patterns` and a gate rooted
at the repository reach the same file. A file the source cannot name — one read
by a computed path — is added where the test builds the program: `cf test`
takes repeatable `--datafile` paths, a `generated-patterns` scenario names them
in `dataFiles` grounded by `dataRoot`, and a browser integration test passes
`dataFilePaths` to `resolveLocalProgram`.

A browser integration test needs nothing further: the data travels to the
browser inside the compiled pattern the space holds, so there is no file to
serve and no browser-side plumbing to arrange.

The attachment is easy to leave out and reports nothing when it is: the pattern
compiles and type-checks without it, and fails only when it reads, with
`No attached data file "<path>"` — naming the path the read resolved to, and
what is attached instead. That is why
`resolveLocalProgram` is the one operation for building a program from local
files, and why `deno task check-local-program` refuses a
`FileSystemProgramResolver` built anywhere else.

## Related documentation

- [test-records.md](test-records.md) — the record of every test execution:
  every suite here reports one record per test to a public store, and that
  document covers what gets recorded, opting a workstation in, and reading
  the data.
- [unit-test-coding-style.md](unit-test-coding-style.md) — how a unit test file
  is shaped: where it lives and what it is called, the single top-level
  `describe()` and the blocks nested under it, how an `it()` description is
  worded, `expect()` over `assert*()`, and the matcher traps that yield a green
  test which proves nothing. Read it before writing a new test file.
- [waiting-in-tests.md](waiting-in-tests.md) — waiting in tests: prefer
  primitives that resolve on a real event over polling with a timeout. Covers
  the event-driven primitives, the `check-no-waitfor` CI guard that keeps new
  polling `waitFor` out of the integration suites, and the deliberate exceptions
  where a bounded poll is the honest observation — read it before adding a poll.
- [waiting-in-tests-rationale.md](waiting-in-tests-rationale.md) — the analysis
  and case studies behind that guidance: the full argument against bounded
  timeouts, the sizing of the deno-web-test backstop, retired real-clock
  exemptions, the FUSE exec suite's design, and the production waits that apply
  the same principle. Not needed to write a test; read it before changing the
  wait machinery itself.
- [COVERAGE.md](COVERAGE.md) — how CI measures coverage. It explains the two
  mechanisms (Deno's V8 coverage for runtime code, and transformer-based
  coverage for authored patterns) and how both feed the coverage-debt gate.
- [CI_PERFORMANCE.md](CI_PERFORMANCE.md) — the CI wall-time policy, and the
  coverage-debt baseline and ratchet markers that gate a pull request.
- [BENCHMARKS.md](BENCHMARKS.md) — how `*.bench.ts` files run in CI, how the
  team ops dashboard charts their trends, and the naming and stdout
  constraints a bench file must satisfy.
- [llm-testing.md](../features/llm-testing.md) — testing patterns and server
  routes that call the LLM, including the test-environment guard and
  conversation fixtures.
- [UI_TESTING.md](UI_TESTING.md) — testing shadow DOM components in browser
  integration tests.
- [../specs/pattern-update-testing.md](../specs/pattern-update-testing.md) —
  the two CI gates standing between an incompatible pattern and every piece
  running it: contract compatibility (`deno task pattern-compat`) and state
  continuity (`deno task pattern-vintage`), what each proves, and what an
  author does to add a pattern to the fixture set.
- [../common/workflows/pattern-testing.md](../common/workflows/pattern-testing.md)
  — writing and running pattern tests with `cf test`. The agent-oriented version
  is [../common/ai/pattern-testing-guide.md](../common/ai/pattern-testing-guide.md),
  and the design reference is [../specs/PATTERN_TESTING_SPEC.md](../specs/PATTERN_TESTING_SPEC.md).
