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
 * NAMES onto that root is not refused and completes, the root then reads as
 * something rather than nothing, AND every value the vintage held is still
 * readable afterwards.
 *
 * That last clause is the one that makes this a state-continuity gate rather
 * than an applies-cleanly gate. An update can materialize perfectly and still
 * lose data: move where a field is stored — `.for("journal")` becomes
 * `.for("journalMoved")` — and the declared contract does not change by a byte
 * while every document written under the old name goes unreachable. Nothing
 * throws. Measured on the real `home.tsx`, that now exits 1 naming the key and
 * showing what was there.
 *
 * The comparison reads the vintage under the root's OWN stored schema, so it
 * sees the data as the version that wrote it did, and compares only keys that
 * were present BEFORE: an update may legitimately ADD a field — that is what
 * `Default<>` is for — so a new key is not a finding, while an existing key
 * whose value changed is. That schema is relaxed at its `unknown` positions
 * first, on both sides: a schema-driven read resolves nothing there, so a key
 * an index signature covers would otherwise arrive as `undefined` however much
 * state it holds — indistinguishable from a key the document does not hold.
 *
 * It compares STATE, not renderings. `$UI` and its variants are recomputed by
 * the setup and the stored rendering never matches a fresh one, so comparing
 * them would red every pattern edit while saying nothing about data; every
 * other key is compared, `$NAME` included. Excluding those NAMES is not enough
 * on its own — a `map`-body hoist is a recorded instantiation whose whole
 * result is a vnode, under no `$UI` — so a rendering is recognised by shape
 * too, wherever it sits. What a root holds at a cell or stream position is
 * compared as the DOCUMENT it points at, so a field that moved to a different
 * doc is still a finding.
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
  DEFAULT_APP_PATTERN_SOURCE,
  HOME_PATTERN_SOURCE,
} from "../packages/piece/src/system-pattern-url.ts";
import {
  armVerdictGuard,
  isClean,
  relativeToRepo,
  reportFailures,
  reportNothingReplayed,
  reportReplaySummary,
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
  const systemUrls = [HOME_PATTERN_SOURCE, DEFAULT_APP_PATTERN_SOURCE];
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

  const replay = await replayAll(roots);
  // Coverage is judged against the SAME list that was replayed. A second walk
  // would be a second answer to one question, and "replayed nothing" paired with
  // "everything is covered" is the disagreement that reads as a pass.
  const uncovered = uncoveredRequiredPatterns(required, replay.vintages);

  if (uncovered.length > 0) console.error(reportUncovered(uncovered));
  if (replay.replayed === 0) console.error(`\n${reportNothingReplayed()}`);
  if (replay.failures.length > 0) {
    console.error(`\n${reportFailures(replay.failures)}`);
  }

  // CANDIDATES and TARGETS are the soundness floor, not `updated`. A run where
  // nothing changed legitimately updates nothing — that is the common case, and
  // the auto-updater fires on the same condition. But a run with no candidates,
  // or none that today's source could be applied to, examined no update targets
  // at all — the shape that has read as success three separate times here.
  if (!isClean(replay.failures, uncovered, replay)) Deno.exit(1);
  console.log(reportReplaySummary(replay));
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
