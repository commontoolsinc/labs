/**
 * The package integration suites: the runner, the runtime client and the
 * shell, each driving a real Toolshed server, and the same three again
 * with server execution on.
 *
 * One runner does not imply one scope here. The three packages share a
 * command shape and a server, and each records under its own scope, so
 * they are one suite spanning three parts rather than three suites that
 * would each pay for a server of their own.
 */

import {
  SERVER_EXECUTION_ON_SKIPS,
  type ServerExecutionSuite,
} from "../server-execution-on-skips.ts";
import {
  type FilePart,
  fileSuite,
  type Suite,
  unavailableFrom,
} from "./suite.ts";
import { SERVER_EXECUTION_VARIANT } from "./patterns.ts";

/** The packages the suite spans, and what each one's tests need. */
const PACKAGES: ReadonlyArray<
  { scope: ServerExecutionSuite; headless: boolean }
> = [
  { scope: "runner", headless: false },
  { scope: "runtime-client", headless: false },
  { scope: "shell", headless: true },
];

/** Test files directly inside a package's integration directory. */
async function integrationFiles(
  root: string,
  packageDir: string,
): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (
      const entry of Deno.readDir(`${root}/${packageDir}/integration`)
    ) {
      if (entry.isFile && entry.name.endsWith(".test.ts")) {
        found.push(`${packageDir}/integration/${entry.name}`);
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

/** Both suites, the default one and the server-execution arm. */
export async function loadPackageIntegrationSuites(
  root: string,
): Promise<Suite[]> {
  const defaults: FilePart[] = [];
  const on: FilePart[] = [];
  for (const { scope, headless } of PACKAGES) {
    const packageDir = `packages/${scope}`;
    const files = await integrationFiles(root, packageDir);
    const junit = { kind: "integration", scope, filePrefix: packageDir };
    const env: Record<string, string> = headless ? { HEADLESS: "1" } : {};
    defaults.push({ packageDir, flags: ["-A"], env, junit, files });

    const { whole, unavailable } = unavailableFrom(
      SERVER_EXECUTION_ON_SKIPS[scope],
      packageDir,
    );
    on.push({
      packageDir,
      flags: ["-A"],
      env: { ...env, EXPERIMENTAL_SERVER_EXECUTION: "true" },
      junit,
      files: files.filter((file) => !whole.has(file)),
      unavailable,
    });
  }
  return [
    fileSuite({
      id: "package-integration",
      needs: ["deno", "toolshed", "browser"],
      parts: defaults,
    }),
    fileSuite({
      id: "package-integration-on",
      variant: SERVER_EXECUTION_VARIANT,
      needs: ["deno", "toolshed-baked-on", "browser"],
      parts: on,
    }),
  ];
}
