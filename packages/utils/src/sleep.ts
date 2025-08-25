/**
 * Creates a promise that resolves after the specified timeout.
 * @param timeout - The number of milliseconds to wait
 * @returns A promise that resolves after the timeout
 */
export const sleep = (timeout: number) =>
  new Promise((resolve) => setTimeout(resolve, timeout));

/**
 * Receives an async predicate function to executed repeatedly
 * until either the predicate returns `true`, or throws once
 * the timeout limit has been reached.
 *
 * @param predicate - The predicate callback.
 * @param config.timeout - The number of milliseconds to wait before throwing. [60000]
 * @param config.delay - The number of milliseconds to wait between predicate calls. [500]
 */
export const waitFor = async (
  predicate: () => Promise<boolean>,
  { timeout: _timeout, delay: _delay }: { timeout?: number; delay?: number } =
    {},
): Promise<void> => {
  const timeout = _timeout ?? 60_000;
  const delay = _delay ?? 500;
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
