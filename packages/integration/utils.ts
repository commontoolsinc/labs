import { sleep } from "@commonfabric/utils/sleep";

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
