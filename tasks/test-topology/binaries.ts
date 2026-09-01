/**
 * Whether each shipped binary still compiles.
 *
 * The binaries are built on every pull request today, so a compile that
 * breaks is caught before it lands. Under selection a pull request runs
 * its servers and its command line from source, and never compiles
 * anything — which would leave a broken compile to be found on `main`,
 * after the change that broke it has merged. These suites keep it a
 * pull-request signal by making the build a test like any other: it has
 * an identity, it accumulates a record of what it has caught, and the
 * packer can choose it.
 *
 * What a compile catches that nothing else does is worth naming, because
 * every one of these builds passes `--no-check`. Type errors belong to
 * `deno task check`. What is left is everything else the compile does:
 * resolving the whole import graph from an entry point, bundling the
 * browser shell, and embedding each `--include`d asset from a path that
 * has to still exist.
 */

import { BINARY_NAMES, type BinaryName } from "../build-binaries.ts";
import {
  claimsIdentity,
  type Invocation,
  type Location,
  type Suite,
  type Unit,
} from "./suite.ts";
import { SERVER_EXECUTION_VARIANT } from "./patterns.ts";

/** What a unit's record is named for. */
const PREFIX = "build-binary";

/** The one record surface these suites share. */
const SURFACE = [{ kind: "gate", scope: "repo" }] as const;

/**
 * The trees whose change can break each binary's compile: its own
 * package, and whatever the build embeds into it. Deliberately coarse —
 * a compile reaches the whole import graph from an entry point, and no
 * short list describes that exactly — so this errs toward building. What
 * it must not do is miss the package a binary is built from, which is
 * why each entry names that package first.
 */
const BUILT_FROM: Record<BinaryName, readonly string[]> = {
  toolshed: [
    "packages/toolshed",
    // The browser shell is bundled into the binary, and the static
    // assets and pattern sources are embedded beside it.
    "packages/shell",
    "packages/static",
    "packages/patterns",
  ],
  "bg-piece-service": [
    "packages/background-piece-service",
    "packages/static",
  ],
  cf: [
    "packages/cli",
    "packages/fuse",
    "packages/static",
    "docs/common",
  ],
};

/** Whether a changed path sits inside one of these trees. */
function touches(changed: ReadonlySet<string>, trees: readonly string[]) {
  for (const path of changed) {
    if (trees.some((tree) => path === tree || path.startsWith(`${tree}/`))) {
      return true;
    }
  }
  return false;
}

/** One suite over a set of binaries, in one configuration. */
function binarySuite(
  id: string,
  binaries: readonly BinaryName[],
  options: { variant?: string; env?: Record<string, string> } = {},
): Suite {
  const known = new Set<Unit>(binaries);
  const surfaces = {
    recordSurfaces: SURFACE,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  };
  return {
    id,
    recordSurfaces: SURFACE,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
    needs: ["deno"],
    // A change to what a binary is built from runs its build. Left to the
    // score alone a build would almost never be chosen — it is expensive
    // and, having caught nothing yet, worth the floor — so the change
    // that is about to break one is exactly the change that would not
    // run it.
    mandatory: "changed",
    units: [...binaries],
    unavailable: [],

    unitsForChange(changed) {
      return binaries.filter((binary) => touches(changed, BUILT_FROM[binary]));
    },

    locate(record): Location | undefined {
      if (!claimsIdentity(surfaces, record.test)) return undefined;
      if (!record.test.n.startsWith(`${PREFIX} `)) return undefined;
      const binary = record.test.n.slice(PREFIX.length + 1);
      return known.has(binary) ? { level: "unit", unit: binary } : undefined;
    },

    command(requests, context): Promise<Invocation[]> {
      return Promise.resolve(
        requests
          .filter((request) => known.has(request.unit))
          .map((request) => ({
            // One invocation per binary rather than one for all of them:
            // a build that fails takes its own identity down and leaves
            // the others to report for themselves.
            command: [
              Deno.execPath(),
              "task",
              "run-recorded",
              "gate",
              "repo",
              `${PREFIX} ${request.unit}`,
              "--",
              Deno.execPath(),
              "task",
              "build-binaries",
              request.unit,
            ],
            cwd: context.root,
            ...(options.env === undefined ? {} : { env: options.env }),
          })),
      );
    },
  };
}

/**
 * The binary suites. The server-execution shell is the same build under
 * a different compile-time define, which is what a variant is: one test,
 * two configurations, two histories that never stand in for each other.
 */
export function loadBinarySuites(): Suite[] {
  return [
    binarySuite("binaries", BINARY_NAMES),
    binarySuite("binaries-on", ["toolshed"], {
      variant: SERVER_EXECUTION_VARIANT,
      env: { EXPERIMENTAL_SERVER_EXECUTION: "true" },
    }),
  ];
}
