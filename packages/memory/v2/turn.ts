// Scheduling a callback onto a later turn of the event loop.
//
// Waking Deno's event loop for a zero-delay `setTimeout` takes about two
// milliseconds when that timer is the only thing pending, and the cost falls
// on each timer in a chain: 500 armed together cost about 8 microseconds
// each, 500 armed one after another about 2.3 milliseconds each. Both callers
// here arm theirs one after another — a frame at a time through the loopback
// transport, a fan-out at a time through the server's subscription refresh.

// `setImmediate` and `clearImmediate` where the host has them (Deno and Node);
// absent in a browser.
const immediates = globalThis as {
  setImmediate?: (handler: () => void) => unknown;
  clearImmediate?: (handle: unknown) => void;
};

/** A turn claimed by {@link armTurn}, until it runs or is cancelled. */
export type ArmedTurn = {
  /** Drops the claim. The handler does not run. */
  cancel(): void;
};

/**
 * Runs `handler` on a later turn of the event loop, once.
 *
 * A zero-delay claim is made two ways at once, and whichever arrives first
 * runs the handler and cancels the other. The timer is the claim every host
 * offers, and it is the claim a fake-clock test harness accounts for — the
 * runner's harness settles by looking for zero-delay timers that are armed
 * and have not yet run — so an outstanding turn is always an armed zero-delay
 * timer that something else can see. `setImmediate` is the same turn for
 * about a microsecond, so it carries the handler wherever it exists.
 *
 * A `delayMs` above zero asks for a real wait, and only the timer can give
 * one, so it is armed alone.
 */
export const armTurn = (
  handler: () => void,
  delayMs = 0,
): ArmedTurn => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let immediate: unknown = null;
  let taken = false;
  const cancel = () => {
    taken = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (immediate !== null) {
      immediates.clearImmediate?.(immediate);
      immediate = null;
    }
  };
  // Two claims are live, so the second has to find the turn already taken:
  // cancelling a claim does not everywhere guarantee it will not be called,
  // and a handler run twice would deliver two frames on one turn.
  const run = () => {
    if (taken) return;
    cancel();
    handler();
  };
  timer = setTimeout(run, delayMs);
  if (delayMs === 0) {
    immediate = immediates.setImmediate?.(run) ?? null;
  }
  return { cancel };
};
