/**
 * The vintage gate's actual work: capture a populated store by running a
 * pattern's own tests, and replay a captured store under today's source.
 *
 * Split from `pattern-vintage.ts` so it takes its roots as arguments instead of
 * deriving them from `import.meta.url`. That is what makes the gate testable
 * against a temp tree holding a throwaway pattern — and the test that buys is
 * the one that matters: break a pattern on purpose and prove the gate goes red.
 * Verifying that by hand on every change is exactly the check that stops
 * happening.
 */

import { exists } from "@std/fs";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import type { Identity } from "@commonfabric/identity";
import { runTestPattern } from "../packages/cli/lib/test-runner.ts";
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
  isPresentRootValue,
  materializeOnCell,
  openFileBackedRuntime,
  readVintageManifest,
  vintageHoldsRoot,
  type VintageManifestEntry,
  vintageRootCause,
  vintageRootHasState,
  writeVintageManifest,
} from "../packages/piece/test/state-continuity-harness.ts";
import { vintageCompanionDir } from "../packages/piece/test/vintage-layout.ts";

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

/**
 * Whether a recorded instantiation is something today's source can be applied
 * to. Four ways it is not:
 *
 * - No source path at all: unaddressable, nothing to resolve.
 * - A `*.test.tsx` entry: a test pattern creates stores and is never an upgrade
 *   target (#5180).
 * - A path that is not repo-root-relative. The evaluate loop records injected
 *   helper modules too (`cfc.ts`), and the repo's own discriminator for "an
 *   authored file" is a leading `/`. Without this the replay would build
 *   `${repoRoot}cfc.ts` — a path with no separator, so a spurious red.
 * - A `keyless:` identity: a session pointer, not a content hash, so it can
 *   never equal a freshly compiled identity and would report as CHANGED on
 *   every run forever.
 */
export function isUpgradeTarget(entry: VintageManifestEntry): boolean {
  if (entry.main === undefined) return false;
  if (!entry.main.startsWith("/")) return false;
  if (/\.test\.tsx?$/.test(entry.main)) return false;
  return !entry.identity.startsWith("keyless:");
}

/** What replaying one fixture found. */
export interface ReplayReport {
  /** Instantiations the fixture recorded. Zero means it proved nothing. */
  candidates: number;
  /** Recorded instantiations that are legitimate upgrade targets. */
  targets: number;
  /**
   * Recorded instantiations that cannot be mapped to a file to apply.
   *
   * Two shapes: no source path at all, and a path that is not repo-root-relative
   * (the evaluate loop records injected helper modules too). Each one also lands
   * in `failures`, so a fixture holding any is a RED run rather than a green one
   * with a caveat — the replay skips them, and a verdict that passes while
   * silently covering fewer roots than the fixture holds is this tier's worst
   * failure mode. Kept as a count for the tests that pin that behaviour.
   */
  unmappable: number;
  /** Targets whose source CHANGED since capture — the actual migrations. */
  changed: number;
  /** Changed targets that applied cleanly. */
  updated: number;
  failures: ReplayFailure[];
}

/**
 * Replay one fixture: apply today's source to every RECORDED instantiation
 * whose pattern has changed since the capture.
 *
 * Only the changed ones are applied, because an unchanged identity has no
 * migration to exercise — the same condition the auto-updater itself fires on.
 * So the recorded set is the CANDIDATE set, not the work list.
 */
