#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net

/**
 * Whether the topology still accounts for everything.
 *
 * The topology is only worth having if it stays complete: a test surface
 * nobody registered would vanish from the full run, which is a worse
 * failure than the workflow edit it replaced. Two halves catch the two
 * different ways a surface goes missing.
 *
 * The tree half needs no store and runs on every pull request. It walks
 * the tree for things that look like tests and fails on any that no
 * suite accounts for, or that two suites claim under the same record
 * surface and variant. This is what catches a pull request adding a test
 * surface nobody registered, at the moment it is added.
 *
 * The store half runs on `main`. It reads a run's records and fails on
 * any identity no suite recognizes, or that more than one suite claims.
 * This catches the subtler case: a surface that is registered and whose
 * files enumerate, but whose recorded names or configuration do not map
 * back to the topology, which would leave those tests running in the
 * full run and never selectable on a pull request.
 *
 * The reverse direction is reported rather than failed. A unit the
 * topology holds that no run has ever recorded is either a test that
 * never runs or a mapping that is wrong, and both are worth knowing
 * about without blocking anybody.
 *
 *   deno task check-test-topology            # the tree half
 *   deno task check-test-topology --records <file>...   # both halves
 */

import * as path from "@std/path";
import {
  loadAliasResolver,
  parseReportGroups,
  type TestIdentity,
  testIdentityKey,
} from "@commonfabric/test-support/records";
import { isLaneMeasurement } from "./ci-lane.ts";
import { dayOf } from "./test-selection/build.ts";
import { DENO_TEST_FILE } from "./test-topology/deno-task.ts";
import { claimsFor, loadTopology } from "./test-topology.ts";
import { type Suite, unavailableUnits } from "./test-topology/suite.ts";

/**
 * What the tree half looks at. The same rule the topology enumerates a
 * member's tests by, so a file one of them treats as a test cannot be a
 * file the other passes over.
 */
const TEST_FILE = DENO_TEST_FILE;

/** Directories that hold no test surface of their own. */
const SKIPPED = new Set([
  ".git",
  "node_modules",
  "vendor",
  "coverage",
  "dist",
  "target",
]);

/** Roots the walk starts from. Everything else holds no tests. */
const ROOTS = ["packages", "tasks", "scripts", "tools"];

/** Every path in the tree that looks like a test surface. */
export async function candidateSurfaces(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(path.join(root, relative));
    } catch (error) {
      // A directory outside this checkout contributes nothing; anything
      // else would shorten the list the guard checks against.
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for await (const entry of entries) {
      const at = `${relative}/${entry.name}`;
      if (entry.isDirectory) {
        if (!SKIPPED.has(entry.name)) await walk(at);
        continue;
      }
      if (!entry.isFile) continue;
      if (TEST_FILE.test(entry.name)) found.push(at);
      else if (
        entry.name.endsWith(".sh") && relative.endsWith("/integration")
      ) {
        found.push(at);
      }
    }
  };
  for (const start of ROOTS) await walk(start);
  return found.sort();
}

/**
 * Paths that look like tests and are not: fixtures a test drives rather
 * than tests of their own. Each says why, and an entry that stops
 * applying fails, so the list cannot go stale unnoticed.
 */
const NOT_A_TEST_SURFACE: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: "packages/deno-web-test/test/broken-config-project/pass.test.ts",
    reason: "a project the harness runs to prove it reports a bad config",
  },
  {
    path: "packages/deno-web-test/test/bundle-project/bundled.test.ts",
    reason: "a project the harness runs to prove it bundles before serving",
  },
  {
    path: "packages/deno-web-test/test/project-with-config/ed25519.test.ts",
    reason: "a project the harness runs to prove it reads a project config",
  },
  {
    path: "packages/deno-web-test/test/success-project/add.test.ts",
    reason: "a project the harness runs to prove a passing run reports green",
  },
  {
    path: "packages/deno-web-test/test/timeout-project/hang.test.ts",
    reason: "a project the harness runs to prove it reports a wedged test",
  },
];

/**
 * Test files no suite runs, which is a defect rather than a decision.
 * Each is a test somebody wrote that nothing in this repository executes,
 * so it neither passes nor fails and nobody is told. They are reported
 * rather than failed on, because registering one means deciding where it
 * runs and finding out whether it still passes, and that is its own
 * change. A new unclaimed surface fails; these do not.
 *
 * An entry that stops applying fails as well, so a file that gets
 * registered or deleted takes its line with it.
 */
