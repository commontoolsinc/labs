import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { getLogger } from "@commonfabric/utils/logger";
import type { Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

// The resume owned-cell walk (collectResumeOwnedCells) has TWO exits that skip
// the same work — a sub-pattern node's owned-cell pre-sync AND the recursion
// that would reach that child's own derivedInternalCells manifest. One is the
// catch around binding/resolution; the other is the resolution simply coming
// back undefined, which happens when a node's outputs hold no write redirect
// the scan can resolve (outputs consisting only of deferred partialCause
// aliases are the shape seen live). Both hide a skipped subtree that is
// otherwise only discoverable by console probing, so both emit under the
// `resume-owned-cells` key with the same identity payload.
//
// Their LEVELS differ, and that difference is what these tests pin:
//
//   - the catch exit WARNS. Outputs that cannot even be bound are a genuine
//     failure of an expectation.
//   - the undefined exit DEBUGS. It is the by-design outcome for outputs made
//     only of deferred partialCause aliases — #5143 deliberately moved that
//     case off the throwing path — and the real home pattern takes it several
//     times per healthy run. Warning there would be noise, not signal.
//
// So there are two obligations, and a test each way: the positive cases prove
// each line still carries what a stranded-piece investigation needs, and the
// healthy-home case proves an ordinary run stays SILENT at warn level. Putting
// the debug back to warn fails the latter.
//
// resume-output-redirect-partialcause.test.ts asserts the scan's return value;
// this asserts the consequence at the call site.

const signer = await Identity.fromPassphrase("resume owned cells skip log");
const space = signer.did();

type Emission = { level: "debug" | "warn"; key: string; parts: unknown[] };

/**
 * Record every `debug`/`warn` the runner's logger emits while `fn` runs,
 * resolving each call's lazy message thunk the way the logger itself does.
 *
 * This captures at the logger rather than at the console on purpose: the LEVEL
 * of the call is what is under test, and reading the console would conflate it
 * with the runner logger's own configured level (`warn`, so its debug calls
 * never reach the console at all) and with `LOG_TO_STDERR`.
 */
const captureRunnerLog = async (
  fn: () => Promise<void>,
): Promise<Emission[]> => {
  const logger = getLogger("runner") as unknown as Record<
    "debug" | "warn",
    (key: string, ...messages: unknown[]) => void
  >;
  const emissions: Emission[] = [];
  const originals = { debug: logger.debug, warn: logger.warn };
  const record =
    (level: "debug" | "warn") => (key: string, ...messages: unknown[]) => {
      emissions.push({
        level,
        key,
        parts: messages.flatMap((message) => {
          const resolved = typeof message === "function" ? message() : message;
          return Array.isArray(resolved) ? resolved : [resolved];
        }),
      });
      // Delegate, so the run under test logs exactly as it would in production
      // (and the logger's own counters stay honest).
      originals[level].call(logger, key, ...messages);
    };
  logger.debug = record("debug");
  logger.warn = record("warn");
  try {
    await fn();
  } finally {
    logger.debug = originals.debug;
    logger.warn = originals.warn;
  }
  return emissions;
};

const skipEmissions = (emissions: Emission[]): Emission[] =>
  emissions.filter((emission) => emission.key === "resume-owned-cells");

/** The identity payload is the trailing record argument of the log call. */
const payloadOf = (emission: Emission): unknown =>
  emission.parts[emission.parts.length - 1];

const childPattern: Pattern = {
  argumentSchema: {},
  resultSchema: {},
  result: {},
  nodes: [],
};

// A sub-pattern node whose whole outputs record holds only a DEFERRED
// partialCause alias. Such an alias denotes a derived internal cell of the
// level it was deferred to, never this node's reserved result spot, so
// firstResolvedOutputRedirect returns undefined for the node as a whole and the
// walk skips it without an error.
const unresolvableOutputsPattern = {
  argumentSchema: {},
  resultSchema: {},
  result: {},
  nodes: [
    {
      description: "sub-pattern node with no resolvable output spot",
      module: { type: "pattern", implementation: childPattern },
      inputs: {},
      outputs: {
        generated: {
          $alias: { partialCause: { "$generated": 0 }, path: [], defer: 1 },
        },
      },
    },
  ],
} as unknown as Pattern;

// A sub-pattern node whose outputs alias the ARGUMENT doc. On a first run the
// result cell has no argument meta link yet, so binding the outputs throws and
// the walk takes its catch exit.
const unbindableOutputsPattern = {
  argumentSchema: {},
  resultSchema: {},
  result: {},
  nodes: [
    {
      description: "sub-pattern node whose outputs alias the argument doc",
      module: { type: "pattern", implementation: childPattern },
      inputs: {},
      outputs: { $alias: { cell: "argument", path: ["child"] } },
    },
  ],
} as unknown as Pattern;

type SkipCase = {
  name: string;
  pattern: Pattern;
  /**
   * Seed the result cell with a prior run, so the run under test resumes a
   * stored root whose argument meta link is already written.
   */
  seedFirst: boolean;
  level: "debug" | "warn";
  message: string;
  node: string;
  /** Parts the call carries ahead of the identity payload. */
  leadingParts: number;
  /** How the run under test is expected to end. */
  rejectsWith?: RegExp;
};

const cases: SkipCase[] = [
  {
    name: "outputs resolve to no write redirect",
    pattern: unresolvableOutputsPattern,
    seedFirst: true,
    level: "debug",
    message:
      "skipping a sub-pattern node whose outputs resolved to no write redirect",
    node: "sub-pattern node with no resolvable output spot",
    leadingParts: 1,
    // The same outputs that gave the walk nothing to resolve also give
    // instantiation nothing to anchor the child's identity on, so the run
    // rejects. Pinned rather than swallowed, so this fixture cannot go green
    // for some later, unrelated reason.
    rejectsWith: /requires a write-redirect output binding/,
  },
  {
    name: "outputs cannot be bound",
    pattern: unbindableOutputsPattern,
    seedFirst: false,
    level: "warn",
    message:
      "skipping a sub-pattern node whose outputs did not bind or resolve",
    node: "sub-pattern node whose outputs alias the argument doc",
    // message, error, payload.
    leadingParts: 2,
  },
];

describe("resume owned-cell walk skip logging", () => {
  for (const testCase of cases) {
    it(`logs at ${testCase.level} when a sub-pattern node's ${testCase.name}`, async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const cause = `owned-cells-skip-log-${testCase.level}`;
      try {
        if (testCase.seedFirst) {
          // A trivial pattern whose setup writes the result cell's argument
          // meta link, so the run under test is a real resume.
          const seedPattern: Pattern = {
            argumentSchema: {},
            resultSchema: {},
            result: {},
            nodes: [],
          };
          const seedRuntime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager,
          });
          const seedCell = seedRuntime.getCell(space, cause);
          await seedRuntime.runSynced(
            seedCell,
            trustExecutable(seedRuntime, seedPattern),
            {},
          );
          await seedCell.pull();
          await seedRuntime.dispose();
        }

        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        const resultCell = runtime.getCell(space, cause);
        const resultCellId = resultCell.getAsNormalizedFullLink().id;
        const emissions = await captureRunnerLog(async () => {
          const run = runtime.runSynced(
            resultCell,
            trustExecutable(runtime, testCase.pattern),
            {},
          );
          if (testCase.rejectsWith !== undefined) {
            await expect(run).rejects.toThrow(testCase.rejectsWith);
          } else {
            await run;
          }
        });
        await runtime.dispose();

        const skips = skipEmissions(emissions);
        const emission = skips.find((candidate) =>
          candidate.parts[0] === testCase.message
        );
        expect(emission).toBeDefined();
        // The level is the finding: the by-design exit must not warn, and the
        // genuine binding failure must.
        expect(emission!.level).toBe(testCase.level);
        expect(emission!.parts.length).toBe(testCase.leadingParts + 1);
        // Asserted as a whole object, so a field that silently stops being
        // populated — `space` and `childPattern` are advertised but only ever
        // read from a production trace — fails here.
        expect(payloadOf(emission!)).toEqual({
          resultCell: resultCellId,
          space,
          nodeIndex: 0,
          node: testCase.node,
          childPattern: "pattern:nodes=0",
        });
        // No emission of the OTHER kind slipped in alongside it.
        expect(skips.every((candidate) => candidate.level === testCase.level))
          .toBe(true);
      } finally {
        await storageManager.close();
      }
    });
  }

  // The negative half, and the reason the undefined exit is a debug: a healthy
  // run of the REAL home pattern takes that exit repeatedly. While it was a
  // warn, this run emitted the warning twice, and CI showed eight occurrences
  // across passing home tests. This fails if the log goes back to warn — and,
  // via the "really does take the exit" assertion, also if the branch stops
  // being reached, so the silence it proves cannot go vacuous.
  it("stays silent at warn level through a healthy home pattern run", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const patternsRoot = join(import.meta.dirname!, "..", "..", "patterns");
      const program = await runtime.harness.resolve(
        new FileSystemProgramResolver(
          join(patternsRoot, "system", "home.tsx"),
          patternsRoot,
        ),
      );
      const homePattern = await runtime.patternManager.compilePattern(program, {
        space,
      });

      const resultCell = runtime.getCell(space, "healthy-home-instance");
      const emissions = await captureRunnerLog(async () => {
        const home = await runtime.runSynced(resultCell, homePattern, {});
        await home.pull();
        await runtime.idle();
      });

      const skips = skipEmissions(emissions);
      // The healthy run really does take the skip exit — otherwise the
      // silence below would prove nothing.
      expect(skips.length).toBeGreaterThan(0);
      expect(skips.filter((emission) => emission.level === "warn")).toEqual([]);
      expect(skips.every((emission) => emission.level === "debug")).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
