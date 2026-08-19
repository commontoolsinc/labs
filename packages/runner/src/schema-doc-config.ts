/**
 * The ambient control point for the `contentAddressedSchemas` experimental
 * flag (`docs/development/EXPERIMENTAL_OPTIONS.md`): whether link writers
 * replace inline schemas with references to content-addressed schema
 * documents (`docs/specs/content-addressed-schemas.md`, Phase 1).
 *
 * Ambient for the same reason as the modern-cell-rep config: the writer
 * (`createSigilLinkFromParsedLink` in link-utils.ts) is pure module code
 * with no runtime handle. The Runtime propagates its experimental option
 * here and reads the effective state back. Readers are NOT gated — they
 * accept both forms unconditionally, so old data keeps reading whatever
 * the flag does. The rollout itself is one-way: the flag turns on only
 * once every deployed client is a reader, and references written under it
 * persist, so turning it back off stops emission without un-writing
 * anything.
 */

let contentAddressedSchemas = false;

/**
 * Sets the flag; `undefined` keeps the current state (the built-in default
 * is off).
 */
export function setContentAddressedSchemasConfig(
  enabled: boolean | undefined,
): void {
  if (enabled !== undefined) contentAddressedSchemas = enabled;
}

/** The effective flag state. */
export function getContentAddressedSchemasConfig(): boolean {
  return contentAddressedSchemas;
}
