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

// A `/// <cf-disable-transform />` directive is honored only at column zero.
// This is intentional and mirrors TypeScript's own triple-slash directives
// (`/// <reference ... />`), which are likewise recognized only at the very
// start of a line, ahead of any statement. Leading blank lines before the
// directive are fine — `findFirstContentLineIndex` skips them — but leading
// whitespace *on* the directive line is not: an indented directive is ignored
// and the file transforms normally (see `sourceHasIgnoredDisableDirective`).
const CF_DISABLE_TRANSFORM_DIRECTIVE_RE =
  /^\/\/\/\s*<cf-disable-transform\s*\/>/m;

/**
 * True when the source's first content line is the disable directive at column
 * zero — see {@link CF_DISABLE_TRANSFORM_DIRECTIVE_RE} for why column zero is
 * required. Read on the runtime boot path, so it stays a cheap string scan.
 */
export function sourceDisablesCfTransform(source: string): boolean {
  const lines = source.split("\n");
  const firstContentLineIndex = findFirstContentLineIndex(lines);
  return firstContentLineIndex !== null &&
    isCFTransformDisabled(lines[firstContentLineIndex]!);
}

/**
 * True when the source's first content line is an *indented* disable directive:
 * a `/// <cf-disable-transform />` that would disable the transform but for its
 * leading whitespace, so it is silently ignored under the column-zero rule.
 * A compile-time caller can use this to warn the author instead of transforming
 * a file they meant to opt out. The runtime boot path never needs it —
 * {@link sourceDisablesCfTransform} alone decides behavior.
 */
export function sourceHasIgnoredDisableDirective(source: string): boolean {
  const lines = source.split("\n");
  const firstContentLineIndex = findFirstContentLineIndex(lines);
  if (firstContentLineIndex === null) return false;
  const line = lines[firstContentLineIndex]!;
  return !isCFTransformDisabled(line) &&
    isCFTransformDisabled(line.trimStart());
}

function isCFTransformDisabled(line: string) {
  return CF_DISABLE_TRANSFORM_DIRECTIVE_RE.test(line);
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
