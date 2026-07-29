/**
 * Tier 1 of the pattern-update regime: prove that a pattern's current
 * argument/result contract can still be applied to every version of itself
 * that is, or was, deployed.
 *
 * Why this exists as a CI gate rather than a runtime check: `cf piece setsrc`
 * refuses an incompatible replacement (`PieceController.setPattern` calls
 * `assertPatternSchemasBackwardCompatible`), but the *automatic* updater does
 * not — `PatternUpdater` compiles, verifies the entry identity, and applies via
 * `runtime.setup`/`patternIdentity` with no structural comparison at all
 * (docs/specs/pattern-imports/pattern-updates.md, "The specialized system-source
 * updater does not perform the complete pre-apply structural comparison").
 * An incompatible schema that merges is therefore applied silently to every
 * running piece. CI is the only gate, so this reuses the exact function
 * `setsrc` enforces rather than reimplementing the rule.
 *
 * This module is the pure core: no compiling, no filesystem, no git. The task
 * shell (`pattern-compat.ts`) supplies the compiled contracts and the baseline
 * files it read off disk.
 */

import { type JSONSchema, type Pattern } from "@commonfabric/runner";
import { validateSchemaDefinition } from "@commonfabric/runner/cfc";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { assertPatternSchemasBackwardCompatible } from "../packages/piece/src/schema-compatibility.ts";

/**
 * The two schemas that constitute a pattern's update contract. Nothing else
 * about a pattern participates: `assertPatternSchemasBackwardCompatible` reads
 * exactly these four values across its two arguments, which is why a baseline
 * can be a small JSON file rather than a compiled artifact.
 */
export interface PatternContract {
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
}

/** A contract that is, or was, deployed. `label` is its filename stem. */
export interface Baseline {
  label: string;
  contract: PatternContract;
}

export type Finding =
  /** The current contract is not recorded, so nothing pins it for the next PR. */
  | { kind: "missing-baseline"; pattern: string; hash: string }
  /** The current contract cannot be applied over a deployed one. */
  | {
    kind: "incompatible";
    pattern: string;
    baseline: string;
    detail: string;
  }
  /** Baselines outlived their source: pieces tracking this path are pinned. */
  | { kind: "retired"; pattern: string; baselines: string[] };

/**
 * How much of the base64url SHA-256 goes in a filename. The hash only has to
 * be unique within one pattern's own directory, so 16 characters (96 bits) is
 * far past collision-relevant while keeping `<iso>-<hash>.json` readable.
 */
const HASH_LENGTH = 16;

/**
 * A stable content address for a contract. `hashStringOf` canonicalizes key
 * order (the same machinery `internSchema` hashes through), so a reordered but
 * structurally identical schema addresses to the same baseline instead of
 * minting a spurious one.
 */
export function contractHash(contract: PatternContract): string {
  return hashStringOf({
    argumentSchema: contract.argumentSchema,
    resultSchema: contract.resultSchema,
  }).slice(0, HASH_LENGTH);
}

/**
 * `assertPatternSchemasBackwardCompatible` takes two `Pattern`s but reads only
 * their `argumentSchema` and `resultSchema`. The remaining fields are filled
 * with empty values so a stored contract can be checked without recovering the
 * compiled artifact it came from.
 */
const asPattern = (contract: PatternContract): Pattern => ({
  argumentSchema: contract.argumentSchema,
  resultSchema: contract.resultSchema,
  derivedInternalCells: [],
  result: {},
  nodes: [],
});

/**
 * Check one pattern's current contract against every baseline recorded for it.
 *
 * Every baseline is checked, never just the newest. A piece rolls forward from
 * whatever version it last opened at, which may be many releases back, and the
 * evolution-policy allowances in the subset check are not guaranteed to
 * compose across steps — so proving compatibility with N-1 does not prove it
 * with N-5. Checking all of them makes the question moot.
 *
 * `current` is `undefined` when baselines exist for a path that no longer
 * compiles to a pattern.
 */
export function checkPattern(
  pattern: string,
  current: PatternContract | undefined,
  baselines: readonly Baseline[],
): Finding[] {
  if (current === undefined) {
    if (baselines.length === 0) return [];
    return [{
      kind: "retired",
      pattern,
      baselines: baselines.map((baseline) => baseline.label),
    }];
  }

  const findings: Finding[] = [];
  const hash = contractHash(current);
  const recorded = baselines.some((baseline) =>
    contractHash(baseline.contract) === hash
  );

  // An already-recorded contract is unchanged since the run that recorded it,
  // and it was validated and proved then. Re-doing that work every CI run is
  // pure waste, and it is not cheap: both the definition validator and the
  // subset proof blow up combinatorially on some real schemas (validating
  // lobby/main.tsx's schemas alone takes ~55s). Steady state — no contract
  // changed in this PR — therefore costs nothing beyond the compile.
  if (!recorded) {
    findings.push({ kind: "missing-baseline", pattern, hash });
    for (
      const [role, schema] of [
        ["argument", current.argumentSchema],
        ["result", current.resultSchema],
      ] as const
    ) {
      const issue = validateSchemaDefinition(schema);
      if (issue !== undefined) {
        findings.push({
          kind: "incompatible",
          pattern,
          baseline: "(current)",
          detail: `${role} schema is invalid: ${issue}`,
        });
      }
    }
  }

  const candidate = asPattern(current);
  for (const baseline of baselines) {
    // An identical contract needs no proof: "can C be applied over C" is
    // trivially yes.
    if (contractHash(baseline.contract) === hash) continue;
    try {
      assertPatternSchemasBackwardCompatible(
        asPattern(baseline.contract),
        candidate,
      );
    } catch (error) {
      findings.push({
        kind: "incompatible",
        pattern,
        baseline: baseline.label,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return findings;
}
