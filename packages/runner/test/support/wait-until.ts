// The bounded poll shared by the suites that drive a live memory server or a
// live ExecutorHost. What they wait on — an engine row, a watermark advance, a
// stats counter — becomes true as a side effect of the serving loop's own
// cycles, and nothing exposes an event for it: `SpaceServer` offers `stats()`
// and `spaceServer()` and no notification, and the engine is a synchronous
// store. So this is `waiting-in-tests.md`'s "no page, and no callback to hang
// a promise on" shape, where a poll is the honest observation.
//
// The deadline is a stuck-condition backstop, not a bound on how long the work
// may legitimately take. It stays: a wait here can outlive a defect that
// produces no event at all, and the serving loop holds the event loop open
// through its lease-renew interval, so an unbounded wait would hang a run
// rather than fail it.

/**
 * Polls `predicate` every `pollMs` until it holds, and throws naming `label`
 * once `timeoutMs` has elapsed. A thunk `label` is rendered only on failure,
 * and an asynchronous `predicate` is awaited once per poll.
 */
export const waitUntil = async (
  predicate: () => boolean | Promise<boolean>,
  label: string | (() => string),
  timeoutMs = 20_000,
  pollMs = 20,
): Promise<void> => {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let polls = 0;
  for (;;) {
    polls += 1;
    if (await predicate()) return;
    if (Date.now() > deadline) {
      const rendered = typeof label === "function" ? label() : label;
      // The poll count separates two failures that read alike. A predicate
      // polled at the full rate that never came true names a defect in what
      // it watches; one polled a handful of times over the same span says the
      // event loop was starved and the test barely looked.
      throw new Error(
        `timed out waiting for ${rendered} after ${Date.now() - started} ms ` +
          `and ${polls} polls`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};
