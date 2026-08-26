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
 * Runtime propagates its experimental option here and reads the effective
 * state back. Runtime-local only — nothing about the flag is negotiated or
 * carried on the wire; each process resolves its own hops. On by default;
 * an explicit `false` is the rollback override.
 */

let readerSchemaPrecedence = true;

/**
 * Sets the flag; `undefined` keeps the current state (the built-in default
 * is on).
 */
export function setReaderSchemaPrecedenceConfig(
  enabled: boolean | undefined,
): void {
  if (enabled !== undefined) readerSchemaPrecedence = enabled;
}

/** The effective flag state. */
export function getReaderSchemaPrecedenceConfig(): boolean {
  return readerSchemaPrecedence;
}

/** Restores the flag to its default. */
export function resetReaderSchemaPrecedenceConfig(): void {
  readerSchemaPrecedence = true;
}