const UNREGISTERED_SURFACES: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: "packages/cf-harness/integration/engine.integration.test.ts",
    reason:
      "reached only by the package's own `test:integration` task, which " +
      "nothing dispatches",
  },
  {
    path:
      "packages/cf-harness/integration/pattern-index-live.integration.test.ts",
    reason:
      "reached only by the package's own `test:integration` task, which " +
      "nothing dispatches",
  },
  {
    path: "packages/runner/integration/array_push.test.tsx",
    reason: "the package integration command enumerates .test.ts only",
  },
  {
    path: "packages/runner/integration/derive_array_leak.test.tsx",
    reason: "the package integration command enumerates .test.ts only",
  },
  {
    path: "packages/runner/integration/sqlite-cfc-commit-eval.test.tsx",
    reason: "the package integration command enumerates .test.ts only",
  },
  {
    path: "packages/runner/integration/sqlite-cfc-label-link.test.tsx",
    reason: "the package integration command enumerates .test.ts only",
  },
  {
    path: "packages/runner/integration/sqlite-cfc-label.test.tsx",
    reason: "the package integration command enumerates .test.ts only",
  },
  {
    path: "packages/runner/integration/sqlite-cfc-row-label.test.tsx",
    reason: "the package integration command enumerates .test.ts only",
  },
  {
    path: "packages/runner/integration/sqlite-db-query-decode.test.tsx",
    reason: "the package integration command enumerates .test.ts only",
  },
  {
    path: "packages/runner/scripts/profile-memory-regressions-lib.test.ts",
    reason: "the runner's test task runs test/ and this sits beside it",
  },
];

/** One thing the check found. */
export interface Finding {
  /** Whether it fails the check or is only reported. */
  fails: boolean;
  message: string;
}

/** Every path a suite accounts for exactly, and every one it contains. */
function claimsOf(
  suite: Suite,
): { exact: Set<string>; containers: string[] } {
  const exact = new Set<string>(suite.sources ?? []);
  const containers: string[] = [];
  for (const unit of suite.units) {
    if (TEST_FILE.test(unit)) exact.add(unit);
    else containers.push(unit);
  }
  for (const entry of suite.unavailable) exact.add(entry.unit);
  return { exact, containers };
}

/**
 * The tree half: everything that looks like a test is claimed by some
 * suite, and no two suites claim one path under the same variant.
 */
export function checkTree(
  suites: readonly Suite[],
  candidates: readonly string[],
  declared: {
    fixtures?: ReadonlyArray<{ path: string; reason: string }>;
    unregistered?: ReadonlyArray<{ path: string; reason: string }>;
  } = {},
): Finding[] {
  const findings: Finding[] = [];
  const claims = suites.map((suite) => ({ suite, ...claimsOf(suite) }));
  const fixtures = new Map(
    (declared.fixtures ?? []).map((entry) => [entry.path, entry.reason]),
  );
  const unregistered = new Map(
    (declared.unregistered ?? []).map((entry) => [entry.path, entry.reason]),
  );
  const held = new Set<string>();
  for (const candidate of candidates) {
    const exact = claims.filter((claim) => claim.exact.has(candidate));
    // A default suite and a non-default suite may claim one source
    // file: they are distinct execution surfaces with separate
    // histories. Two suites sharing a variant may not.
    const byVariant = new Map<string, string[]>();
    for (const claim of exact) {
      const variant = claim.suite.variant ?? "";
      byVariant.set(variant, [
        ...byVariant.get(variant) ?? [],
        claim.suite.id,
      ]);
    }
    for (const [variant, ids] of byVariant) {
      if (ids.length > 1) {
        findings.push({
          fails: true,
          message: `${candidate} is claimed by ${ids.join(" and ")}` +
            (variant === "" ? "" : ` under variant ${variant}`),
        });
      }
    }
    if (exact.length > 0) {
      const reason = fixtures.get(candidate) ?? unregistered.get(candidate);
      if (reason !== undefined) {
        findings.push({
          fails: true,
          message: `${candidate} is claimed by a suite and is still listed ` +
            `as unclaimed: ${reason}`,
        });
      }
      continue;
    }
    if (fixtures.has(candidate)) {
      held.add(candidate);
      continue;
    }
    const unregisteredReason = unregistered.get(candidate);
    if (unregisteredReason !== undefined) {
      held.add(candidate);
      findings.push({
        fails: false,
        message: `${candidate} runs nowhere: ${unregisteredReason}`,
      });
      continue;
    }
    // A suite whose units are coarser than a file — a workspace member
    // that runs whole, a directory one task owns — accounts for what it
    // contains.
    const containing = claims.filter((claim) =>
      claim.containers.some((unit) => candidate.startsWith(`${unit}/`))
    );
    // Containment is coarse and legitimately overlapping: a workspace
    // member that runs whole contains a directory another suite owns,
    // and a type-check group's unit is a scope name that reads as a
    // directory prefix. Only an exact claim is exclusive.
    if (containing.length > 0) continue;
    findings.push({
      fails: true,
      message: `${candidate} is claimed by no suite`,
    });
  }
  for (const path of [...fixtures.keys(), ...unregistered.keys()]) {
    if (held.has(path)) continue;
    if (candidates.includes(path)) continue;
    findings.push({
      fails: true,
      message: `${path} is listed as unclaimed and the tree no longer holds it`,
    });
  }
  return findings;
}

