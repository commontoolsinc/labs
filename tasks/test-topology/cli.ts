/**
 * The command-line integration suites.
 *
 * All three record under one surface, kind `integration` and scope `cli`,
 * and what tells them apart is the name a record carries. The dispatch
 * script's steps belong to `cli-core`, the FUSE script's to `cli-fuse`,
 * and the Deno-based tests to `cli-deno`, which is an ordinary `deno
 * test` file suite.
 *
 * `integration.sh` records its whole invocation as well as each step, and
 * the same task identity appears whichever arm dispatched it. That record
 * proves the topology knows the surface, but it names no single unit and
 * must not be summed with its own steps, so it locates to the suite.
 */

import * as path from "@std/path";
import {
  claimsIdentity,
  fileSuite,
  type Invocation,
  type Location,
  type Suite,
  type UnitRequest,
} from "./suite.ts";

/** Where the scripts live, repository-relative. */
const CLI_DIR = "packages/cli/integration";

/** The one record surface all three suites share. */
const SURFACE = [{ kind: "integration", scope: "cli" }] as const;

/**
 * The dispatch table's arms, read from the script. A step arm runs
 * exactly one step and is what the suite enumerates; a group arm runs
 * several and exists for people running the script by hand, so it is
 * never a unit and never makes an identity ambiguous.
 */
export function stepArms(script: string): Map<string, string> {
  const lines = script.split("\n");
  const open = lines.indexOf('case "$SECTION" in');
  if (open < 0) return new Map();
  const byStep = new Map<string, string>();
  let section: string | undefined;
  let steps: string[] = [];
  const close = (): void => {
    // A step reachable from several arms belongs to exactly one of them:
    // the arm that runs it alone. The first such arm wins, which is the
    // order the table itself is written in.
    if (section !== undefined && steps.length === 1 && !byStep.has(steps[0]!)) {
      byStep.set(steps[0]!, section);
    }
    steps = [];
  };
  for (const line of lines.slice(open + 1)) {
    if (line === "esac") break;
    const opened = /^ {2}(\S+)\)$/.exec(line);
    if (opened !== null) {
      close();
      section = opened[1];
      continue;
    }
    const begins = /^ {4}cf_test_step_begin (\S+)$/.exec(line);
    if (begins !== null) steps.push(begins[1]!);
  }
  close();
  return byStep;
}

/** The scripts beside `integration.sh` that record one identity each. */
const STANDALONE_SCRIPTS = ["acl.sh"];

/**
 * The dispatch suite. A unit is one arm of `integration.sh` that runs one
 * step, or one of the standalone scripts beside it.
 */
async function cliCoreSuite(root: string): Promise<Suite> {
  const script = await Deno.readTextFile(
    path.join(root, CLI_DIR, "integration.sh"),
  );
  // The scripts this suite runs: the dispatch script, the standalone
  // scripts beside it, and whichever scripts its steps call. Read from
  // the script rather than listed, so a step that starts calling another
  // one accounts for it without anybody remembering to say so. A script
  // nothing calls is left unclaimed on purpose — that is a test surface
  // running nowhere, and the drift guard exists to say so.
  const sources = new Set<string>([`${CLI_DIR}/integration.sh`]);
  for (const name of STANDALONE_SCRIPTS) sources.add(`${CLI_DIR}/${name}`);
  for (const [called] of script.matchAll(/(?:^|[\s"'/])([\w.-]+\.sh)\b/g)) {
    const name = called.replace(/^[\s"'/]/, "");
    if (name === "fuse-exec.sh") continue;
    try {
      await Deno.stat(path.join(root, CLI_DIR, name));
      sources.add(`${CLI_DIR}/${name}`);
    } catch {
      // A name that is not a script beside this one, such as a path the
      // script builds for something it writes.
    }
  }
  const arms = stepArms(script);
  // A unit is named for the record its step writes, which is what the
  // store speaks in; the arm that runs it is what the command reaches
  // for.
  const armOf = new Map<string, string>();
  const units: string[] = [];
  for (const [step, section] of arms) {
    const unit = `integration.sh ${step}`;
    units.push(unit);
    armOf.set(unit, section);
  }
  for (const name of STANDALONE_SCRIPTS) {
    units.push(name);
    armOf.set(name, "");
  }
  units.sort();

  return {
    id: "cli-core",
    recordSurfaces: SURFACE,
    needs: ["deno", "toolshed", "cf", "jq"],
    units,
    unavailable: [],
    sources: [...sources].sort(),
    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces: SURFACE }, record.test)) {
        return undefined;
      }
      const name = record.test.n;
      if (armOf.has(name)) return { level: "unit", unit: name };
      // The whole-invocation record of a script whose steps this suite
      // holds. It measures the invocation rather than any one step.
      if (name === "integration.sh") return { level: "suite" };
      return undefined;
    },
    command(requests, context): Promise<Invocation[]> {
      const cwd = path.join(context.root, "packages/cli");
      const invocations: Invocation[] = [];
      for (const request of requests) {
        const arm = armOf.get(request.unit);
        if (arm === undefined) continue;
        invocations.push(
          arm === ""
            ? {
              command: [`./integration/${request.unit}`],
              cwd,
            }
            : {
              command: ["./integration/integration.sh"],
              cwd,
              env: { CF_CLI_INTEGRATION_SECTION: arm },
            },
        );
      }
      return Promise.resolve(invocations);
    },
  };
}

/**
 * The FUSE script, which records one identity per phase it completes and
 * runs whole here.
 *
 * The script itself can be asked for a quarter of its work — it takes a
 * section, and four of them stand alone. This suite does not use that
 * yet, because a record and a section are named differently: the
 * dispatch table names phases by identifier, and a phase records itself
 * under the sentence it announces. Attributing a record to a section
 * therefore means reading each phase's function for the announcements
 * inside it, which is its own change.
 */
function cliFuseSuite(): Suite {
  const unit = "fuse-exec.sh";
  return {
    id: "cli-fuse",
    recordSurfaces: SURFACE,
    needs: ["deno", "toolshed", "cf", "fuse"],
    units: [unit],
    unavailable: [],
    sources: [`${CLI_DIR}/fuse-exec.sh`],
    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces: SURFACE }, record.test)) {
        return undefined;
      }
      return record.test.n === unit || record.test.n.startsWith(`${unit} `)
        ? { level: "unit", unit }
        : undefined;
    },
    command(requests: readonly UnitRequest[], context): Promise<Invocation[]> {
      if (requests.length === 0) return Promise.resolve([]);
      return Promise.resolve([{
        command: ["./integration/fuse-exec.sh"],
        cwd: path.join(context.root, "packages/cli"),
      }]);
    },
  };
}

/** The Deno-based command-line integration tests. */
function cliDenoSuite(): Suite {
  return fileSuite({
    id: "cli-deno",
    needs: ["deno", "toolshed", "cf"],
    parts: [{
      packageDir: "packages/cli",
      flags: ["--no-check", "-A"],
      junit: {
        kind: "integration",
        scope: "cli",
        filePrefix: "packages/cli",
      },
      files: ["packages/cli/test/piece-integration.test.ts"],
    }],
  });
}

/** Every command-line suite, read from the working tree. */
export async function loadCliSuites(root: string): Promise<Suite[]> {
  return [await cliCoreSuite(root), cliFuseSuite(), cliDenoSuite()];
}
