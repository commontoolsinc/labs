import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Module, Pattern } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

/**
 * PR E1 legacy-read canary (docs/specs/content-addressed-action-identity.md):
 * serialized graphs persisted BEFORE the writer flip carry `implementationRef`
 * with the function body omitted — in two vintages:
 *
 *  - `preC` (pre-#4009): `implementationRef` only; resolution goes through the
 *    legacy verified-function registry, repopulated when the module
 *    re-evaluates.
 *  - `dualWrite` (#4009..E1): `implementationRef` + `$implRef`; resolution
 *    prefers the content-addressed index.
 *
 * The fixture was captured from the pre-flip writer and committed verbatim
 * (test/fixtures/pre-flip-serialized-module.json). Both vintages must keep
 * loading and EXECUTING for as long as stored data can carry them — this test
 * is the tripwire against deleting a read path that persisted data still
 * needs (it pins the legacy registry path through PR E2's deletions).
 */

const signer = await Identity.fromPassphrase("pre-flip-graph-canary");
const space = signer.did();

const fixture = JSON.parse(
  Deno.readTextFileSync(
    new URL("./fixtures/pre-flip-serialized-module.json", import.meta.url),
  ),
) as {
  program: RuntimeProgram;
  modules: Record<string, Record<string, unknown>>;
};

describe("pre-flip serialized-graph canary", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const setup = async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "observe",
    });
    // Re-evaluating the SAME program bytes is the precondition the legacy
    // path always had: it re-runs the builder, re-mints the (content-derived)
    // refs, and repopulates the registry + identity index.
    const pattern = await runtime.patternManager.compilePattern(
      fixture.program,
    ) as Pattern;
    await runtime.idle();
    return pattern;
  };

  const runWithFixtureModule = async (
    pattern: Pattern,
    fixtureModule: Record<string, unknown>,
    cause: string,
  ) => {
    // Swap the live handler module for the PERSISTED pre-flip JSON, exactly
    // what instantiation sees when a stored graph rehydrates: a plain-data
    // module with refs and no live (or stringified) implementation.
    const nodes = pattern.nodes.map((node) =>
      (node.module as Module).type === "javascript" &&
        (node.module as Module).wrapper === "handler"
        ? { ...node, module: fixtureModule as unknown as Module }
        : node
    );
    expect(nodes.some((n) => n.module === fixtureModule as unknown)).toBe(
      true,
    );
    const rehydrated = { ...pattern, nodes } as unknown as Pattern;

    const tx = runtime!.edit();
    const resultCell = runtime!.getCell<{ count: number }>(
      space,
      cause,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const r = runtime!.run(tx, rehydrated, {}, resultCell) as any;
    await tx.commit();
    await r.pull();

    r.key("bump").send({ by: 2 });
    await runtime!.idle();
    return r.key("count").get() as number;
  };

  it("pre-#4009 vintage (implementationRef only, omitted body) still executes", async () => {
    const pattern = await setup();
    const module = fixture.modules.preC;
    expect(typeof module.implementationRef).toBe("string");
    expect("$implRef" in module).toBe(false);
    expect("implementation" in module).toBe(false);

    const count = await runWithFixtureModule(pattern, module, "canary-pre-c");
    expect(count).toBe(2);
  });

  it("dual-write vintage (implementationRef + $implRef, omitted body) still executes", async () => {
    const pattern = await setup();
    const module = fixture.modules.dualWrite;
    expect(typeof module.implementationRef).toBe("string");
    expect(module.$implRef).toBeDefined();
    expect("implementation" in module).toBe(false);

    const count = await runWithFixtureModule(
      pattern,
      module,
      "canary-dual-write",
    );
    expect(count).toBe(2);
  });

  it("the re-evaluated builder re-mints the fixture's exact implementationRef", async () => {
    // The legacy path's load-bearing property: refs are content-derived, so a
    // fresh evaluation of identical bytes registers the SAME ref the stored
    // graph carries. If this breaks, both vintage tests above fail for the
    // pre-C vintage — this assertion just makes the cause obvious.
    const pattern = await setup();
    const node = pattern.nodes.find((n) =>
      (n.module as Module).type === "javascript" &&
      (n.module as Module).wrapper === "handler"
    );
    expect(node).toBeDefined();
    const liveRef = (node!.module as { implementationRef?: string })
      .implementationRef;
    expect(liveRef).toBe(fixture.modules.preC.implementationRef);
  });
});
