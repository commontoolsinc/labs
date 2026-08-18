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
 * accept both link forms unconditionally, which is what makes the flag safe
 * to flip either way.
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

/**
 * The ambient control point for the `contentAddressedSelectorSchemas`
 * experimental flag (`docs/development/EXPERIMENTAL_OPTIONS.md`): whether
 * watch and sync selectors replace inline schemas with references to
 * content-addressed schema documents
 * (`docs/specs/content-addressed-schemas.md`, Phase 2). Same ambient shape
 * as the link-writer flag above, and gated the same way: emission only —
 * the server resolves both selector forms unconditionally.
 */

let contentAddressedSelectorSchemas = false;

/**
 * Sets the selector flag; `undefined` keeps the current state (the
 * built-in default is off).
 */
export function setContentAddressedSelectorSchemasConfig(
  enabled: boolean | undefined,
): void {
  if (enabled !== undefined) contentAddressedSelectorSchemas = enabled;
}

/** The effective selector-flag state. */
export function getContentAddressedSelectorSchemasConfig(): boolean {
  return contentAddressedSelectorSchemas;
}
