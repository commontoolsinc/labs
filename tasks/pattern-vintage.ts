#!/usr/bin/env -S deno run -A
/**
 * Tier 2's gate: replay every pinned vintage under TODAY's pattern source.
 *
 * Tier 1 (`deno task pattern-compat`) proves the contract a pattern declares is
 * still compatible with every contract it has declared before. That is a
 * statement about schemas. This proves the stronger thing schemas cannot say:
 * that a real document written by an older version is still readable — and
 * still materializable — by the version about to be merged.
 *
 *   deno task pattern-vintage             # replay; fail on a stranded fixture
 *   deno task pattern-vintage --update    # capture a vintage where one is missing
 *
 * `--update` can only ADD. It never rewrites or deletes an existing fixture,
 * for the reason Tier 1's baselines are append-only: a command that could
 * replace a vintage could replace the very vintage that would have caught a
 * break. Deleting one is a deliberate act that shows up in review as a deleted
 * file.
 */

import { fromFileUrl } from "@std/path/from-file-url";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { Identity } from "@commonfabric/identity";
import {
  DEFAULT_APP_PATTERN_URL,
  HOME_PATTERN_URL,
} from "../packages/piece/src/system-pattern-url.ts";
import {
  collectVintages,
  describeError,
  isClean,
  PINNED,
  relativeToRepo,
  type ReplayFailure,
  reportFailures,
  reportUncovered,
  requiredPatternKeys,
  stampFor,
  uncoveredRequiredPatterns,
  vintageDir,
  vintageFileName,
  type VintageRef,
  VINTAGES_DIR,
} from "./pattern-vintage-lib.ts";
import {
  materializeOver,
  openFileBackedRuntime,
} from "../packages/piece/test/state-continuity-harness.ts";

const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url)).replace(
  /\/$/,
  "",
);
const PATTERNS_ROOT = `${REPO_ROOT}/packages/patterns`;
const VINTAGES_ROOT = `${REPO_ROOT}/${VINTAGES_DIR}`;

/**
 * One fixed identity for every capture and replay.
 *
 * A vintage restores under whichever DID the replaying runtime uses, and the
 * capture path encodes that DID, so a deterministic signer keeps a fixture
 * addressable across machines and runs. (Measured: a cross-DID restore reads
 * correctly anyway — the space is whichever file the server opens — so this is
 * reproducibility, not correctness. A label lowering `CurrentPrincipal` would
 * make it correctness too.)
 */
const FIXTURE_SIGNER = await Identity.fromPassphrase("pattern vintage fixture");

async function withRuntime<T>(
  fromSnapshot: string | undefined,
  run: (
    vintage: Awaited<ReturnType<typeof openFileBackedRuntime>>,
  ) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "pattern-vintage-" });
  const vintage = await openFileBackedRuntime(
    FIXTURE_SIGNER,
    dir,
    fromSnapshot,
  );
  try {
    return await run(vintage);
  } finally {
    await vintage.dispose().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function resolveProgram(key: string) {
  return new FileSystemProgramResolver(`${PATTERNS_ROOT}/${key}`, REPO_ROOT);
}

/** Replay one fixture under today's source. Returns a failure, or undefined. */
async function replay(
  vintage: VintageRef,
): Promise<ReplayFailure | undefined> {
  const snapshot = vintage.path;
  return await withRuntime(snapshot, async (runtimeVintage) => {
    let program;
    try {
      program = await runtimeVintage.runtime.harness.resolve(
        resolveProgram(vintage.patternKey),
      );
    } catch (error) {
      return {
        ...where(vintage),
        detail: `today's source does not resolve: ${describeError(error)}`,
      };
    }
    const outcome = await materializeOver(runtimeVintage, program as never);
    if (outcome.error !== undefined) {
      return {
        ...where(vintage),
        detail:
          `materializing today's source over this vintage was REFUSED:\n      ${outcome.error}`,
      };
    }
    if (outcome.value === undefined) {
      return {
        ...where(vintage),
        detail:
          "materialized, but the root reads as undefined — the vintage's state is gone",
      };
    }
    return undefined;
  });
}

/** Capture a vintage for `key` from today's source. Returns its path. */
async function capture(key: string): Promise<string> {
  return await withRuntime(undefined, async (runtimeVintage) => {
    const program = await runtimeVintage.runtime.harness.resolve(
      resolveProgram(key),
    );
    const outcome = await materializeOver(runtimeVintage, program as never);
    if (outcome.error !== undefined) {
      throw new Error(
        `cannot capture ${key}: its own setup was refused: ${outcome.error}`,
      );
    }
    const identity = outcome.identity;
    if (identity === undefined) {
      throw new Error(
        `cannot capture ${key}: compiled pattern has no identity`,
      );
    }
    const dir = `${REPO_ROOT}/${vintageDir(key, PINNED)}`;
    await Deno.mkdir(dir, { recursive: true });
    const name = vintageFileName(stampFor(new Date()), identity);
    await runtimeVintage.snapshot(`${dir}/${name}`);
    return `${vintageDir(key, PINNED)}/${name}`; // repo-relative, for output
  });
}

/** The reportable location of a fixture. */
function where(vintage: VintageRef): { patternKey: string; path: string } {
  return {
    patternKey: vintage.patternKey,
    path: relativeToRepo(vintage.path, REPO_ROOT),
  };
}

async function main() {
  const update = Deno.args.includes("--update");
  // The required set comes from the runtime's OWN constants, so the gate
  // cannot drift from what actually auto-updates.
  const required = requiredPatternKeys([
    HOME_PATTERN_URL,
    DEFAULT_APP_PATTERN_URL,
  ]);
  // Absolute, so the task behaves the same whatever directory it is invoked
  // from — the workspace runner does not run it from the repo root.
  const existing = await collectVintages(VINTAGES_ROOT);
  const uncovered = uncoveredRequiredPatterns(required, existing);

  if (update) {
    if (uncovered.length === 0) {
      console.log("Every system pattern already has a pinned vintage.");
      return;
    }
    console.log(`Capturing ${uncovered.length} missing vintage(s).`);
    const problems: string[] = [];
    for (const key of uncovered) {
      try {
        console.log(`  + ${await capture(key)}`);
      } catch (error) {
        // Report every failure rather than dying on the first: a run that
        // captures 9 of 10 and then throws leaves the tree half-seeded with no
        // statement about which one is the problem.
        problems.push(`  ${key}: ${describeError(error)}`);
      }
    }
    if (problems.length > 0) {
      console.error(`\n${problems.length} vintage(s) could not be captured:`);
      for (const problem of problems) console.error(problem);
      Deno.exit(1);
    }
    return;
  }

  const failures: ReplayFailure[] = [];
  for (const vintage of existing) {
    const failure = await replay(vintage);
    if (failure !== undefined) failures.push(failure);
  }

  if (uncovered.length > 0) console.error(reportUncovered(uncovered));
  if (failures.length > 0) console.error(`\n${reportFailures(failures)}`);

  if (!isClean(failures, uncovered)) Deno.exit(1);
  console.log(
    `Replayed ${existing.length} vintage(s) under today's source; all readable.`,
  );
}

if (import.meta.main) {
  await main();
}
