/**
 * Everything that runs a pattern: the integration suites and their
 * server-execution arms, the reload suite, the pattern unit tests, and
 * the generated-pattern integration tests.
 *
 * Three of the four are `deno test` over a directory of files. The
 * fourth, `pattern-unit`, is `cf test` once per pattern file, run through
 * the integration task because that task is what writes the records; it
 * is handed the files it should run rather than a name filter, because a
 * selected set is a list of unrelated paths and no filter expresses one.
 */

import * as path from "@std/path";
import { PATTERN_TREES } from "../pattern-files.ts";
import {
  SERVER_EXECUTION_ON_SKIPS,
  type ServerExecutionSuite,
} from "../server-execution-on-skips.ts";
import {
  fileSuite,
  type Invocation,
  type Location,
  type Suite,
  type Unavailable,
} from "./suite.ts";

/** The variant the server-execution ON arms mark their records with. */
export const SERVER_EXECUTION_VARIANT = "server-execution";

/** Test files directly inside a directory, repository-relative and sorted. */
async function filesIn(
  root: string,
  directory: string,
  suffix = ".test.ts",
): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(path.join(root, directory))) {
      if (entry.isFile && entry.name.endsWith(suffix)) {
        found.push(`${directory}/${entry.name}`);
      }
    }
  } catch (error) {
    // A directory the tree does not hold contributes nothing, which is
    // what a package without integration tests looks like. Anything else
    // would silently take tests out of the topology, so it is raised.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return found.sort();
}

/** Every `.test.tsx` pattern the unit suite runs, repository-relative. */
async function patternTestFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(path.join(root, directory));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for await (const entry of entries) {
      if (entry.isDirectory) await walk(`${directory}/${entry.name}`);
      else if (entry.isFile && entry.name.endsWith(".test.tsx")) {
        found.push(`${directory}/${entry.name}`);
      }
    }
  };
  for (const tree of PATTERN_TREES) await walk(tree.directory);
  return found.sort();
}

/**
 * What a configuration's skip registry says about one suite, as the
 * topology reads it. A whole-file entry leaves the file out of the
 * enumeration; a step-level entry leaves the file in and names the one
 * leaf that does not run, so that leaf is excluded from the
 * unknown-identity and coverage rules while the rest behave normally.
 */
function unavailableFor(
  suite: ServerExecutionSuite,
  packageDir: string,
): { whole: Set<string>; unavailable: Unavailable[] } {
  const whole = new Set<string>();
  const unavailable: Unavailable[] = [];
  for (const skip of SERVER_EXECUTION_ON_SKIPS[suite]) {
    const unit = `${packageDir}/${skip.file}`;
    if (skip.step === undefined) whole.add(unit);
    unavailable.push({
      unit,
      ...(skip.step === undefined ? {} : { leafName: skip.step }),
      phase: skip.phase,
      reason: skip.reason,
    });
  }
  return { whole, unavailable };
}

/** The integration suites over `packages/patterns/integration/`. */
async function patternIntegrationSuites(root: string): Promise<Suite[]> {
  const packageDir = "packages/patterns";
  const files = await filesIn(root, `${packageDir}/integration`);
  const flags = [
    "-A",
    "--v8-flags=--max-old-space-size=4096",
    "--trace-leaks",
  ];
  const junit = {
    kind: "integration",
    scope: "patterns",
    filePrefix: packageDir,
  };
  const on = unavailableFor("patterns", packageDir);
  return [
    fileSuite({
      id: "pattern-integration",
      needs: ["deno", "toolshed", "browser", "compile-cache"],
      parts: [{
        packageDir,
        flags,
        env: { HEADLESS: "1" },
        junit,
        files,
      }],
    }),
    fileSuite({
      id: "pattern-integration-on",
      variant: SERVER_EXECUTION_VARIANT,
      needs: ["deno", "toolshed-baked-on", "browser", "compile-cache"],
      parts: [{
        packageDir,
        flags,
        env: { HEADLESS: "1", EXPERIMENTAL_SERVER_EXECUTION: "true" },
        junit,
        files: files.filter((file) => !on.whole.has(file)),
        unavailable: on.unavailable,
      }],
    }),
  ];
}

