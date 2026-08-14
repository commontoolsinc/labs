import * as path from "@std/path";

/**
 * Sidecar record of the test run that filled a coverage profile directory.
 *
 * `deno coverage` and the lcov writer treat everything inside a profile
 * directory as V8 output, so the manifest lives BESIDE the directory
 * (`<dir>.manifest.json`), never in it.
 *
 * Why it exists: the workspace test runner stops launching packages after
 * the first failure, and the coverage-debt metric scores unmeasured code as
 * fully uncovered. A profile from a run that failed or never finished
 * therefore produces numbers that look far worse than reality, and nothing
 * in the profile itself says so. The manifest is that missing signal:
 * written as incomplete when the run starts, rewritten with the outcome
 * when it ends, so a crash leaves the incomplete record behind.
 */
export interface CoverageRunManifest {
  /** False until the run's final rewrite; a crash leaves it false. */
  readonly complete: boolean;
  readonly success: boolean;
  readonly unitsPlanned: number;
  readonly unitsCompleted: number;
  readonly failedPackages: readonly string[];
}

/** `<dir>.manifest.json`, tolerating a trailing separator on `dir`. */
export function coverageRunManifestPath(coverageDir: string): string {
  const normalized = coverageDir.replace(
    new RegExp(`[${path.SEPARATOR === "\\" ? "\\\\" : path.SEPARATOR}]+$`),
    "",
  );
  return `${normalized}.manifest.json`;
}

export async function writeCoverageRunManifest(
  coverageDir: string,
  manifest: CoverageRunManifest,
): Promise<void> {
  await Deno.writeTextFile(
    coverageRunManifestPath(coverageDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

/** Undefined when the manifest is absent or unreadable. */
export async function readCoverageRunManifest(
  coverageDir: string,
): Promise<CoverageRunManifest | undefined> {
  let text: string;
  try {
    text = await Deno.readTextFile(coverageRunManifestPath(coverageDir));
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as CoverageRunManifest;
    return typeof parsed.complete === "boolean" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export type ManifestAssessment =
  | { readonly level: "ok" }
  | { readonly level: "warn"; readonly message: string }
  | { readonly level: "refuse"; readonly message: string };

const SINGLE_PACKAGE_TIP =
  "To measure a single package instead: cd packages/<name> && " +
  "DENO_COVERAGE_DIR=<dir> deno task test, and compare that group's " +
  "number before and after your change.";

/**
 * Decide whether a profile directory's numbers can be trusted. Refusal is
 * for a run known bad (failed or never finished); the warning is for
 * profiles written before manifests existed, where nothing records whether
 * the run completed.
 */
export function assessCoverageRunManifest(
  manifest: CoverageRunManifest | undefined,
): ManifestAssessment {
  if (manifest === undefined) {
    return {
      level: "warn",
      message: "No run manifest was found beside the profile directory, so " +
        "there is no record of whether the test run finished. If any " +
        "package failed or the run was interrupted, packages that never " +
        "ran score as fully uncovered and every number here inflates.",
    };
  }
  if (!manifest.complete) {
    return {
      level: "refuse",
      message: "The test run that wrote this profile never finished " +
        `(${manifest.unitsCompleted} of ${manifest.unitsPlanned} package ` +
        "runs completed). Packages that never ran score as fully " +
        "uncovered, so these numbers are not usable. Re-run the tests to " +
        `completion. ${SINGLE_PACKAGE_TIP}`,
    };
  }
  if (!manifest.success) {
    return {
      level: "refuse",
      message: "The test run that wrote this profile failed " +
        `(failed: ${manifest.failedPackages.join(", ")}; ` +
        `${manifest.unitsCompleted} of ${manifest.unitsPlanned} package ` +
        "runs completed — the runner stops launching packages after a " +
        "failure). Packages that never ran score as fully uncovered, so " +
        "these numbers are not usable. Fix the failing package and re-run. " +
        SINGLE_PACKAGE_TIP,
    };
  }
  return { level: "ok" };
}
