/**
 * The transformer↔runtime contract surface that the RUNTIME needs at boot:
 * values the runner reads while evaluating already-compiled patterns, with no
 * compilation in sight. This module must stay free of `typescript` (and other
 * compiler-stack) value imports — the runtime worker imports it eagerly, and a
 * value edge here would pull the whole compiler into every worker spawn (see
 * the runner's compiler-stack module).
 */

/**
 * Name of the sandbox global the pattern-coverage transformer emits probe
 * calls against; the engine installs a collector under this name when
 * coverage is enabled.
 */
export const PATTERN_COVERAGE_GLOBAL = "__cfPatternCoverage";

/** Portable compiler output; trusted ingestion performs the semantic checks. */
export interface CfcPolicyCompilerManifestV1 {
  readonly policyDigest: string;
  readonly manifest: {
    readonly formatVersion: 1;
    readonly moduleIdentity: string;
    readonly symbol: string;
    readonly template: {
      readonly templateVersion: 1;
      readonly exchangeRules: readonly unknown[];
      readonly dependencies: {
        readonly authorityOnly: readonly string[];
        readonly dataBearing: readonly string[];
      };
      readonly integrityRequirements: Readonly<Record<string, unknown>>;
    };
  };
}

/** Index of the first non-blank line, or null for an all-blank source. */
export function findFirstContentLineIndex(
  lines: readonly string[],
): number | null {
  for (const [index, line] of lines.entries()) {
    if (line.trim().length > 0) {
      return index;
    }
  }
  return null;
}
