// Runs before every test module in this package (wired in through `--preload`
// on the package's test task). It installs the shared fake clock in
// "auto-advance" mode: the runtime's own positive-delay timers (armed from
// `src/` — throttle windows, backoff, conflict retries) advance logical time on
// their own so `runtime.idle()`, `cell.pull()`, and commit resolve without real
// sleeping, while a wall-clock sleep armed from a `test/` file freezes and its
// waiter deadlocks. The controls are a global `clock` (settle/tick/reset), typed
// in `test/clock.d.ts`. See the shared harness at
// `packages/test-support/test/clock-preload.ts` and
// `docs/development/waiting-in-tests.md`.

import { installFakeClock } from "@commonfabric/test-support/clock-preload";

installFakeClock({
  mode: "auto-advance",
  // Test files kept on the real clock for now. These should be converted to use
  // a fake clock. // TODO: convert these tests to a fake clock
  realClockFiles: [
    // The sibling resume test: its reload storage manager holds each per-element
    // child document back by a real delay to open the resume window it observes,
    // and the resuming runtime's pull/idle machinery blocks on those deliveries.
    // Under the fake clock the delay is a frozen test-file timer that pull/idle
    // wait on, so the resume deadlocks; the real clock delivers them as intended.
    "list-resume-preserve",
    // A generateObject delegate tool runs a child agent against a result schema
    // the model supplies in the tool input, so the child reaches its own request
    // only after that input has settled through the graph. The tool-calling path
    // guards its wait with a deadline, and the pump reads the resulting macrotask
    // boundary as an idle loop and jumps to that deadline, aborting the delegate
    // ("Tool call timed out") mid-flight. The pump cannot tell that deadline from
    // a backoff window, which other tests need it to fire during the same churn.
    // Retiring that deadline is what lets this file and the next one convert.
    // Each case asserts on the delegate's own tool result, so dropping an entry
    // here turns them red rather than quietly green.
    "generate-object-tools-dynamic-subagent",
    // The same delegate-tool shape, reached through llmDialog rather than
    // generateObject.
    "llm-dialog-dynamic-subagent",
  ],
});