export async function replayVintage(
  roots: GateRoots,
  vintage: VintageRef,
): Promise<ReplayReport> {
  const where = {
    patternKey: vintage.patternKey,
    path: relativeToRepo(vintage.path, roots.repoRoot),
  };
  const fail = (detail: string): ReplayReport => ({
    candidates: 0,
    targets: 0,
    unmappable: 0,
    changed: 0,
    updated: 0,
    failures: [{ ...where, detail }],
  });
  // Stated once, because every "this fixture is not usable" message needs it and
  // the obvious remedy is WRONG: `--update` skips a key that already has a
  // pinned vintage and the capture refuses to overwrite one, so "recapture it"
  // on its own prints "already pinned" and changes nothing. The path is
  // ABSOLUTE, not the repo-relative one the report prints for identification —
  // an instruction to delete a file has to name it the same way from whatever
  // directory the reader is standing in — and it names the companion directory
  // too, which is part of the fixture and would otherwise be left behind to
  // collide with the recapture.
  const remedy =
    `Delete ${vintage.path} and ${
      vintageCompanionDir(vintage.path)
    }/ deliberately, then \`deno task pattern-vintage --update ` +
    `${vintage.patternKey}\``;

  return await withRuntime(roots, vintage.path, async (runtimeVintage) => {
    // The control, before anything is applied. A fixture that did not restore
    // presents as a fresh empty space, and today's source materializes onto a
    // fresh empty space just fine — so without this, "green" and "the fixture
    // was never there" are the same reading.
    if (!await vintageRootHasState(runtimeVintage)) {
      return fail(
        "this fixture holds no captured root — it did not restore, so " +
          "replaying it would prove nothing",
      );
    }
    const manifest = await readVintageManifest(runtimeVintage);
    if (manifest === undefined || manifest.entries.length === 0) {
      return fail(
        "this fixture records no pattern instantiations, so there is nothing " +
          `to update and a green run would assert nothing. ${remedy}`,
      );
    }
    // The filename's identity is PROVENANCE — which version wrote this state —
    // and provenance nothing reads is decoration that drifts. The manifest names
    // every identity the run materialized, so checking that the filename's is
    // among them costs one comparison and keeps the name answerable: a fixture
    // renamed, or restored from the wrong file, says so here rather than
    // replaying under a version it never came from.
    if (!manifest.entries.some((e) => e.identity === vintage.identity)) {
      return fail(
        `this fixture's name records identity ${vintage.identity}, which it ` +
          `does not contain (it holds ${
            [...new Set(manifest.entries.map((e) => e.identity))].join(", ")
          }) — so it is not the state its name claims`,
      );
    }

    const targets = manifest.entries.filter(isUpgradeTarget);
    // Unaddressable, not merely un-targeted. Both shapes belong here: no source
    // path at all, and a path that is not repo-root-relative — the evaluate loop
    // records injected helper modules (`cfc.ts`) whose names carry no leading
    // slash, and `${repoRoot}cfc.ts` is not a file. Counting only the first would
    // let the second be skipped in silence while the verdict says "all mappable".
    //
    // Computed BEFORE the zero-target check below, which would otherwise return
    // while claiming a reason it had not looked at: an unmappable entry is not a
    // test pattern, and its per-entry diagnosis is the actionable half.
    const unmappable = manifest.entries.filter(
      (e) => e.main === undefined || !e.main.startsWith("/"),
    );
    // Zero targets is a FIXTURE-level failure, not a quiet contribution of
    // nothing to the run's total. `isClean` floors the SUM of targets, which one
    // fixture covering nothing slips under the moment another covers five — and
    // this fixture would then have applied today's source to nothing at all
    // while the run read green.
    //
    // Reachable, and by design: `isUpgradeTarget` has grown four exclusions,
    // two of them added after fixtures already existed. Fixtures are
    // append-only and never recaptured, so a new exclusion silently zeroes an
    // old fixture's coverage — exactly the kind of drift this tier keeps
    // mistaking for a pass.
    if (targets.length === 0) {
      return fail(
        `this fixture records ${manifest.entries.length} instantiation(s), ` +
          `but not one is something today's source can be applied to — ` +
          `${unmappable.length} cannot be mapped to a file at all, and the ` +
          `rest are test patterns or keyless session pointers. Replaying it ` +
          `asserts nothing. ${remedy}`,
      );
    }
    // The per-entry control, and the one the whole gate leans on: does this
    // fixture actually HOLD the root it is about to validate? A root that is not
    // there reads CLEAN — the cell is absent, today's source materializes onto
    // it, the root then holds today's defaults, and the entry counts as updated
    // cleanly over state that was never captured. `vintageRootHasState` above
    // cannot answer this: it is one check on the well-known capture root and
    // says nothing about the nested cell each entry names.
    //
    // Measured, three ways to be absent and all of them read green without this:
    // a root recorded in a space the fixture does not carry (a cross-space child
    // — `Factory.inSpace(...)` is how a profile is created), a companion store
    // that restored but is empty, and a recorded cell id that names nothing.
    const carried = new Set(runtimeVintage.restoredSpaces);
    const missing = new Set<VintageManifestEntry>();
    for (const entry of targets) {
      const held = await vintageHoldsRoot(
        runtimeVintage,
        entry.space,
        entry.cellId,
      );
      if (!held) missing.add(entry);
    }
    const report: ReplayReport = {
      candidates: manifest.entries.length,
      targets: targets.length,
      unmappable: unmappable.length,
      changed: 0,
      updated: 0,
      failures: [],
    };
    // A recorded root nothing can address is a FAILURE, not a note. The replay
    // skips it, so a green verdict would be a claim about fewer roots than the
    // fixture holds — coverage silently narrowed, which is this tier's worst
    // failure mode and the one it has hit three separate times. Every
    // instantiation carries its own authored file today, so a sourceless entry
    // means that propagation regressed and the gate should say so loudly.
    for (const entry of unmappable) {
      report.failures.push({
        ...where,
        detail: `recorded instantiation ${entry.identity}#${entry.symbol} ` +
          `cannot be mapped to a file to apply (${
            entry.main === undefined
              ? "no source path"
              : `"${entry.main}" is not repo-root-relative`
          }) — it was recorded but NOT validated`,
      });
    }
    // Same rule for a root the fixture does not hold, and for the same reason:
    // the replay cannot reach it, so a green verdict would be a claim about
    // fewer roots than the fixture records. A missing SPACE is called out by
    // name because it is both the likeliest cause and the one with an obvious
    // remedy; otherwise the message names the EVIDENCE the control looked for,
    // so a doc that is present but unstamped — the one shape a false red could
    // take — is distinguishable from a doc that is not there at all.
    //
    for (const entry of missing) {
      report.failures.push({
        ...where,
        detail: `recorded instantiation ${entry.identity}#${entry.symbol} ` +
          (carried.has(entry.space)
            ? `has no pattern setup marker at ${entry.cellId} in ` +
              `${entry.space}, so this fixture does not hold that root`
            : `was materialized in ${entry.space}, which this fixture does ` +
              `not carry (it holds ${[...carried].sort().join(", ")})`) +
          ` — it was recorded but NOT validated. ${remedy}`,
      });
    }

    for (const entry of targets) {
      // Already reported above. Materializing it anyway would apply today's
      // source to an empty cell and count the result as a clean update.
      if (missing.has(entry)) continue;
      const source = `${roots.repoRoot}${entry.main}`;
      let program;
      try {
        program = await runtimeVintage.runtime.harness.resolve(
          new FileSystemProgramResolver(source, roots.repoRoot),
        );
      } catch (error) {
        report.failures.push({
          ...where,
          detail: `${entry.main} no longer resolves: ${describeError(error)}`,
        });
        continue;
      }
      // Guarded for the same reason `resolve` above is: this loop compiles EVERY
      // recorded target's file, including nested sub-pattern modules, so one that
      // no longer compiles — or exports no `default` — must be a reported finding
      // for that entry, not an exception that aborts the remaining entries and
      // every later fixture with them.
      let pattern;
      try {
        pattern = await runtimeVintage.runtime.patternManager
          // Compiled in the space the ROOT lives in, because that is what
          // production does: `pattern-updater.ts` compiles with the piece's own
          // space, and the space selects what a `cf:` fabric import resolves
          // against and where `compileViaCellCache` persists the closure.
          //
          // Stated as fidelity, not as a bug this catches — no test separates
          // the two, and none can with fixtures as captured: the pattern-test
          // runner cannot replicate a source closure into a child space
          // (`closure-replication-failed` on every cross-space capture), so a
          // companion store carries the child's DATA and no closure for this to
          // resolve differently against. Separating them needs a fixture whose
          // cross-space child has a `cf:` import, which is a capture-side gap
          // rather than a reason to compile in the wrong space meanwhile.
          .compilePattern(program as never, {
            space: entry.space as never,
          });
      } catch (error) {
        report.failures.push({
          ...where,
          detail: `${entry.main} no longer compiles: ${describeError(error)}`,
        });
        continue;
      }
      const today = runtimeVintage.runtime.patternManager
        .getArtifactEntryRef(pattern)?.identity;
      // Unchanged identity, no migration to exercise. This is the common case
      // and a legitimate no-op, NOT a skipped check.
      if (today === entry.identity) continue;
      report.changed++;

      const outcome = await materializeOnCell(
        runtimeVintage,
        program as never,
        // The RECORDED space, not the fixture's primary one. An entity id is
        // content-derived and so carries no space, which makes reading it under
        // the wrong DID a lookup that SUCCEEDS at finding nothing: the cell comes
        // back absent, today's source materializes onto it, and the entry counts
        // as updated cleanly. Every root a cross-space child owns would replay
        // that way.
        (v, resultSchema) =>
          v.runtime.getCellFromEntityId(
            entry.space as never,
            entry.cellId as never,
            [],
            resultSchema as never,
          ),
        {
          // The RECORDED symbol, not the module's entry export. A module
          // contributes several instantiable patterns (its default plus each
          // transformer hoist), and the manifest already says which one this
          // cell holds — applying the entry pattern instead would validate a
          // different artifact than the one stored here.
          symbol: entry.symbol,
          // ...and the recorded space, for the compile inside, for the same
          // reason as the `compilePattern` above.
          space: entry.space,
        },
      );
      if (outcome.error !== undefined) {
        report.failures.push({
          ...where,
          detail:
            `updating ${entry.main} (${entry.symbol}) over this vintage ` +
            `was REFUSED:\n      ${outcome.error}`,
        });
        continue;
      }
      // A migration can apply without being refused and still leave the root
      // reading as nothing — the state gone rather than rejected. "Not refused"
      // and "the root still reads" are two claims, and the gate's own header
      // promises both, so both are checked. Per TARGET, not once per fixture:
      // `vintageRootHasState` above is a pre-check on the well-known capture
      // root, which says nothing about the nested cell each entry names.
      if (!isPresentRootValue(outcome.value)) {
        report.failures.push({
          ...where,
          detail: `updating ${entry.main} (${entry.symbol}) was not refused, ` +
            `but the root now reads as nothing — the vintage's state is gone`,
        });
        continue;
      }
      report.updated++;
    }
    return report;
  });
}

