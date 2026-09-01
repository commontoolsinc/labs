import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { SKIP_LIST_VARIABLE } from "@commonfabric/test-support/records";
import {
  fileSuite,
  unavailableFrom,
  unavailableLeaves,
  unavailableUnits,
} from "./suite.ts";

/** A suite over two packages, one of which skips a leaf. */
function twoParts() {
  return fileSuite({
    id: "package-integration-on",
    variant: "server-execution",
    needs: ["deno"],
    parts: [
      {
        packageDir: "packages/oven",
        flags: ["-A"],
        env: { HEADLESS: "1" },
        junit: {
          kind: "integration",
          scope: "oven",
          filePrefix: "packages/oven",
        },
        files: ["packages/oven/integration/bake.test.ts"],
        unavailable: [{
          unit: "packages/oven/integration/bake.test.ts",
          leafName: "bakes > slowly",
          reason: "the surface that step exercises has not landed",
        }],
      },
      {
        packageDir: "packages/mill",
        flags: ["-A"],
        junit: {
          kind: "integration",
          scope: "mill",
          filePrefix: "packages/mill",
        },
        files: ["packages/mill/integration/grind.test.ts"],
      },
    ],
  });
}

describe("reading a configuration's skip registry", () => {
  it("takes a whole-file entry out and leaves a step entry's file in", () => {
    const { whole, unavailable } = unavailableFrom([
      { file: "a.test.ts", phase: "phase-3", reason: "not landed" },
      {
        file: "b.test.ts",
        step: "bakes > slowly",
        phase: "phase-4",
        reason: "that step is not landed",
      },
    ], "packages/oven");
    expect([...whole]).toEqual(["packages/oven/a.test.ts"]);
    expect(unavailable.map((entry) => entry.leafName)).toEqual([
      undefined,
      "bakes > slowly",
    ]);
    expect(unavailable[0]!.phase).toBe("phase-3");
  });

  it("tells a unit that does not run from a leaf that does not", () => {
    const suite = twoParts();
    // Every other identity in that file still runs, so the file is a
    // unit and only the leaf is unavailable.
    expect([...unavailableUnits(suite)]).toEqual([]);
    expect([...unavailableLeaves(suite)]).toEqual([
      ["packages/oven/integration/bake.test.ts", ["bakes > slowly"]],
    ]);
  });
});

describe("a suite of deno test files over several packages", () => {
  const context = { root: "/repo", outputDir: "/out" };

  it("runs one invocation per package, each with its own report", async () => {
    // A real directory, because the leaf this configuration skips means
    // there is a skip list to write.
    const outputDir = await Deno.makeTempDir({ prefix: "file-suite-" });
    const made = await twoParts().command([
      { unit: "packages/oven/integration/bake.test.ts", skip: [] },
      { unit: "packages/mill/integration/grind.test.ts", skip: [] },
    ], { ...context, outputDir });
    expect(made.map((i) => i.cwd)).toEqual([
      "/repo/packages/oven",
      "/repo/packages/mill",
    ]);
    expect(made.map((i) => i.junit?.[0]?.scope)).toEqual(["oven", "mill"]);
    expect(made[0]!.env?.HEADLESS).toBe("1");
    await Deno.remove(outputDir, { recursive: true });
  });

  it("skips a leaf its configuration declares unavailable", async () => {
    // The declaration is what stops the leaf running, rather than the
    // test file remembering to guard itself.
    const outputDir = await Deno.makeTempDir({ prefix: "file-suite-" });
    const [invocation] = await twoParts().command(
      [{ unit: "packages/oven/integration/bake.test.ts", skip: [] }],
      { ...context, outputDir },
    );
    const listed = invocation!.env?.[SKIP_LIST_VARIABLE];
    expect(listed).toBeDefined();
    expect(JSON.parse(await Deno.readTextFile(listed!))).toEqual({
      "packages/oven/integration/bake.test.ts": ["bakes > slowly"],
    });
    await Deno.remove(outputDir, { recursive: true });
  });

  it("recognizes a record only under its own scope and variant", () => {
    const suite = twoParts();
    const file = "packages/oven/integration/bake.test.ts";
    expect(
      suite.locate({
        test: {
          k: "integration",
          s: "oven",
          n: "bakes",
          v: "server-execution",
        },
        file,
      }),
    ).toEqual({ level: "unit", unit: file });
    // The right variant but the wrong scope for the part holding it.
    expect(
      suite.locate({
        test: {
          k: "integration",
          s: "mill",
          n: "bakes",
          v: "server-execution",
        },
        file,
      }),
    ).toBeUndefined();
    // The right scope but no variant, which belongs to the default suite.
    expect(
      suite.locate({ test: { k: "integration", s: "oven", n: "bakes" }, file }),
    ).toBeUndefined();
  });

  it("builds nothing for a unit it does not hold", async () => {
    expect(await twoParts().command([{ unit: "elsewhere", skip: [] }], context))
      .toEqual([]);
  });
});
