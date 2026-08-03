import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import type { Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

// The resume owned-cell walk (collectResumeOwnedCells) has TWO exits that skip
// the same work — a sub-pattern node's owned-cell pre-sync AND the recursion
// that would reach that child's own derivedInternalCells manifest. One is the
// catch around binding/resolution; the other is the resolution simply coming
// back undefined, which happens when a node's outputs hold no write redirect
// the scan can resolve (outputs consisting only of deferred partialCause
// aliases are the shape seen live). Neither exit may be silent: the pre-sync
// prevents the cold-cache commit-revert race, and a skipped subtree is
// otherwise only discoverable by console probing.
//
// resume-output-redirect-partialcause.test.ts asserts the scan's return value;
// this asserts the consequence at the call site.

const signer = await Identity.fromPassphrase("resume owned cells skip log");
const space = signer.did();

const ownedCellWarns = (): number => {
  const counts = getLoggerCountsBreakdown()["runner"] ?? {};
  return (counts as Record<string, { warn?: number }>)["resume-owned-cells"]
    ?.warn ?? 0;
};

/**
 * Run `fn` with `console.warn` captured. The runner logger writes warns to
 * `console.warn` unless `LOG_TO_STDERR=1`, so that sink is forced off for the
 * duration and restored afterwards.
 */
const captureWarnings = async (
  fn: () => Promise<void>,
): Promise<unknown[][]> => {
  const captured: unknown[][] = [];
  const originalWarn = console.warn;
  const originalStderrFlag = Deno.env.get("LOG_TO_STDERR");
  Deno.env.set("LOG_TO_STDERR", "0");
  console.warn = (...args: unknown[]) => {
    captured.push(args);
  };
  try {
    await fn();
  } finally {
    console.warn = originalWarn;
    if (originalStderrFlag === undefined) Deno.env.delete("LOG_TO_STDERR");
    else Deno.env.set("LOG_TO_STDERR", originalStderrFlag);
  }
  return captured;
};

// A sub-pattern node whose whole outputs record holds only a DEFERRED
// partialCause alias. Such an alias denotes a derived internal cell of the
// level it was deferred to, never this node's reserved result spot, so
// firstResolvedOutputRedirect returns undefined for the node as a whole and the
// walk skips it.
const childPattern: Pattern = {
  argumentSchema: {},
  resultSchema: {},
  result: {},
  nodes: [],
};

const patternWithUnresolvableSubPatternOutputs = {
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

describe("resume owned-cell walk skip logging", () => {
  it("warns, with node identity, when a sub-pattern node's outputs resolve to no redirect", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    try {
      // Seed run: a trivial pattern whose setup writes the result cell's
      // argument meta link, so the resume below is a real resume.
      const seedPattern: Pattern = {
        argumentSchema: {},
        resultSchema: {},
        result: {},
        nodes: [],
      };
      const rt1 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const rc1 = rt1.getCell(space, "owned-cells-skip-log");
      await rt1.runSynced(rc1, trustExecutable(rt1, seedPattern), {});
      await rc1.pull();
      await rt1.dispose();

      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const rc2 = rt2.getCell(space, "owned-cells-skip-log");
      const resultCellId = rc2.getAsNormalizedFullLink().id;
      const before = ownedCellWarns();
      const warnings = await captureWarnings(async () => {
        try {
          await rt2.runSynced(
            rc2,
            trustExecutable(rt2, patternWithUnresolvableSubPatternOutputs),
            {},
          );
        } catch {
          // Instantiation rejects the same outputs (a pattern node needs a
          // write-redirect output binding); the resume walk must already have
          // warned and skipped the node by then.
        }
      });
      expect(ownedCellWarns()).toBeGreaterThan(before);
      await rt2.dispose();

      // The warn must carry enough to act on from a production console trace:
      // which result cell was being resumed, and which node was skipped.
      const rendered = warnings
        .filter((args) => args.some((a) => a === "resume-owned-cells"))
        .map((args) => JSON.stringify(args));
      expect(rendered.length).toBeGreaterThan(0);
      const skipLine = rendered.find((line) =>
        line.includes("resolved to no write redirect")
      );
      expect(skipLine).toBeDefined();
      expect(skipLine).toContain(resultCellId);
      expect(skipLine).toContain('"nodeIndex":0');
      expect(skipLine).toContain(
        "sub-pattern node with no resolvable output spot",
      );
    } finally {
      await storageManager.close();
    }
  });
});
