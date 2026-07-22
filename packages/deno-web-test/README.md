# deno-web-test

`deno-web-test` is a test runner for running Deno tests in a browser. This is
used in code compatible with both Deno and browsers in order to test browser
functionality.

## Usage

Write a test using `Deno.test`:

```ts
// add.test.ts
import { assert } from "@std/assert";

Deno.test("add", function () {
  assert((5 + 5) === 10, "math checks out");
});
```

Optionally add a `deno-web-test.config.ts` to the project root to configure the
runner. See [config.ts](/deno-web-test/config.ts) for all options.

```ts
export default {
  headless: true,
  devtools: false,
  product: "chrome",
  args: ["--enable-experimental-web-platform-features"],
  pipeConsole: true,
  testTimeout: 40_000,
  include: {
    "path/static-asset.json": "static/asset.json",
  },
};
```

## Stuck tests

A test that waits on something which never arrives would otherwise hang until
astral's retried deadline on `page.evaluate` ran out of attempts, 53 to 57
seconds later, with a `RetryError` that named no test, printed no summary, and
abandoned every test file still queued. The harness stops waiting on a test
after `testTimeout` (40 seconds by default) and fails that test with a message
naming it and saying how long it waited. The rest of the run continues, so one
stuck test costs one failure rather than the whole suite's results.

This is a stuck detector, not a bound on how long a test may take. Astral does
not re-run a test that runs long: it awaits each test through a single
`page.evaluate`, and when its own ten-second deadline elapses it re-waits on
that same in-flight call rather than failing, up to five times. So the test body
runs once, and a slow one is returned by whichever attempt is live when it
finishes — which is why tests well past 40 seconds pass today. This detector is
the first hard bound over them, and its early fire fails a passing test, so it
sits high on purpose. Astral's five attempts run out at a hard fifty-second
floor, and the detector has to fire below that to name the test before astral
takes the run down unnamed — but the lower it fires, the wider the window in
which a clock jump (a suspend, a CI pause) trips it on a healthy test that
astral's re-waiting would have ridden out. Forty seconds is as high as reliably
beats the floor. Raise `testTimeout` for a suite with genuinely long tests, and
keep it under fifty seconds.

Two limits are worth knowing. Nothing can cancel the test's own promise, so a
stuck test keeps running in the page afterwards and can still disturb later
tests. And the detector is a timer in the page, so it cannot fire against a test
that blocks the event loop outright — a spinning loop still reaches astral's
deadline.

Finally, run `deno-web-test/cli.ts`, which takes a glob of files to test.

```json
{
  "tasks": {
    "test": "deno run -A deno-web-test/cli.ts *.test.ts"
  }
}
```

## Support

Currently only the `Deno.test(string, fn)` signature works. Using other
signatures, or the BDD framework in `@std/testing/bdd` is not yet supported.

## Testing

For testing `deno-web-test` itself, the test suites (running in Deno itself) run
`deno-web-test` for subprojects to test features. Due to being in a workspace,
and not wanting to clutter the workspace with these test directories, and Deno
attempting to enforce this, the test packages are moved to a temporary directory
and the test task rewritten to target the local `cli.ts` export. This could be
relaxed if moved outside of the workspace.
