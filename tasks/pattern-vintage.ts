#!/usr/bin/env -S deno run -A
/**
 * Tier 2's gate: replay every pinned vintage under TODAY's pattern source.
 *
 * Tier 1 (`deno task pattern-compat`) proves the contract a pattern declares is
 * still compatible with every contract it has declared before. That is a
 * statement about schemas. This proves the stronger thing schemas cannot say:
 * that a real document written by an older version is still materializable by
 * the version about to be merged.
 *
 * Precisely what a green run asserts, per fixture: today's source RESOLVES for
 * every recorded instantiation, the setup that carries the artifact each root
 * NAMES onto that root is not refused and completes, and the root then reads as
 * something rather than nothing.
 *
 * What it still does not assert is VALUES. A captured vintage does hold real
 * data — capture drives a pattern through its own tests, so the state arrived
 * through real handlers — but the replay asks only whether the migration
 * applied, never whether what was there survived it. So the class where a moved
 * `.for()` key strands real data replays clean here. Measured on the real
 * `home.tsx`: renaming `.for("favorites")` exits 0. That class is covered by
 * `packages/piece/test/state-continuity.test.ts` and closing it in the gate is
 * stage 5 of `docs/plans/pattern-update-state-continuity.md`.
 *
 *   deno task pattern-vintage                      # replay; fail on a stranded fixture
 *   deno task pattern-vintage --update             # capture where a REQUIRED one is missing
 *   deno task pattern-vintage --update system/x.tsx  # pin any pattern deliberately
 *
 * `--update` can only ADD. It never rewrites or deletes an existing fixture,
 * for the reason Tier 1's baselines are append-only: a command that could
 * replace a vintage could replace the very vintage that would have caught a
 * break. Deleting one is a deliberate act that shows up in review as a deleted
 * file. Naming keys explicitly does not weaken that — a key that already has a
 * pinned vintage is skipped whichever way it was asked for.
 *
 * That discipline is enforced HERE, in what the command will do, and otherwise
 * rests on review — deliberately, and unlike Tier 1, whose baselines have a
 * mechanical checker (`tasks/check-baselines-append-only.ts`). There is no
 * equivalent gate over `packages/piece/test/vintages/`, so a deleted fixture is
 * caught by a human reading the diff and nothing else. Recapturing one is
 * therefore a decision to make out loud, not a routine step.
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
  armVerdictGuard,
  isClean,
  relativeToRepo,
  reportFailures,
  reportNothingReplayed,
  reportUncovered,
  reportUnmappedUrls,
  requiredPatternKeys,
  uncoveredRequiredPatterns,
  unmappedPatternUrls,
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
  // cannot drift from what actually auto-updates. A constant that stops
  // deriving a key would leave the gate requiring nothing, so that is checked
  // rather than absorbed.
  const systemUrls = [HOME_PATTERN_URL, DEFAULT_APP_PATTERN_URL];
  const unmapped = unmappedPatternUrls(systemUrls);
  if (unmapped.length > 0) {
    console.error(reportUnmappedUrls(unmapped));
    Deno.exit(1);
  }
  const required = requiredPatternKeys(systemUrls);

  if (Deno.args.includes("--update")) {
    // Keys named on the command line pin a pattern nobody auto-updates — the
    // deliberate act the layout allows for. With none named, the required set
    // is what gets seeded.
    const named = Deno.args.filter((arg) => !arg.startsWith("--"));
    const wanted = named.length > 0 ? named : required;
    const { captured, problems } = await captureMissing(
      roots,
      wanted,
      new Date(),
    );
    if (captured.length === 0 && problems.length === 0) {
      console.log(
        named.length > 0
          ? `Already pinned: ${named.join(", ")}.`
          : "Every auto-updating pattern already has a pinned vintage.",
      );
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

  const {
    vintages,
    replayed,
    candidates,
    targets,
    changed,
    updated,
    failures,
  } = await replayAll(roots);
  // Coverage is judged against the SAME list that was replayed. A second walk
  // would be a second answer to one question, and "replayed nothing" paired with
  // "everything is covered" is the disagreement that reads as a pass.
  const uncovered = uncoveredRequiredPatterns(required, vintages);

  if (uncovered.length > 0) console.error(reportUncovered(uncovered));
  if (replayed === 0) console.error(`\n${reportNothingReplayed()}`);
  if (failures.length > 0) console.error(`\n${reportFailures(failures)}`);

  // CANDIDATES is the soundness floor, not `updated`. A run where nothing
  // changed legitimately updates nothing — that is the common case, and the
  // auto-updater fires on the same condition. But a run with no candidates
  // examined no update targets at all, which is the shape that has read as
  // success three separate times in this tier's history.
  if (!isClean(failures, uncovered, replayed, candidates)) Deno.exit(1);
  // "all mappable" is safe to state unconditionally here: `replayVintage`
  // reports every unaddressable root as a FAILURE, and `isClean` above requires
  // no failures — so this line is unreachable with `unmappable > 0`. Saying it
  // positively rather than printing a caveat beside a pass is the point; a green
  // verdict with a footnote about skipped roots is how narrowed coverage reads
  // as success.
  // `targets` is printed beside `candidates` because the two differ, and the
  // gap is the honest measure of what was examined: a recorded instantiation is
  // only an upgrade target if today's source can be applied to it (a test
  // pattern and a keyless session pointer are neither). Stating only
  // `candidates` would overstate the coverage a green run bought.
  console.log(
    `Replayed ${replayed} vintage(s): ${candidates} recorded instantiation(s), ` +
      `all mappable to a file; ${targets} upgrade target(s), ` +
      `${changed} changed since capture, ${updated} updated cleanly.`,
  );
}

if (import.meta.main) {
  // Reaching a verdict is part of passing. Measured: a pattern that does not
  // compile, and a truncated fixture, both leave `harness.resolve()`'s promise
  // pending forever while the real error surfaces as a rejection nobody
  // awaits — so `main` never returns, the event loop drains, and the process
  // would exit 0 having replayed nothing and printed nothing.
  armVerdictGuard(globalThis, Deno.exit);
  await main();
  // Only the clean path gets here; every other exit is `Deno.exit(1)` above.
  // Exiting explicitly is what keeps the guard from firing on a success.
  Deno.exit(0);
}
