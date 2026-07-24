export interface LLMClientRequestOptions {
  /** Full LLM endpoint URL for this call. */
  endpoint?: string | URL;
  /** Per-call transport. This alone never bypasses the test-environment guard. */
  fetch?: typeof globalThis.fetch;
}

const internalBrokerOptions = new WeakSet<LLMClientRequestOptions>();

/**
 * Mint the opaque options capability used by trusted in-process broker
 * plumbing. Authorization is tied to this exact frozen object identity: an
 * ordinary or copied `{ fetch }` object does not inherit it.
 */
export function createInternalLLMBrokerRequestOptions(
  options: Readonly<{
    endpoint?: string | URL;
    fetch: typeof globalThis.fetch;
  }>,
): LLMClientRequestOptions {
  const capability = Object.freeze({ ...options });
  internalBrokerOptions.add(capability);
  return capability;
}

export const isInternalLLMBrokerRequestOptions = (
  options: LLMClientRequestOptions | undefined,
): boolean => options !== undefined && internalBrokerOptions.has(options);