/**
 * Replay every fixture under `vintagesRoot`.
 *
 * Returns the fixtures it walked, so the caller can decide coverage against the
 * SAME list it replayed. Two walks would be two answers to one question, and the
 * pair "replayed nothing" / "everything is covered" is exactly the disagreement
 * that reads as a pass.
 */
export async function replayAll(
  roots: GateRoots,
): Promise<
  {
    vintages: VintageRef[];
    replayed: number;
    candidates: number;
    targets: number;
    unmappable: number;
    changed: number;
    updated: number;
    failures: ReplayFailure[];
  }
> {
  const vintages = await collectVintages(roots.vintagesRoot);
  let candidates = 0, targets = 0, changed = 0, updated = 0, unmappable = 0;
  const failures: ReplayFailure[] = [];
  for (const vintage of vintages) {
    const report = await replayVintage(roots, vintage);
    candidates += report.candidates;
    targets += report.targets;
    unmappable += report.unmappable;
    changed += report.changed;
    updated += report.updated;
    failures.push(...report.failures);
  }
  return {
    vintages,
    replayed: vintages.length,
    candidates,
    targets,
    unmappable,
    changed,
    updated,
    failures,
  };
}

/** The pattern-test file that populates a vintage for `patternKey`. */
export function testPathFor(roots: GateRoots, patternKey: string): string {
  return `${roots.patternsRoot}/${patternKey.replace(/\.tsx?$/, "")}.test.tsx`;
}

