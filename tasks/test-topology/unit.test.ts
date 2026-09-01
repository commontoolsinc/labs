import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { SKIP_LIST_VARIABLE } from "@commonfabric/test-support/records";
import { loadUnitSuites } from "./unit.ts";
import type { Suite } from "./suite.ts";

/** A workspace holding the members a case describes. */
async function workspace(
  members: Record<
    string,
    { tasks: Record<string, unknown>; files?: readonly string[] }
  >,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "unit-suite-" });
  await Deno.writeTextFile(
    `${root}/deno.jsonc`,
    JSON.stringify({ workspace: Object.keys(members) }, null, 2),
  );
  for (const [member, contents] of Object.entries(members)) {
    const dir = `${root}/${member}`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ tasks: contents.tasks }, null, 2),
    );
    for (const file of contents.files ?? []) {
      const at = `${dir}/${file}`;
      await Deno.mkdir(at.slice(0, at.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(at, "");
    }
  }
  return root;
}

/** The workspace suite of a loaded pair. */
function workspaceUnit(suites: readonly Suite[]): Suite {
  return suites.find((suite) => suite.id === "workspace-unit")!;
}

describe("the workspace unit suites", () => {
  it("makes a file a unit where the member's task takes a subset", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test --allow-read test/*.test.ts" },
        files: ["test/glaze.test.ts", "test/proof.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).toEqual([
      "packages/bakery/test/glaze.test.ts",
      "packages/bakery/test/proof.test.ts",
    ]);
  });

  it("makes the member one unit where its task cannot", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno run --allow-read test/run-tests.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).toEqual(["packages/bakery"]);
  });

  it("gives a browser half a unit of its own", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: { dependencies: ["deno-test", "browser-test"] },
          "deno-test": "deno test --allow-read test/*.test.ts",
          "browser-test": "deno run -A ../deno-web-test/cli.ts oven.test.ts",
        },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).toEqual([
      "packages/bakery/test/glaze.test.ts",
      "packages/bakery#browser-test",
    ]);
  });

  it("leaves a member that says it has no tests out entirely", async () => {
    const root = await workspace({
      "./packages/bakery": { tasks: { test: "echo 'No tests defined.'" } },
    });
    expect(workspaceUnit(await loadUnitSuites(root)).units).toEqual([]);
  });

  it("puts the runner package in a suite of its own", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
      "./packages/runner": {
        tasks: { test: "deno test --no-check test/cell.test.ts" },
        files: ["test/cell.test.ts"],
      },
    });
    const suites = await loadUnitSuites(root);
    expect(suites.map((suite) => suite.id)).toEqual([
      "workspace-unit",
      "runner-unit",
    ]);
    expect(suites[1]!.units).toEqual(["packages/runner/test/cell.test.ts"]);
  });

  it("locates a record by the file its producer recorded", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(
      suite.locate({
        test: { k: "unit", s: "bakery", n: "glaze > sets" },
        file: "packages/bakery/test/glaze.test.ts",
      }),
    ).toEqual({ level: "unit", unit: "packages/bakery/test/glaze.test.ts" });
  });

  it("declines a record carrying a variant it does not run", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(
      suite.locate({
        test: {
          k: "unit",
          s: "bakery",
          n: "glaze > sets",
          v: "server-execution",
        },
        file: "packages/bakery/test/glaze.test.ts",
      }),
    ).toBeUndefined();
  });

  it("declines a record whose file the tree no longer holds", async () => {
    // An identity whose file moved is unknown, and an unknown identity
    // runs; placing it on a unit that no longer exists would not.
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(
      suite.locate({
        test: { k: "unit", s: "bakery", n: "icing > sets" },
        file: "packages/bakery/test/icing.test.ts",
      }),
    ).toBeUndefined();
  });

  it("runs the chosen files with the member's own flags", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "ENV=test deno test --no-check test/*.test.ts" },
        files: ["test/glaze.test.ts", "test/proof.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const outputDir = await Deno.makeTempDir({ prefix: "unit-out-" });
    const [invocation] = await suite.command(
      [{ unit: "packages/bakery/test/glaze.test.ts", skip: [] }],
      { root, outputDir },
    );
    expect(invocation!.command).toContain("--no-check");
    expect(invocation!.command).toContain("test/glaze.test.ts");
    expect(invocation!.command).not.toContain("test/proof.test.ts");
    expect(invocation!.env?.ENV).toBe("test");
    expect(invocation!.junit?.[0]?.scope).toBe("bakery");
  });

  it("names a skip list only where something inside a unit is skipped", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const outputDir = await Deno.makeTempDir({ prefix: "unit-out-" });
    const [whole] = await suite.command(
      [{ unit: "packages/bakery/test/glaze.test.ts", skip: [] }],
      { root, outputDir },
    );
    expect(whole!.env?.[SKIP_LIST_VARIABLE]).toBeUndefined();

    const [partial] = await suite.command(
      [{
        unit: "packages/bakery/test/glaze.test.ts",
        skip: ["glaze > sets overnight"],
      }],
      { root, outputDir },
    );
    const listPath = partial!.env?.[SKIP_LIST_VARIABLE];
    expect(listPath).toBeDefined();
    expect(JSON.parse(await Deno.readTextFile(listPath!))).toEqual({
      "packages/bakery/test/glaze.test.ts": ["glaze > sets overnight"],
    });
  });
});

describe("running a member that cannot be handed a subset", () => {
  it("runs the member's own task, and the skip list still reaches inside", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno run --allow-read test/run-tests.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const outputDir = await Deno.makeTempDir({ prefix: "unit-out-" });
    const [invocation] = await suite.command(
      [{ unit: "packages/bakery", skip: ["glaze > sets overnight"] }],
      { root, outputDir },
    );
    expect(invocation!.command).toEqual([Deno.execPath(), "task", "test"]);
    // The environment a task inherits is how the list reaches a member
    // whose command line cannot be changed.
    expect(invocation!.env?.[SKIP_LIST_VARIABLE]).toBeDefined();
  });

  it("runs the browser half through the task that owns it", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: { dependencies: ["deno-test", "browser-test"] },
          "deno-test": "deno test --allow-read test/*.test.ts",
          "browser-test": "deno run -A ../deno-web-test/cli.ts oven.test.ts",
        },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const outputDir = await Deno.makeTempDir({ prefix: "unit-out-" });
    const made = await suite.command(
      [
        { unit: "packages/bakery#browser-test", skip: [] },
        { unit: "packages/bakery/test/glaze.test.ts", skip: [] },
      ],
      { root, outputDir, coverageDir: "/cov" },
    );
    expect(made.length).toBe(2);
    expect(made.some((i) => i.command.includes("browser-test"))).toBe(true);
    // Each member's profiles go somewhere of their own, which is what
    // lets the per-package figures be added up afterwards.
    expect(made[0]!.env?.DENO_COVERAGE_DIR).toBe("/cov/bakery");
  });

  it("locates a browser record on the half that produced it", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: { dependencies: ["deno-test", "browser-test"] },
          "deno-test": "deno test test/glaze.test.ts",
          "browser-test": "deno run -A ../deno-web-test/cli.ts oven.test.ts",
        },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(
      suite.locate({ test: { k: "browser", s: "bakery", n: "oven > heats" } }),
    ).toEqual({ level: "unit", unit: "packages/bakery#browser-test" });
  });

  it("gives a member with only a browser half no whole-member unit", async () => {
    // There is no Deno-only task for a `deno task test` to run, so a
    // whole-member unit would dispatch a task that does not exist.
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          "browser-test": "deno run -A ../deno-web-test/cli.ts a.test.ts",
        },
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).toEqual(["packages/bakery#browser-test"]);
  });

  it("builds nothing for a unit no member holds", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(
      await suite.command([{ unit: "packages/elsewhere", skip: [] }], {
        root,
        outputDir: "/out",
      }),
    ).toEqual([]);
  });
});
