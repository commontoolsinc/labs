/**
 * Creates a promise that resolves after the specified timeout.
 * @param timeout - The number of milliseconds to wait
 * @returns A promise that resolves after the timeout
 */
export const sleep = (timeout: number) =>
  new Promise((resolve) => setTimeout(resolve, timeout));
