/**
 * The ambient control point for the `readerSchemaPrecedence` experimental
 * flag (`docs/development/EXPERIMENTAL_OPTIONS.md`): whether crossing a link
 * resolves the schema by reader precedence (`combineSchemaForLink` in
 * traverse.ts — the reader's schema stands as-is, the link's schema is
 * adopted only for true/empty readers) or by the legacy strict
 * pseudo-intersection (`combineSchema`).
 *
 * Ambient for the same reason as the content-addressed-schemas config: the
 * consumer is pure module code in traverse.ts with no runtime handle. The
 * flag is server-authoritative (`EXPERIMENTAL_FLAG_AUTHORITY`): a server
 * publishes its resolved posture at `/api/meta` and deployed clients adopt
 * it, because both sides must resolve hops under the same combine rule for
 * a subscription to ship what its reader selects.
 *
 * On by default. The rollback (an explicit `false`) is an OWNED
 * process-global claim rather than a stomped boolean, following the
 * server-execution enabler's lifecycle: each rollback-holding Runtime
 * acquires a disabler released on dispose — or by a throwing construction —
 * so a co-hosted default-arm runtime's dispose cannot lift a live rollback,
 * and a failed construction cannot leak one. Precedence is in effect only
 * while no disabler is live.
 */

let disablerCount = 0;
// Claims belong to a reset epoch: a release issued before a reset must not
// decrement the fresh epoch's count (to -1, hiding one future claim), so
// each claim captures the epoch it was acquired in and releases only there.
let claimEpoch = 0;

/**
 * Claims the rollback: the strict combine stays in effect process-wide
 * while any claim is live. Returns an idempotent release, inert after a
 * `resetReaderSchemaPrecedenceConfig()`.
 */
export function acquireReaderSchemaPrecedenceDisabler(): () => void {
  const epoch = claimEpoch;
  disablerCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (epoch === claimEpoch) disablerCount -= 1;
  };
}

/** The effective flag state: precedence unless a rollback claim is live. */
export function getReaderSchemaPrecedenceConfig(): boolean {
  return disablerCount === 0;
}

/**
 * Restores the flag to its default, abandoning live claims. Test cleanup
 * only — an abandoned claim's release becomes a no-op (the epoch moved on),
 * so a stale release can neither underflow the count nor un-claim a
 * rollback acquired after the reset.
 */
export function resetReaderSchemaPrecedenceConfig(): void {
  disablerCount = 0;
  claimEpoch += 1;
}
