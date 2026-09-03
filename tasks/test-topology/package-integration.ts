/**
 * The package integration suites: the runner, the runtime client and the
 * shell, each driving a real Toolshed server, and the same three again
 * with server execution explicitly off. The deployed-topology suite owns
 * the background service and cf-harness gates that exercise the default-ON
 * production construction paths.
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
import { SERVER_EXECUTION_OFF_VARIANT } from "./patterns.ts";

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

/** The default-ON suite, its explicit-OFF arm, and the deployed-topology gate. */
export async function loadPackageIntegrationSuites(
  root: string,
): Promise<Suite[]> {
  const defaults: FilePart[] = [];
  const off: FilePart[] = [];
  for (const { scope, headless } of PACKAGES) {
    const packageDir = `packages/${scope}`;
    const files = await integrationFiles(root, packageDir);
    const junit = { kind: "integration", scope, filePrefix: packageDir };
    const env: Record<string, string> = headless ? { HEADLESS: "1" } : {};
    const { whole, unavailable } = unavailableFrom(
      SERVER_EXECUTION_ON_SKIPS[scope],
      packageDir,
    );
    defaults.push({
      packageDir,
      flags: ["-A"],
      env,
      junit,
      files: files.filter((file) => !whole.has(file)),
      unavailable,
    });
    off.push({
      packageDir,
      flags: ["-A"],
      env: { ...env, EXPERIMENTAL_SERVER_EXECUTION: "false" },
      junit,
      files,
    });
  }
  const backgroundPostureGate =
    "packages/background-piece-service/integration/posture-gate.test.ts";
  const harnessPostureGate =
    "packages/cf-harness/integration/fabric-session-posture-gate.test.ts";
  const deployedTopology = fileSuite({
    id: "deployed-topology",
    needs: ["deno", "toolshed", "bg-piece-service-binary"],
    parts: [
      {
        packageDir: "packages/background-piece-service",
        flags: ["--no-check", "--allow-env", "--allow-run", "--allow-net"],
        junit: {
          kind: "integration",
          scope: "background-piece-service",
          filePrefix: "packages/background-piece-service",
        },
        files: (await integrationFiles(
          root,
          "packages/background-piece-service",
        )).filter((file) => file === backgroundPostureGate),
      },
      {
        packageDir: "packages/cf-harness",
        flags: ["--no-check", "-A"],
        junit: {
          kind: "integration",
          scope: "cf-harness",
          filePrefix: "packages/cf-harness",
        },
        files: (await integrationFiles(root, "packages/cf-harness")).filter(
          (file) => file === harnessPostureGate,
        ),
      },
    ],
  });
  return [
    fileSuite({
      id: "package-integration",
      needs: ["deno", "toolshed", "browser"],
      parts: defaults,
    }),
    fileSuite({
      id: "package-integration-off",
      variant: SERVER_EXECUTION_OFF_VARIANT,
      needs: ["deno", "toolshed-baked-off", "browser"],
      parts: off,
    }),
    deployedTopology,
  ];
}
