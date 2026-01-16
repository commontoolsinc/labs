/**
 * Creates a promise that resolves after the specified timeout.
 * @param timeout - The number of milliseconds to wait
 * @returns A promise that resolves after the timeout
 */
export const sleep = (timeout: number) =>
  new Promise((resolve) => setTimeout(resolve, timeout));

/**
 * Creates a promise that rejects after the specified timeout.
 * Useful for racing against long-running operations.
 * @param ms - The number of milliseconds before rejection
 * @param message - The error message for the rejection
 * @returns A promise that rejects after the timeout
 *
 * @example
 * ```ts
 * // Race a fetch against a 5-second timeout
 * const result = await Promise.race([
 *   fetch(url),
 *   timeout(5000, "Request timed out")
 * ]);
 * ```
 */
export const timeout = (ms: number, message: string): Promise<never> =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
