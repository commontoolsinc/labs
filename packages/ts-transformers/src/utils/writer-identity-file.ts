/**
 * Canonical spelling of a module's source file inside CFC writer identities.
 *
 * This single normalizer feeds every surface that records or matches a
 * writer's source file, so the spellings cannot drift apart:
 * - `WriteAuthorizedBy` claim minting (schema-generator's
 *   `extractWriteAuthorizedByIdentity`),
 * - runtime provenance stamping (module-scope-function-hardening's baked
 *   `sourceFileName`),
 * - `PolicyOf` source matching (schema-generator's normalized fallback).
 *
 * The compiler sees file names exactly as the program resolver spelled them,
 * and resolvers disagree: `FileSystemProgramResolver` and
 * `HttpProgramResolver` emit `/`-prefixed root-relative names (fs-root vs
 * server-root), while piece manifests reach `StaticProgramResolver` with
 * bare-relative keys. Stripping the first segment of absolute names below
 * re-spells the same module differently across resolvers (labs#4772 /
 * CT-1886): the runner compares these spellings with exact equality, so a
 * claim minted under one resolver never corresponds to a live identity from
 * the other.
 *
 * Do not change the emitted spelling until the runner's claim↔identity
 * comparison is spelling-tolerant (anchored on `moduleIdentity`): stored
 * claims keep their mint-time spelling forever, so a spelling change alone
 * re-shears every aged store against the new live provenance.
 */
export function normalizeWriterIdentityFile(fileName: string): string {
  const normalized = fileName.replace(/\\/g, "/");
  return normalized.match(/^\/[^/]+(\/.+)$/)?.[1] ?? normalized;
}
