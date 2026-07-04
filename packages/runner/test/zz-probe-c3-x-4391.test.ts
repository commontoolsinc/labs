import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type FactoryInput } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-probe-c3-x-4391");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

// PROBE (scratch, not for landing): observes the composed C3(#4525) x
// PR4391 label discipline on a filter container across the two reconcile
// shapes — root value-written (C3 fold path) vs no-write re-stamp (4391
// splice path). Prints the container's root entries after each phase; the
// assertions are deliberately loose (the probe reports, the reader judges).
describe("PROBE: C3 fold x 4391 re-stamp on filter containers", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const seedLabeledDoc = async (
    rt: Runtime,
    cause: string,
    value: unknown,
    atom: string,
  ): Promise<string> => {
    const seed = rt.edit();
    const cell = rt.getCell(space, cause, undefined, seed);
    const id = cell.getAsNormalizedFullLink().id;
    seed.writeOrThrow({
      space,
      scope: "space",
      id,
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: "seed-schema",
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [atom] } }],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();
    return id;
  };

  const entriesOf = (id: string): StoredEntry[] => {
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica!.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const rootEntriesReport = (id: string): string =>
    entriesOf(id)
      .filter((e) => e.path.length === 0)
      .map((e) =>
        `${e.origin}/${e.observes ?? "covering"}: [${
          (e.label.confidentiality ?? []).join(", ")
        }]`
      )
      .join("\n    ") || "(no root entries)";

  const resolvedContainerId = (keptCell: unknown): string => {
    const rtx = runtime!.edit();
    const id = (keptCell as {
      withTx: (tx: unknown) => {
        resolveAsCell: () => {
          getAsNormalizedFullLink: () => { id: string };
        };
      };
    }).withTx(rtx).resolveAsCell().getAsNormalizedFullLink().id;
    rtx.commit();
    return id;
  };

  it("PROBE A: member leaves the list (root value-written each change)", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "pa-el-0", { n: 1 }, "alice-secret");
    await seedLabeledDoc(runtime, "pa-el-1", { n: 2 }, "bob-secret");
    await seedLabeledDoc(runtime, "pa-el-2", { n: 3 }, "carol-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: { n: number }) => unknown) => (
        value: unknown,
      ) => unknown;
    };
    const isPositive = lift((value: { n: number }) => value.n > 0);

    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "pa-el-0", undefined, setup);
    const el1 = runtime.getCell(space, "pa-el-1", undefined, setup);
    const el2 = runtime.getCell(space, "pa-el-2", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "pa-list",
      { type: "array", items: { asCell: ["cell"] } },
      setup,
    );
    listCell.set([el0, el1]);
    expect((await setup.commit()).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      const kept = (values as unknown as {
        filterWithPattern: (op: unknown, params: unknown) => unknown;
      }).filterWithPattern(
        pattern(({ element }: FactoryInput<any>) => isPositive(element)),
        {},
      );
      return { kept };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "pa-list", undefined, tx);
    const resultCell = runtime.getCell(space, "pa-result", undefined, tx);
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    await tx.commit();
    await result.pull();
    await runtime.idle();

    const containerId = resolvedContainerId(result.key("kept"));
    console.log(
      `\n  [A1] list=[alice, bob], both kept:\n    ${
        rootEntriesReport(containerId)
      }`,
    );

    // bob's element leaves the list entirely (shrink -> root value write).
    const stx = runtime.edit();
    const lc1 = runtime.getCell(
      space,
      "pa-list",
      { type: "array", items: { asCell: ["cell"] } },
      stx,
    );
    lc1.set([el0]);
    expect((await stx.commit()).ok).toBeDefined();
    await result.pull();
    await runtime.idle();
    console.log(
      `  [A2] list shrunk to [alice] (bob gone; predicate no longer reads him):\n    ${
        rootEntriesReport(containerId)
      }`,
    );

    // A further membership change (append carol) -> another root write ->
    // another C3 fold cycle over whatever the stored entries now hold.
    const gtx = runtime.edit();
    const lc2 = runtime.getCell(
      space,
      "pa-list",
      { type: "array", items: { asCell: ["cell"] } },
      gtx,
    );
    lc2.set([el0, el2]);
    expect((await gtx.commit()).ok).toBeDefined();
    await result.pull();
    await runtime.idle();
    console.log(
      `  [A3] list now [alice, carol] (bob two reconciles gone):\n    ${
        rootEntriesReport(containerId)
      }\n`,
    );

    expect(entriesOf(containerId).length).toBeGreaterThan(0);
  });

  it("PROBE B: swap under a stable-empty result (no root write -> 4391 splice path)", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "pb-el-0", { n: 1 }, "dave-secret");
    await seedLabeledDoc(runtime, "pb-el-1", { n: 2 }, "erin-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: { n: number }) => unknown) => (
        value: unknown,
      ) => unknown;
    };
    // Reads element content, drops everything: result stays [].
    const dropAll = lift((value: { n: number }) => value.n < 0);

    const setup = runtime.edit();
    const d0 = runtime.getCell(space, "pb-el-0", undefined, setup);
    const d1 = runtime.getCell(space, "pb-el-1", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "pb-list",
      { type: "array", items: { asCell: ["cell"] } },
      setup,
    );
    listCell.set([d0]);
    expect((await setup.commit()).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      const kept = (values as unknown as {
        filterWithPattern: (op: unknown, params: unknown) => unknown;
      }).filterWithPattern(
        pattern(({ element }: FactoryInput<any>) => dropAll(element)),
        {},
      );
      return { kept };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "pb-list", undefined, tx);
    const resultCell = runtime.getCell(space, "pb-result", undefined, tx);
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    await tx.commit();
    await result.pull();
    await runtime.idle();

    const containerId = resolvedContainerId(result.key("kept"));
    console.log(
      `\n  [B1] list=[dave], result [] (dave considered+dropped):\n    ${
        rootEntriesReport(containerId)
      }`,
    );

    // Swap the sole element: result stays [] -> set([]) diffs clean -> no
    // root value write -> the re-stamp rides 4391's declared-container path.
    const stx = runtime.edit();
    const lc = runtime.getCell(
      space,
      "pb-list",
      { type: "array", items: { asCell: ["cell"] } },
      stx,
    );
    lc.set([d1]);
    expect((await stx.commit()).ok).toBeDefined();
    await result.pull();
    await runtime.idle();
    console.log(
      `  [B2] list swapped to [erin], result still [] (no root write):\n    ${
        rootEntriesReport(containerId)
      }\n`,
    );

    expect(entriesOf(containerId).length).toBeGreaterThan(0);
  });
});
