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
 *
 * This file is the shell — roots, argument parsing, printing, exit code. The
 * work is in `pattern-vintage-run.ts`, which takes its roots as arguments so
 * the gate can be proved to FAIL against a deliberately broken pattern
 * (`pattern-vintage-run.test.ts`).
 */

import { fromFileUrl } from "@std/path/from-file-url";
import { Identity } from "@commonfabric/identity";
import {
  DEFAULT_APP_PATTERN_URL,
  HOME_PATTERN_URL,
} from "../packages/piece/src/system-pattern-url.ts";
import {
  collectVintages,
  isClean,
  relativeToRepo,
  reportFailures,
  reportUncovered,
  requiredPatternKeys,
  uncoveredRequiredPatterns,
  VINTAGES_DIR,
} from "./pattern-vintage-lib.ts";
import {
  captureMissing,
  type GateRoots,
  replayAll,
} from "./pattern-vintage-run.ts";

const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url)).replace(
  /\/$/,
  "",
);

/**
 * One fixed identity for every capture and replay.
 *
 * A vintage restores under whichever DID the replaying runtime uses, so a
 * deterministic signer keeps a fixture addressable across machines and runs.
 * (Measured: a cross-DID restore reads correctly anyway — the space is
 * whichever file the server opens — so this is reproducibility, not
 * correctness. A label lowering `CurrentPrincipal` would make it correctness
 * too.)
 */
const FIXTURE_SIGNER = await Identity.fromPassphrase("pattern vintage fixture");

async function main() {
  const roots: GateRoots = {
    // Absolute, so the task behaves the same whatever directory it is invoked
    // from — the workspace runner does not run it from the repo root.
    repoRoot: REPO_ROOT,
    patternsRoot: `${REPO_ROOT}/packages/patterns`,
    vintagesRoot: `${REPO_ROOT}/${VINTAGES_DIR}`,
    signer: FIXTURE_SIGNER,
  };
  // The required set comes from the runtime's OWN constants, so the gate
  // cannot drift from what actually auto-updates.
  const required = requiredPatternKeys([
    HOME_PATTERN_URL,
    DEFAULT_APP_PATTERN_URL,
  ]);

  if (Deno.args.includes("--update")) {
    const { captured, problems } = await captureMissing(
      roots,
      required,
      new Date(),
    );
    if (captured.length === 0 && problems.length === 0) {
      console.log("Every auto-updating pattern already has a pinned vintage.");
    }
    for (const path of captured) {
      console.log(`  + ${relativeToRepo(path, REPO_ROOT)}`);
    }
    if (problems.length > 0) {
      console.error(`\n${problems.length} vintage(s) could not be captured:`);
      for (const problem of problems) console.error(problem);
      Deno.exit(1);
    }
    return;
  }

  const { replayed, failures } = await replayAll(roots);
  const uncovered = uncoveredRequiredPatterns(
    required,
    await collectVintages(roots.vintagesRoot),
  );

  if (uncovered.length > 0) console.error(reportUncovered(uncovered));
  if (failures.length > 0) console.error(`\n${reportFailures(failures)}`);

  if (!isClean(failures, uncovered)) Deno.exit(1);
  console.log(
    `Replayed ${replayed} vintage(s) under today's source; all readable.`,
  );
}

if (import.meta.main) {
  await main();
}
