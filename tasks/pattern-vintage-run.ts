/**
 * The vintage gate's actual work: capture a missing vintage, replay every
 * vintage that exists.
 *
 * Split from `pattern-vintage.ts` so it takes its roots as arguments instead
 * of deriving them from `import.meta.url`. That is what makes the gate
 * testable against a temp tree holding a throwaway pattern — and the test
 * that buys is the one that matters: break a pattern on purpose and prove the
 * gate goes red. Verifying that by hand on every change is exactly the check
 * that stops happening.
 *
 * The shell (`pattern-vintage.ts`) keeps only argument parsing and printing.
 */

import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import type { Identity } from "@commonfabric/identity";
import {
  collectVintages,
  describeError,
  PINNED,
  relativeToRepo,
  type ReplayFailure,
  stampFor,
  uncoveredRequiredPatterns,
  vintageFileName,
  type VintageRef,
} from "./pattern-vintage-lib.ts";
import {
  materializeOver,
  openFileBackedRuntime,
  vintageStoredIdentity,
} from "../packages/piece/test/state-continuity-harness.ts";

export interface GateRoots {
  /** Repo root, used only to shorten paths in reports. */
  repoRoot: string;
  /** Directory pattern keys are resolved against. */
  patternsRoot: string;
  /** Directory fixtures live under. */
  vintagesRoot: string;
  /** Signer every capture and replay runs as. */
  signer: Identity;
}

async function withRuntime<T>(
  roots: GateRoots,
  fromSnapshot: string | undefined,
  run: (
    vintage: Awaited<ReturnType<typeof openFileBackedRuntime>>,
  ) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "pattern-vintage-" });
  // `openFileBackedRuntime` is INSIDE the try: opening a corrupt fixture is a
  // way it throws, and leaving the open outside would leak the temp copy of
  // every fixture that failed to open — 3.5 MiB a time.
  let vintage: Awaited<ReturnType<typeof openFileBackedRuntime>> | undefined;
  try {
    vintage = await openFileBackedRuntime(roots.signer, dir, fromSnapshot);
    return await run(vintage);
  } finally {
    await vintage?.dispose().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function resolver(roots: GateRoots, patternKey: string) {
  return new FileSystemProgramResolver(
    `${roots.patternsRoot}/${patternKey}`,
    roots.repoRoot,
  );
}

/** Replay one fixture under today's source. Returns a failure, or undefined. */
export async function replayVintage(
  roots: GateRoots,
  vintage: VintageRef,
): Promise<ReplayFailure | undefined> {
  const where = {
    patternKey: vintage.patternKey,
    path: relativeToRepo(vintage.path, roots.repoRoot),
  };
  return await withRuntime(roots, vintage.path, async (runtimeVintage) => {
    // The control, before anything is applied. A fixture that did not restore
    // presents as a fresh empty space, and today's source materializes onto a
    // fresh empty space just fine — so without this, "green" and "the fixture
    // was never there" are the same reading. Checking it against the identity
    // in the FILENAME does double duty: it also proves that name is provenance
    // rather than decoration.
    const stored = await vintageStoredIdentity(runtimeVintage);
    if (stored !== vintage.identity) {
      return {
        ...where,
        detail: stored === undefined
          ? "this fixture holds no captured root — it did not restore, so replaying it would prove nothing"
          : `this fixture's root was written by ${stored}, but its name records ${vintage.identity}`,
      };
    }
    let program;
    try {
      program = await runtimeVintage.runtime.harness.resolve(
        resolver(roots, vintage.patternKey),
      );
    } catch (error) {
      return {
        ...where,
        detail: `today's source does not resolve: ${describeError(error)}`,
      };
    }
    const outcome = await materializeOver(runtimeVintage, program as never);
    if (outcome.error !== undefined) {
      return {
        ...where,
        detail:
          `materializing today's source over this vintage was REFUSED:\n      ${outcome.error}`,
      };
    }
    if (outcome.value === undefined) {
      return {
        ...where,
        detail:
          "materialized, but the root reads as undefined — the vintage's state is gone",
      };
    }
    return undefined;
  });
}

/**
 * Replay every fixture under `vintagesRoot`.
 *
 * Hands the enumeration back so the coverage check reads the SAME list rather
 * than walking the tree a second time. Two walks would be two answers to one
 * question, and the pair "replayed nothing" / "everything is covered" is
 * exactly the disagreement that reads as a pass.
 */
export async function replayAll(
  roots: GateRoots,
): Promise<{
  vintages: VintageRef[];
  replayed: number;
  failures: ReplayFailure[];
}> {
  const vintages = await collectVintages(roots.vintagesRoot);
  const failures: ReplayFailure[] = [];
  for (const vintage of vintages) {
    const failure = await replayVintage(roots, vintage);
    if (failure !== undefined) failures.push(failure);
  }
  return { vintages, replayed: vintages.length, failures };
}

/** Capture a vintage for `patternKey` from today's source. */
export async function captureVintage(
  roots: GateRoots,
  patternKey: string,
  now: Date,
): Promise<string> {
  return await withRuntime(roots, undefined, async (runtimeVintage) => {
    const program = await runtimeVintage.runtime.harness.resolve(
      resolver(roots, patternKey),
    );
    const outcome = await materializeOver(runtimeVintage, program as never);
    if (outcome.error !== undefined) {
      throw new Error(
        `cannot capture ${patternKey}: its own setup was refused: ${outcome.error}`,
      );
    }
    const dir = `${roots.vintagesRoot}/${patternKey}/${PINNED}`;
    await Deno.mkdir(dir, { recursive: true });
    const name = vintageFileName(stampFor(now), outcome.identity);
    const path = `${dir}/${name}`;
    await runtimeVintage.snapshot(path);
    return path;
  });
}

/** Capture a vintage for every required pattern that has none. */
export async function captureMissing(
  roots: GateRoots,
  requiredKeys: readonly string[],
  now: Date,
): Promise<{ captured: string[]; problems: string[] }> {
  const existing = await collectVintages(roots.vintagesRoot);
  const missing = uncoveredRequiredPatterns(requiredKeys, existing);
  const captured: string[] = [];
  const problems: string[] = [];
  for (const key of missing) {
    try {
      captured.push(await captureVintage(roots, key, now));
    } catch (error) {
      // Report every failure rather than dying on the first: a run that
      // captures 9 of 10 and then throws leaves the tree half-seeded with no
      // statement about which one is the problem.
      problems.push(`  ${key}: ${describeError(error)}`);
    }
  }
  return { captured, problems };
}
