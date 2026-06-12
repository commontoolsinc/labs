/**
 * Ambient marker for "a runner Action (lift/handler invocation) is currently
 * executing user code" — the window in which minting NEW builder artifacts is
 * forbidden (identity E5, design Phase 4).
 *
 * Builder artifacts must be module-scope declarations: the builder-call-
 * hoisting transformer moves every authored builder call to module scope, the
 * SES verifier enforces that shape, and content-addressed identity
 * (`{ identity, symbol }`) only exists for module-scope artifacts. An
 * artifact minted inside a running action has no identity, no provenance, and
 * (closure-bearing) no serializable body — the legacy registry channel that
 * used to keep such values limping along is gone, so the mint now fails
 * loudly at creation time instead of producing a value that cannot be
 * rehydrated.
 *
 * Synchronous push/pop — action invocation never awaits while user code runs.
 */
let actionExecutionDepth = 0;

/** Enter the action-execution window. Returns the matching exit. */
export function enterActionExecution(): () => void {
  actionExecutionDepth++;
  return () => {
    actionExecutionDepth--;
  };
}

/**
 * Throw when called inside a running action: builder artifacts must be
 * defined at module level. Called by the lift/handler/pattern mint sites.
 */
export function assertNotInActionExecution(kind: string): void {
  if (actionExecutionDepth > 0) {
    throw new Error(
      `Cannot create a ${kind} inside a running action: define the ${kind} ` +
        `at module level. (If this code came from pattern source, this may ` +
        `be a transformer bug — the transformer is supposed to hoist all ` +
        `builder calls to module scope.)`,
    );
  }
}
