// Runs before every test module in this package (wired in through `--preload`
// on the package's test task). It installs the shared fake clock in
// "auto-advance" mode: the service's own positive-delay timers (armed from
// `src/` — `SpaceManager.#execLoop`'s poll interval, `SpaceManager.stop`'s
// deactivation deadline, and `WorkerController.#exec`'s request timeout, all
// reached through the `sleep` helper in `@commonfabric/utils`) advance logical
// time on their own, so a poll elapses instantly and an unanswered worker
// request times out without real sleeping, while a wall-clock sleep armed from a
// `test/` file freezes and its waiter deadlocks. The controls are a global
// `clock` (settle/tick/reset), typed in `test/clock.d.ts`. See the shared
// harness at `packages/test-support/test/clock-preload.ts` and
// `docs/development/waiting-in-tests.md`.

import { installFakeClock } from "@commonfabric/test-support/clock-preload";

installFakeClock({
  mode: "auto-advance",
  realClockFiles: [
    // otel.test.ts exercises the real OpenTelemetry SDK against a real loopback
    // OTLP receiver. The provider's forceFlush and shutdown guard each flush
    // with their own setTimeout, armed inside the vendored SDK rather than from
    // `src/`; under auto-advance that guard fires against the real HTTP round
    // trip before it completes, and the flush reports that the span processor
    // did not finish within its timeout. The SDK's periodic metric reader arms a
    // repeating interval that is a production timer too. These tests carry no
    // sleeps or deadlines to convert, so the fake clock buys them no
    // determinism; they keep real time, already opt out of the op sanitizer for
    // those timers, and tear them down through shutdownOpenTelemetry.
    "otel",
  ],
});