/**
 * Capture a vintage for `patternKey` by running its OWN tests against a
 * file-backed store, then snapshotting.
 *
 * The tests are what put DATA in the fixture. A vintage captured straight off
 * setup holds a freshly materialized root and nothing else, so no change can
 * strand anything in it. Pattern tests are themselves patterns —
 * `home.test.tsx` instantiates `Home({})` and drives it with
 * `action()`/`assert()` — so what they leave behind is real pattern state
 * written through real handlers.
 *
 * Each capture gets a FRESH store. Vintages are independent snapshots of one
 * version's world, never one database migrated forward: a carried-forward
 * lineage would already be shaped by every migration since, and would no longer
 * be state written by a version that knew nothing about today's.
 */
export async function captureVintage(
  roots: GateRoots,
  patternKey: string,
  now: Date,
): Promise<string> {
  const testPath = testPathFor(roots, patternKey);
  const dir = await Deno.makeTempDir({ prefix: "pattern-vintage-capture-" });
  const vintage = await openFileBackedRuntime(roots.signer, dir);
  try {
    // What the run instantiates and where. There is no way to enumerate this
    // from the store afterwards, so it is observed as it happens.
    const seen = new Map<string, VintageManifestEntry>();
    const result = await runTestPattern(testPath, {
      root: roots.repoRoot,
      storageHost: {
        identity: roots.signer,
        storageManager: vintage.storageManager as never,
        // Pin the test's root so the replay can find it; the runner otherwise
        // causes it with Date.now().
        resultCause: vintageRootCause(),
        onPatternInstantiated: (instantiation) => {
          const cellId = String(instantiation.cell.id);
          // Dedupe: a pattern re-materialized during a run is one target.
          seen.set(`${instantiation.identity}/${cellId}`, {
            identity: instantiation.identity,
            symbol: instantiation.symbol,
            main: instantiation.main,
            cellId,
            space: String(instantiation.cell.space),
          });
        },
      },
    });
    // A failed test run would record a state the pattern never legitimately
    // reaches, so refuse rather than pin it.
    const failed = result.results.filter((r) => !r.passed && !r.skipped);
    if (result.error !== undefined || failed.length > 0) {
      throw new Error(
        `cannot capture ${patternKey}: its own tests did not pass, so the ` +
          `fixture would record a state the pattern never reaches: ${
            result.error ??
              failed.map((r) => `${r.name}: ${r.error}`).join("; ")
          }`,
      );
    }
    if (result.results.length === 0) {
      throw new Error(
        `cannot capture ${patternKey}: ${testPath} ran no assertions, so the ` +
          `fixture would hold no test-written state`,
      );
    }
    // The pattern's own identity, read off the compiled artifact rather than
    // guessed — provenance for which version wrote the state, and the name the
    // fixture carries.
    const program = await vintage.runtime.harness.resolve(
      resolver(roots, patternKey),
    );
    const pattern = await vintage.runtime.patternManager.compilePattern(
      program as never,
      { space: vintage.space as never },
    );
    const ref = vintage.runtime.patternManager.getArtifactEntryRef(pattern);
    if (ref === undefined) {
      throw new Error(
        `cannot capture ${patternKey}: compiled pattern has no identity`,
      );
    }

    // Every instantiation carries its own authored file: the runtime stamps it
    // at module-index time and resolves it through the derivation chain, so a
    // nested sub-pattern names its own source rather than the entry's. Nothing
    // to fill in here.
    const entries = [...seen.values()];
    // Refuse to PIN a fixture holding a root nothing can address, rather than
    // waiting for the replay to fail on it. The replay does fail closed, but it
    // would do so on whoever's PR next ran the gate; catching it here blames the
    // capture that created it, when the cause is still in hand.
    const unaddressable = entries.filter(
      (e) => e.main === undefined || !e.main.startsWith("/"),
    );
    if (unaddressable.length > 0) {
      throw new Error(
        `cannot capture ${patternKey}: ${unaddressable.length} of ` +
          `${entries.length} instantiation(s) cannot be mapped to a file (${
            unaddressable.map((e) => `${e.identity}#${e.symbol}`).join(", ")
          }), so the fixture would record roots the replay cannot map to a file`,
      );
    }
    if (!entries.some(isUpgradeTarget)) {
      throw new Error(
        `cannot capture ${patternKey}: the run instantiated no upgradable ` +
          `pattern (${entries.length} instantiation(s), all test patterns), ` +
          `so the fixture would have nothing to replay`,
      );
    }
    await writeVintageManifest(vintage, entries);
    const outDir = `${roots.vintagesRoot}/${patternKey}/${PINNED}`;
    await Deno.mkdir(outDir, { recursive: true });
    const path = `${outDir}/${vintageFileName(stampFor(now), ref.identity)}`;
    // Never write over an existing fixture. `captureMissing` already skips a
    // covered key, so reaching this with the file present means something else
    // did — and the cleanup below deletes files on the way out, which must
    // never be somebody else's pinned state. A fixture is deleted deliberately
    // and visibly in a diff, never by an error path.
    //
    // The companion directory is deliberately NOT part of this guard, so the
    // cleanup can remove a LEFTOVER one. A companion directory whose primary
    // file does not exist is not a fixture — nothing enumerates it — and
    // restoring an extra space harms nothing: `restoredSpaces` only feeds a
    // diagnosis, and what gets validated comes from the manifest.
    if (await exists(path)) {
      throw new Error(
        `cannot capture ${patternKey}: ${path} already exists, and a capture ` +
          `never overwrites a pinned vintage — delete it deliberately first`,
      );
    }
    try {
      await vintage.snapshot(path);
    } catch (error) {
      // A fixture is written in pieces — the primary file, then one companion
      // store per other space — so a failure part way through leaves a fixture
      // that is missing spaces. That is worse than none at all: `--update` only
      // ever ADDS, so it would skip the key as already covered and the partial
      // would sit there being replayed. Publishing is therefore all-or-nothing.
      await Deno.remove(path).catch(() => {});
      await Deno.remove(vintageCompanionDir(path), { recursive: true })
        .catch(() => {});
      throw error;
    }
    return path;
  } finally {
    await vintage.dispose().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
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
