import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { SKIP_LIST_VARIABLE } from "@commonfabric/test-support/records";
import { loadPatternSuites } from "./patterns.ts";
import { loadPackageIntegrationSuites } from "./package-integration.ts";
import type { Suite } from "./suite.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const suites = [
  ...await loadPatternSuites(root),
  ...await loadPackageIntegrationSuites(root),
];
const byId = (id: string): Suite => suites.find((s) => s.id === id)!;

/** A directory each case writes its reports and lists into. */
async function outputDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "patterns-suite-" });
}

describe("the pattern and package suites", () => {
  it("runs the chosen files where the package lives", async () => {
    const suite = byId("pattern-integration");
    const [invocation] = await suite.command(
      [{ unit: suite.units[0]!, skip: [] }],
      { root, outputDir: await outputDir() },
    );
    expect(invocation!.cwd).toBe(`${root}/packages/patterns`);
    expect(invocation!.env?.HEADLESS).toBe("1");
    expect(invocation!.junit?.[0]?.scope).toBe("patterns");
  });

  it("runs the server-execution arm with the define set", async () => {
    const suite = byId("pattern-integration-on");
    const [invocation] = await suite.command(
      [{ unit: suite.units[0]!, skip: [] }],
      { root, outputDir: await outputDir() },
    );
    expect(invocation!.env?.EXPERIMENTAL_SERVER_EXECUTION).toBe("true");
    expect(suite.variant).toBe("server-execution");
  });

  it("names a skip list only where a leaf inside a unit is skipped", async () => {
    const suite = byId("pattern-integration");
    const out = await outputDir();
    const unit = suite.units[0]!;
    const [whole] = await suite.command([{ unit, skip: [] }], {
      root,
      outputDir: out,
    });
    expect(whole!.env?.[SKIP_LIST_VARIABLE]).toBeUndefined();
    const [partial] = await suite.command(
      [{ unit, skip: ["counter > counts up"] }],
      { root, outputDir: out },
    );
    const listed = partial!.env?.[SKIP_LIST_VARIABLE];
    expect(listed).toBeDefined();
    expect(JSON.parse(await Deno.readTextFile(listed!))).toEqual({
      [unit]: ["counter > counts up"],
    });
  });

  it("points a measured batch at a directory of its own", async () => {
    const suite = byId("pattern-integration");
    const [invocation] = await suite.command(
      [{ unit: suite.units[0]!, skip: [] }],
      { root, outputDir: await outputDir(), coverageDir: "/cov" },
    );
    expect(invocation!.env?.DENO_COVERAGE_DIR).toBe(
      "/cov/pattern-integration-patterns",
    );
  });

  it("runs one invocation per package the suite spans", async () => {
    // The three packages share a command shape and a server, and each
    // records under its own scope, so a batch holding files from two of
    // them runs twice and reports twice.
    const suite = byId("package-integration");
    const runner = suite.units.find((u) => u.startsWith("packages/runner/"))!;
    const shell = suite.units.find((u) => u.startsWith("packages/shell/"))!;
    const made = await suite.command(
      [{ unit: runner, skip: [] }, { unit: shell, skip: [] }],
      { root, outputDir: await outputDir() },
    );
    expect(made.length).toBe(2);
    expect(made.map((i) => i.junit?.[0]?.scope).toSorted())
      .toEqual(["runner", "shell"]);
  });

  it("gives the reload suite its own unit and its own task", async () => {
    // Its task brings the whole local development stack up around the
    // run and hard-codes the directory it walks, so a lane can ask for
    // the suite or not, and nothing finer.
    const suite = byId("pattern-reload");
    expect(suite.units).toEqual(["packages/patterns/integration/reload"]);
    const [invocation] = await suite.command(
      [{ unit: suite.units[0]!, skip: [] }],
      { root, outputDir: "/out" },
    );
    expect(invocation!.command).toContain("patterns-reload");
    expect(await suite.command([], { root, outputDir: "/out" })).toEqual([]);
  });

  it("locates a reload record by the directory it came from", () => {
    const suite = byId("pattern-reload");
    expect(
      suite.locate({
        test: { k: "integration", s: "patterns", n: "reloads" },
        file: "packages/patterns/integration/reload/default-app.test.ts",
      }),
    ).toEqual({ level: "unit", unit: "packages/patterns/integration/reload" });
    // A file elsewhere under the same scope belongs to the integration
    // suite, which claims it by being the suite that enumerates it.
    expect(
      suite.locate({
        test: { k: "integration", s: "patterns", n: "counts" },
        file: "packages/patterns/integration/counter.test.ts",
      }),
    ).toBeUndefined();
  });

  it("hands the pattern unit tests the files it was given", async () => {
    // A selected set is a list of unrelated paths and no substring
    // filter expresses one, so the files travel in a file.
    const suite = byId("pattern-unit");
    const out = await outputDir();
    const chosen = suite.units.slice(0, 2);
    const [invocation] = await suite.command(
      chosen.map((unit) => ({ unit, skip: [] })),
      { root, outputDir: out },
    );
    const flag = invocation!.command.find((arg) => arg.startsWith("--files="))!;
    const listed = await Deno.readTextFile(flag.slice("--files=".length));
    expect(listed.trim().split("\n")).toEqual(chosen);
  });

  it("names a pattern test by its own path", () => {
    const suite = byId("pattern-unit");
    const unit = suite.units[0]!;
    expect(suite.locate({ test: { k: "pattern", s: "patterns", n: unit } }))
      .toEqual({ level: "unit", unit });
    expect(
      suite.locate({
        test: { k: "pattern", s: "patterns", n: "gone.test.tsx" },
      }),
    ).toBeUndefined();
  });

  it("builds nothing for a suite asked for no units", async () => {
    for (const id of ["pattern-unit", "generated-patterns"]) {
      expect(await byId(id).command([], { root, outputDir: "/out" }))
        .toEqual([]);
    }
  });
});
