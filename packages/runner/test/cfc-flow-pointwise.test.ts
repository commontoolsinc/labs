import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type FactoryInput } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-flow-pointwise");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
};

// S16 phase B: pointwise label precision is a structural fact of the
// per-element transaction decomposition (design D4), not a trusted claim.
// These tests pin the split: element results carry only their element's
// taint; the result container carries only structure-level taint — and for
// filter, the membership decision's taint (§8.5.6.1) arrives via the
// predicate outputs the coordinator consumes.
describe("CFC flow labels: pointwise structure (phase B)", () => {
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

  const derivedConfidentiality = (id: string): string[] =>
    entriesOf(id)
      .filter((e) => e.origin === "derived")
      .flatMap((e) => e.label.confidentiality ?? []);

  // Element ops run in their own transactions reading only their element,
  // so per-element precision is structural — for elements that arrive in
  // separate reconciles. A batch first-instantiation evaluates all new
  // element ops inline in ONE pattern-run transaction, whose J is then the
  // join of every new element (coarse but sound; it refines as elements
  // are touched individually). This test exercises the incremental path:
  // el0 instantiates first, el1 arrives later, and each element's result
  // carries exactly its own taint.
  it("map: incrementally added elements get pointwise derived labels", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "pointwise-el-0", { n: 1 }, "alice-secret");
    await seedLabeledDoc(runtime, "pointwise-el-1", { n: 2 }, "bob-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const double = lift((value: { n: number }) => ({ doubled: value.n * 2 }));
    let mappedRef: any;

    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "pointwise-el-0", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "pointwise-list",
      {
        type: "array",
        items: { asCell: ["cell"] },
      },
      setup,
    );
    listCell.set([el0]);
    expect((await setup.commit()).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      mappedRef = (values as any).mapWithPattern(
        pattern(({ element }: FactoryInput<any>) => double(element)),
        {},
      );
      return { mapped: mappedRef };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "pointwise-list", undefined, tx);
    const resultCell = runtime.getCell(
      space,
      "pointwise-map-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    await tx.commit();
    await result.pull();
    await runtime.idle();

    // Second element arrives in its own reconcile: the update transaction
    // only shuffles links (no content reads), and el1's op instantiates in
    // a transaction that never read el0.
    const grow = runtime.edit();
    const el0Again = runtime.getCell(space, "pointwise-el-0", undefined, grow);
    const el1 = runtime.getCell(space, "pointwise-el-1", undefined, grow);
    runtime.getCell(space, "pointwise-list", {
      type: "array",
      items: { asCell: ["cell"] },
    }, grow).set([el0Again, el1]);
    expect((await grow.commit()).ok).toBeDefined();
    await result.pull();
    await runtime.idle();

    const mapped = (result.key("mapped") as any).get() as Array<
      { doubled: number }
    >;
    expect(mapped.map((m) => m?.doubled)).toEqual([2, 4]);

    // Reader-visible pointwise check: a consumer of mapped[i] picks up
    // exactly element i's taint. (Asserting on specific internal docs is
    // brittle — content lands in different docs on the inline-first-run vs
    // steady-state paths; what matters is what a reader's derivation
    // joins.) The blind-passing split (link-resolution probes and
    // link-origin pointer labels stay out of J; link-covered writes aren't
    // stamped; pure-link-structure writes get exact-path `structure`
    // stamps that slot reads below them never join) keeps the
    // coordinator's scaffolding from smearing one element's taint onto
    // the other — this test also pins that the batch first-run's coarse J
    // landing on the container as shape taint does NOT leak back into
    // later per-element results.
    const probe = async (index: number, cause: string): Promise<string[]> => {
      const ptx = runtime!.edit();
      const value = (result.key("mapped") as any).key(index).withTx(ptx)
        .get() as { doubled: number };
      const out = runtime!.getCell(space, cause, undefined, ptx);
      out.set({ copied: value.doubled });
      ptx.prepareCfc();
      expect((await ptx.commit()).ok).toBeDefined();
      return derivedConfidentiality(out.getAsNormalizedFullLink().id);
    };

    const conf0 = await probe(0, "pointwise-probe-0");
    const conf1 = await probe(1, "pointwise-probe-1");
    expect(conf0).toContainEqual("alice-secret");
    expect(conf0).not.toContainEqual("bob-secret");
    expect(conf1).toContainEqual("bob-secret");
    expect(conf1).not.toContainEqual("alice-secret");
  });

  // §8.5.6.1 membership taint: which elements survive a filter is decided
  // by the predicate outputs, and those are values the coordinator reads —
  // so the filtered container's derived component must join the predicate
  // taint of every element it considered. (No flow-precision claims
  // needed: the membership channel rides ordinary value reads.)
  it("filter: membership structure carries the predicate outputs' taint", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "memb-el-0", { n: 1 }, "alice-secret");
    await seedLabeledDoc(runtime, "memb-el-1", { n: 2 }, "bob-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const isPositive = lift((value: { n: number }) => value.n > 0);
    let filteredRef: any;

    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "memb-el-0", undefined, setup);
    const el1 = runtime.getCell(space, "memb-el-1", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "memb-list",
      {
        type: "array",
        items: { asCell: ["cell"] },
      },
      setup,
    );
    listCell.set([el0, el1]);
    expect((await setup.commit()).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      filteredRef = (values as any).filterWithPattern(
        pattern(({ element }: FactoryInput<any>) => isPositive(element)),
        {},
      );
      return { kept: filteredRef };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "memb-list", undefined, tx);
    const resultCell = runtime.getCell(
      space,
      "memb-filter-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    await tx.commit();
    await result.pull();
    await runtime.idle();

    const kept = (result.key("kept") as any).get() as Array<{ n: number }>;
    expect(kept.length).toBe(2);

    // A consumer of the membership structure (the array shape itself, not
    // any element's content) picks up the predicate taint of every element
    // the filter considered.
    const ptx = runtime.edit();
    const keptLength = ((result.key("kept") as any).withTx(ptx)
      .get() as Array<unknown>).length;
    const out = runtime.getCell(space, "memb-probe", undefined, ptx);
    out.set({ count: keptLength });
    ptx.prepareCfc();
    expect((await ptx.commit()).ok).toBeDefined();
    const probeConf = derivedConfidentiality(
      out.getAsNormalizedFullLink().id,
    );
    expect(probeConf).toContainEqual("alice-secret");
    expect(probeConf).toContainEqual("bob-secret");
  });

  // The membership channel must not require dereferencing (codex review on
  // #4022): a reader that observes only the container's shape — length via
  // an items-as-cell schema, never reading any element's content — still
  // learns which elements survived the predicate. The container write is
  // pure link structure, but its shape is secret-dependent, so the
  // membership taint has to ride the container itself, not just the
  // element contents.
  it("filter: shape-only reader (no dereference) picks up membership taint", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "shape-el-0", { n: 1 }, "alice-secret");
    await seedLabeledDoc(runtime, "shape-el-1", { n: -2 }, "bob-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const isPositive = lift((value: { n: number }) => value.n > 0);
    let filteredRef: any;

    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "shape-el-0", undefined, setup);
    const el1 = runtime.getCell(space, "shape-el-1", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "shape-list",
      {
        type: "array",
        items: { asCell: ["cell"] },
      },
      setup,
    );
    listCell.set([el0, el1]);
    expect((await setup.commit()).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      filteredRef = (values as any).filterWithPattern(
        pattern(({ element }: FactoryInput<any>) => isPositive(element)),
        {},
      );
      return { kept: filteredRef };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "shape-list", undefined, tx);
    const resultCell = runtime.getCell(
      space,
      "shape-filter-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    await tx.commit();
    await result.pull();
    await runtime.idle();

    // Elements stay cells under this schema: the probe reads the array's
    // shape (membership/length) without a single element content read.
    const ptx = runtime.edit();
    const keptCells = (result.key("kept") as any)
      .asSchema({ type: "array", items: { asCell: ["cell"] } })
      .withTx(ptx)
      .get() as unknown[];
    const out = runtime.getCell(space, "shape-probe", undefined, ptx);
    out.set({ count: keptCells.length });
    ptx.prepareCfc();
    expect((await ptx.commit()).ok).toBeDefined();
    const probeConf = derivedConfidentiality(
      out.getAsNormalizedFullLink().id,
    );
    expect(probeConf).toContainEqual("alice-secret");
    expect(probeConf).toContainEqual("bob-secret");
  });

  // The empty-container limit of the membership channel: when the
  // predicate drops EVERY element the write is `[]` — no slot link
  // entries exist at all, so the structure stamp is the only possible
  // carrier and "nothing survived" must still be as confidential as the
  // values that decided it.
  it("filter: empty result still carries membership taint on its shape", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "empty-el-0", { n: -1 }, "alice-secret");
    await seedLabeledDoc(runtime, "empty-el-1", { n: -2 }, "bob-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, lift } = commonfabric as unknown as {
      pattern: typeof commonfabric.pattern;
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const isPositive = lift((value: { n: number }) => value.n > 0);
    let filteredRef: any;

    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "empty-el-0", undefined, setup);
    const el1 = runtime.getCell(space, "empty-el-1", undefined, setup);
    const listCell = runtime.getCell(
      space,
      "empty-list",
      {
        type: "array",
        items: { asCell: ["cell"] },
      },
      setup,
    );
    listCell.set([el0, el1]);
    expect((await setup.commit()).ok).toBeDefined();

    const collectionPattern = pattern<{ values: unknown[] }>(({ values }) => {
      filteredRef = (values as any).filterWithPattern(
        pattern(({ element }: FactoryInput<any>) => isPositive(element)),
        {},
      );
      return { kept: filteredRef };
    });

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, "empty-list", undefined, tx);
    const resultCell = runtime.getCell(
      space,
      "empty-filter-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesIn },
      resultCell,
    );
    await tx.commit();
    await result.pull();
    await runtime.idle();

    const ptx = runtime.edit();
    const keptCells = (result.key("kept") as any)
      .asSchema({ type: "array", items: { asCell: ["cell"] } })
      .withTx(ptx)
      .get() as unknown[];
    expect(keptCells.length).toBe(0);
    const out = runtime.getCell(space, "empty-probe", undefined, ptx);
    out.set({ count: keptCells.length });
    ptx.prepareCfc();
    expect((await ptx.commit()).ok).toBeDefined();
    const probeConf = derivedConfidentiality(
      out.getAsNormalizedFullLink().id,
    );
    expect(probeConf).toContainEqual("alice-secret");
    expect(probeConf).toContainEqual("bob-secret");
  });
});
