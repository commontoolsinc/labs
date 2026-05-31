import type { VirtualModuleRecord } from "./esm-module-loader.ts";

/**
 * Structural pre-flight verification for a module-record graph (Phase 3 of
 * docs/specs/module-loading.md).
 *
 * This is the record-path analogue of the AMD bundle pre-flight
 * (`bundle-preflight.ts`): it validates the *shape and wiring* of the graph
 * before any module executes — every specifier is content-addressed, every
 * record is well-formed, and every resolved import points at a present record.
 *
 * NOTE: the deep SES_SANDBOXING module-item classification (direct callbacks to
 * trusted builders, safe top-level functions, verified module-safe data) is the
 * security-critical part of the verifier port and is NOT yet implemented here.
 * It must be ported from the AMD `define()` parser before the ESM loader can
 * run untrusted code by default. Until then the `esmModuleLoader` flag stays
 * off and the AMD verifier remains the enforcement path.
 */

const VALID_SPECIFIER = /^cf:(module|runtime)\//;

export class ModuleGraphVerificationError extends Error {
  override name = "ModuleGraphVerificationError";
}

export function verifyModuleGraph(
  records: Map<string, VirtualModuleRecord>,
  entrySpecifier: string,
): void {
  if (!records.has(entrySpecifier)) {
    throw new ModuleGraphVerificationError(
      `Module graph entry specifier is not present: ${entrySpecifier}`,
    );
  }

  for (const [specifier, record] of records) {
    if (!VALID_SPECIFIER.test(specifier)) {
      throw new ModuleGraphVerificationError(
        `Non-content-addressed module specifier: ${specifier}`,
      );
    }
    if (!Array.isArray(record.imports)) {
      throw new ModuleGraphVerificationError(
        `Record ${specifier} has a non-array imports list`,
      );
    }
    if (!Array.isArray(record.exports)) {
      throw new ModuleGraphVerificationError(
        `Record ${specifier} has a non-array exports list`,
      );
    }
    if (typeof record.execute !== "function") {
      throw new ModuleGraphVerificationError(
        `Record ${specifier} has a non-function execute`,
      );
    }
    for (const importSpecifier of record.imports) {
      const target = record.resolutions?.[importSpecifier] ?? importSpecifier;
      if (!records.has(target)) {
        throw new ModuleGraphVerificationError(
          `Record ${specifier} has an unresolved import "${importSpecifier}" -> "${target}"`,
        );
      }
    }
  }
}