/** A record as the store half reads one. */
export interface StoredIdentity {
  test: TestIdentity;
  file?: string;
}

/**
 * The store half: every recorded identity is claimed by exactly one
 * suite, and every unit some run recorded is reported when no run did.
 */
export function checkStore(
  suites: readonly Suite[],
  records: readonly StoredIdentity[],
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const recorded = new Set<string>();
  for (const record of records) {
    const key = testIdentityKey(record.test);
    if (seen.has(key)) continue;
    seen.add(key);
    // The lane measures its own setup and batches through the same
    // record machinery every test uses. Those are not test surfaces —
    // nothing enumerates them and no lane can be asked to run one — so
    // no suite claims them and none should.
    if (isLaneMeasurement(record.test)) continue;
    const claims = claimsFor(suites, record);
    if (claims.length === 0) {
      findings.push({
        fails: true,
        message: `no suite claims the recorded identity ${key}`,
      });
      continue;
    }
    if (claims.length > 1) {
      findings.push({
        fails: true,
        message: `${claims.map((claim) => claim.suite.id).join(" and ")} ` +
          `both claim the recorded identity ${key}`,
      });
      continue;
    }
    const claim = claims[0]!;
    if (claim.unit !== undefined) {
      recorded.add(`${claim.suite.id}\t${claim.unit}`);
    }
  }
  for (const suite of suites) {
    // A leaf declared unavailable leaves its unit expected to record,
    // because every other identity in that unit still runs.
    const unavailable = unavailableUnits(suite);
    for (const unit of suite.units) {
      if (unavailable.has(unit)) continue;
      if (recorded.has(`${suite.id}\t${unit}`)) continue;
      findings.push({
        fails: false,
        message: `${suite.id} enumerates ${unit}, which this run never ` +
          "recorded: either it never runs or its mapping is wrong",
      });
    }
  }
  return findings;
}

/** Reads a run's records out of the files named on the command line. */
async function readRecords(
  paths: readonly string[],
): Promise<StoredIdentity[]> {
  const resolver = await loadAliasResolver();
  const records: StoredIdentity[] = [];
  for (const at of paths) {
    const text = await Deno.readTextFile(at);
    for (const group of parseReportGroups(text)) {
      // An alias applies only to records from days before the rename, so
      // the day the report was written is what resolution is asked
      // against. A report with no context is one this cannot date, and
      // its identities resolve as written.
      const day = group.context === undefined
        ? "9999-12-31"
        : dayOf(group.context.startedAt);
      for (const record of group.records) {
        const resolved = resolver.resolve(record.test, day);
        records.push({
          test: resolved,
          ...(record.file === undefined ? {} : { file: record.file }),
        });
      }
    }
  }
  return records;
}

async function main(): Promise<void> {
  const recordPaths: string[] = [];
  let reading = false;
  for (const arg of Deno.args) {
    if (arg === "--records") {
      reading = true;
      continue;
    }
    if (reading) recordPaths.push(arg);
  }
  const root = Deno.cwd();
  const suites = await loadTopology(root);
  const findings = checkTree(suites, await candidateSurfaces(root), {
    fixtures: NOT_A_TEST_SURFACE,
    unregistered: UNREGISTERED_SURFACES,
  });
  if (recordPaths.length > 0) {
    findings.push(...checkStore(suites, await readRecords(recordPaths)));
  }
  for (const finding of findings) {
    console[finding.fails ? "error" : "log"](
      `${
        finding.fails ? "topology" : "topology (reported)"
      }: ${finding.message}`,
    );
  }
  const failures = findings.filter((finding) => finding.fails).length;
  if (failures === 0) {
    console.log(
      `Topology accounts for every test surface (${suites.length} suites).`,
    );
    return;
  }
  console.error(
    `${failures} test surface(s) the topology does not account for.`,
  );
  Deno.exit(1);
}

if (import.meta.main) {
  await main();
}
