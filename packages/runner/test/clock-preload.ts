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
    // The server-execution real-Worker e2e seam. A spawned Worker runs in its
    // OWN realm on the real clock, so the host-side barriers these files race
    // against it are wall-clock by construction: the Worker keeps the host loop
    // refed, auto-advance never fires the host's own timers, and the control
    // barriers never resolve. Each was checked individually — all hang or fail
    // under the fake clock and pass on the real one. Converting them means
    // driving BOTH realms' time together, which is its own change.
    // Giving the Worker realm the same fake clock would let these drop.
    "executor-candidate-claim",
    "executor-claim-e2e",
    "executor-drain-barrier",
    "executor-pending-demand",
    "executor-piece-linger",
    "executor-provider-parity",
    "executor-scoped-egress-e2e",
    "server-execution-rollout-products",
    // Same class one layer down: a lease-bound `HostStorageManager` (the
    // executor host provider) whose sponsor attachment and cold-refresh
    // cooldown are wall-clock. Under the fake clock the sponsor reads as
    // detached ("execution lease sponsor is no longer attached") or the
    // cooldown never elapses. All three pass on the real clock.
    "executor-foreign-read-value",
    "executor-provider-foreign-point-reads",
    "executor-provider-point-reads",
  ],
});
