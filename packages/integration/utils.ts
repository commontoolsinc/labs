import { sleep } from "@commonfabric/utils/sleep";
import type { Page } from "./page.ts";

// Default poll interval between predicate calls. Polls are cheap (a CDP
// evaluate round-trip), and a coarse interval quantizes every wall-clock
// measurement taken around a waitFor up to its multiple — the old 500ms
// default made the default-app timing series report ~520ms for phases whose
// real latency was far lower. Override per run with CF_WAITFOR_DELAY_MS.
const DEFAULT_DELAY_MS = (() => {
  try {
    const raw = Number(Deno.env.get("CF_WAITFOR_DELAY_MS"));
    return Number.isFinite(raw) && raw > 0 ? raw : 50;
  } catch {
    return 50;
  }
})();

/**
 * Receives an async predicate function to executed repeatedly
 * until either the predicate returns `true`, or throws once
 * the timeout limit has been reached.
 *
 * @param predicate - The predicate callback.
 * @param config.timeout - The number of milliseconds to wait before throwing. [60000]
 * @param config.delay - The number of milliseconds to wait between predicate
 *   calls. [50, or CF_WAITFOR_DELAY_MS]
 */
export const waitFor = async (
  predicate: () => Promise<boolean>,
  { timeout: _timeout, delay: _delay }: { timeout?: number; delay?: number } =
    {},
): Promise<void> => {
  const timeout = _timeout ?? 60_000;
  const delay = _delay ?? DEFAULT_DELAY_MS;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await predicate())) {
      return;
    }
    await sleep(delay);
  }
  throw new Error(
    `Timeout: waitFor predicate could not complete after ${timeout}ms.`,
  );
};

/**
 * Wait until the shell's rendered UI has caught up to runtime state and is
 * interactive. The reactive scheduler runs in a worker while the DOM lives on
 * the main thread, so there are three stages between a state change and a
 * clickable control: the worker settles reactively, the resulting vdom batch
 * crosses to the main thread and is applied, and the Lit elements finish their
 * update cycle (which is when cf-modal binds handlers and drops
 * `pointer-events:none`). This resolves once all three have happened.
 *
 * Returns true once settled, or false when the shell has not yet exposed
 * `commonfabric.viewSettled` (for example the runtime is still starting), so a
 * caller can keep polling with `waitFor`.
 *
 * Call this before issuing a click or keystroke after navigation or any state
 * change, so the stimulus lands on a bound handler instead of a freshly
 * rendered element whose handler is not wired up yet.
 */
export const awaitViewSettled = async (page: Page): Promise<boolean> => {
  return await page.evaluate(async () => {
    const settled = (globalThis as {
      commonfabric?: { viewSettled?: () => Promise<void> };
    }).commonfabric?.viewSettled;
    if (!settled) return false;
    await settled();
    return true;
  });
};
