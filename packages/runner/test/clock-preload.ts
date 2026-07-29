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
    // Drives a nested-subagent generateObject: a delegate tool runs a child
    // pattern whose result feeds back to the parent through the post-commit
    // outbox across several cycles. The tool-calling path carries its own
    // timeout, which auto-advance fires against the subagent's own outbox
    // progress rather than the wall clock, aborting the delegate ("tool call
    // timed out") before it can complete. Real time paces the two together.
    "generate-object-tools",
  ],
});