/**
 * The reload suite, which is one unit rather than one per file. Its own
 * task brings up the whole local development stack around the run and
 * hard-codes the directory it runs, so a lane can ask for the suite or
 * not ask for it, and nothing finer.
 */
function patternReloadSuite(): Suite {
  const unit = "packages/patterns/integration/reload";
  return {
    id: "pattern-reload",
    recordSurfaces: [{ kind: "integration", scope: "patterns" }],
    needs: ["deno", "local-dev-servers", "browser"],
    units: [unit],
    unavailable: [],
    locate(record): Location | undefined {
      if (record.test.v !== undefined) return undefined;
      if (record.test.k !== "integration" || record.test.s !== "patterns") {
        return undefined;
      }
      if (record.file?.startsWith(`${unit}/`) !== true) return undefined;
      return { level: "unit", unit };
    },
    command(requests, context): Promise<Invocation[]> {
      if (requests.length === 0) return Promise.resolve([]);
      return Promise.resolve([{
        command: [
          Deno.execPath(),
          "task",
          "integration",
          `--junit-dir=${context.outputDir}`,
          "patterns-reload",
        ],
        cwd: context.root,
        env: { HEADLESS: "1" },
        junit: [{
          path: path.join(context.outputDir, "patterns-reload.xml"),
          kind: "integration",
          scope: "patterns",
          filePrefix: "packages/patterns",
        }],
      }]);
    },
  };
}

/**
 * The pattern unit tests. Each file is one identity, named for its own
 * path, so the file and the identity coincide and there is nothing
 * finer to reach.
 */
async function patternUnitSuite(root: string): Promise<Suite> {
  const units = await patternTestFiles(root);
  const known = new Set(units);
  return {
    id: "pattern-unit",
    recordSurfaces: [{ kind: "pattern", scope: "patterns" }],
    needs: ["deno", "cf", "compile-cache"],
    units,
    unavailable: [],
    locate(record): Location | undefined {
      if (record.test.v !== undefined) return undefined;
      if (record.test.k !== "pattern" || record.test.s !== "patterns") {
        return undefined;
      }
      return known.has(record.test.n)
        ? { level: "unit", unit: record.test.n }
        : undefined;
    },
    async command(requests, context): Promise<Invocation[]> {
      const files = requests
        .map((request) => request.unit)
        .filter((unit) => known.has(unit));
      if (files.length === 0) return [];
      const listPath = path.join(context.outputDir, "pattern-unit.files");
      await Deno.mkdir(context.outputDir, { recursive: true });
      await Deno.writeTextFile(listPath, `${files.join("\n")}\n`);
      return [{
        command: [
          Deno.execPath(),
          "task",
          "integration",
          `--junit-dir=${context.outputDir}`,
          `--files=${listPath}`,
          "pattern-tests",
        ],
        cwd: context.root,
      }];
    },
  };
}

/** The generated-pattern integration tests. */
async function generatedPatternSuite(root: string): Promise<Suite> {
  const packageDir = "packages/generated-patterns";
  return fileSuite({
    id: "generated-patterns",
    needs: ["deno", "compile-cache"],
    parts: [{
      packageDir,
      flags: ["--trace-leaks", "-A", "--parallel"],
      env: { LOG_LEVEL: "warn" },
      junit: {
        kind: "integration",
        scope: "generated-patterns",
        filePrefix: packageDir,
      },
      files: await filesIn(root, `${packageDir}/integration/patterns`),
    }],
  });
}

/** Every pattern suite, read from the working tree. */
export async function loadPatternSuites(root: string): Promise<Suite[]> {
  return [
    ...await patternIntegrationSuites(root),
    patternReloadSuite(),
    await patternUnitSuite(root),
    await generatedPatternSuite(root),
  ];
}
