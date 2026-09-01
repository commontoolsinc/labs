import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { loadCliSuites } from "./cli.ts";
import type { Suite } from "./suite.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const suites = await loadCliSuites(root);
const byId = (id: string): Suite => suites.find((s) => s.id === id)!;
const context = { root, outputDir: "/out" };

describe("the command-line suites", () => {
  it("names a unit for the record its step writes", () => {
    // The store speaks in identities, so a unit is named the way its
    // record will be, and the arm that runs it is what the command
    // reaches for.
    expect(byId("cli-core").units).toContain(
      "integration.sh verbs-walkthrough",
    );
    expect(byId("cli-core").units).toContain("acl.sh");
  });

  it("dispatches the arm that runs one step alone", async () => {
    const [invocation] = await byId("cli-core").command(
      [{ unit: "integration.sh verbs-walkthrough", skip: [] }],
      context,
    );
    expect(invocation!.command).toEqual(["./integration/integration.sh"]);
    expect(invocation!.env?.CF_CLI_INTEGRATION_SECTION).toBe("verbs");
    expect(invocation!.cwd).toBe(`${root}/packages/cli`);
  });

  it("runs a standalone script as itself", async () => {
    const [invocation] = await byId("cli-core").command(
      [{ unit: "acl.sh", skip: [] }],
      context,
    );
    expect(invocation!.command).toEqual(["./integration/acl.sh"]);
    expect(invocation!.env?.CF_CLI_INTEGRATION_SECTION).toBeUndefined();
  });

  it("holds the script's whole-invocation record to the suite", () => {
    // It measures the invocation rather than any one step, and the same
    // identity appears whichever arm dispatched it, so summing it with
    // its own steps would count them twice.
    expect(
      byId("cli-core").locate({
        test: { k: "integration", s: "cli", n: "integration.sh" },
      }),
    ).toEqual({ level: "suite" });
  });

  it("keeps the three suites' records apart by name", () => {
    const [core, fuse, deno] = ["cli-core", "cli-fuse", "cli-deno"].map(byId);
    const step = { k: "integration", s: "cli", n: "fuse-exec.sh mounts" };
    expect(fuse.locate({ test: step })).toEqual({
      level: "unit",
      unit: "fuse-exec.sh",
    });
    expect(core.locate({ test: step })).toBeUndefined();
    expect(deno.locate({ test: step })).toBeUndefined();
  });

  it("runs the FUSE script whole, because it cannot be asked for less", async () => {
    const fuse = byId("cli-fuse");
    expect(fuse.units).toEqual(["fuse-exec.sh"]);
    const [invocation] = await fuse.command(
      [{ unit: "fuse-exec.sh", skip: [] }],
      context,
    );
    expect(invocation!.command).toEqual(["./integration/fuse-exec.sh"]);
    expect(await fuse.command([], context)).toEqual([]);
  });

  it("accounts for the scripts its steps call", () => {
    const sources = byId("cli-core").sources ?? [];
    expect(sources).toContain("packages/cli/integration/integration.sh");
    expect(sources).toContain("packages/cli/integration/verbs-over-the-cli.sh");
    // The FUSE script is its own suite's to account for.
    expect(sources).not.toContain("packages/cli/integration/fuse-exec.sh");
    expect(byId("cli-fuse").sources).toEqual([
      "packages/cli/integration/fuse-exec.sh",
    ]);
  });

  it("builds nothing for a unit it does not hold", async () => {
    expect(
      await byId("cli-core").command([{ unit: "nope", skip: [] }], context),
    )
      .toEqual([]);
  });
});
