/**
 * The capability gate for the raw `Date`/`Math` intrinsics inside pattern
 * compartments (W6).
 *
 * `sandboxDateNow`/`sandboxRandom` back the gated `Date`/`Math.random` injected
 * into pattern compartments, so authored `new Date()` / `Date.now()` /
 * `Math.random()` become the safe API. They enforce the time/entropy capability
 * boundary by reading the lift-vs-handler context from the active frame: a
 * lift/computed (pure) context cannot read a clock or entropy at all (it would be
 * a fine reactive time source and would break idempotency), while a handler gets
 * a coarse, one-second-resolution clock and pass-through entropy. The ambient
 * intrinsics never expose a fine clock or raw entropy to the sandbox: they yield
 * a coarse value only inside a handler, and throw in every other context
 * (lift/pattern-body or no frame). `new Date(arg)` is deterministic and is left
 * untouched at the injection site. See
 * docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md (W1/W6).
 */

import { getTopFrame } from "./pattern.ts";

const ONE_SECOND_MS = 1000;

class TimeCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeCapabilityError";
  }
}

export function sandboxDateNow(): number {
  const frame = getTopFrame();
  if (frame?.inHandler === true) {
    return Math.floor(Date.now() / ONE_SECOND_MS) * ONE_SECOND_MS;
  }
  throw new TimeCapabilityError(
    "The ambient clock (Date.now() / new Date()) is not available in this " +
      "context. Read it inside a handler (it is coarsened to one second), or " +
      'for reactive display read the #now clock (wish({ query: "#now" }) or ' +
      "#now/N). Formatting a known timestamp with new Date(ms) is unaffected.",
  );
}

export function sandboxRandom(): number {
  const frame = getTopFrame();
  if (frame?.inHandler === true) {
    return Math.random();
  }
  throw new TimeCapabilityError(
    "Ambient randomness (Math.random()) is not available in this context: it " +
      "makes reactive computation non-idempotent. Use it inside a handler, or " +
      "precompute the value.",
  );
}

/**
 * The capability check for the sandbox `fetch` (channel 7). A network request
 * may only be started from a handler: in a lift/computed or the pattern body a
 * request would be both a non-idempotent side effect and — through its
 * settlement — a clock. The settlement itself is coarsened at the injection
 * site (see createGatedFetch in sandbox/compartment-globals.ts).
 */
export function sandboxFetchGate(): void {
  const frame = getTopFrame();
  if (frame?.inHandler === true) return;
  throw new TimeCapabilityError(
    "fetch() is not available in this context. Start network requests from a " +
      "handler; for reactive data reads use the fetchData/fetchText/fetchJson " +
      "builtins at pattern-body level.",
  );
}
