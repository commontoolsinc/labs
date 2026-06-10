import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type Opaque } from "../src/builder/types.ts";
import { parseLink } from "../src/link-utils.ts";

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
        pattern(({ element }: Opaque<any>) => double(element)),
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
    // link-origin pointer labels stay out of J; link-covered and
    // pure-link-structure writes aren't stamped) keeps the coordinator's
    // scaffolding from smearing one element's taint onto the other.
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
});
