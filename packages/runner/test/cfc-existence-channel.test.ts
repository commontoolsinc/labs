import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { resolveLink } from "../src/link-resolution.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("runner-cfc-existence-channel");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

// Epic C stage C3 — the two channel fixes (C0 §5, SC-4; C0 §4 row 3, SC-8).
//
// SC-4: §8.12.8 replace-on-overwrite is a VALUE-class rule. The existence
// (shape) channel must never shrink: "this path was once written under J"
// reveals every historical writer, so on overwrite the existence entry GROWS
// (join of old and new confidentiality) — where before C3 the flow-clear
// dropped it with the rest of the per-value components and a clean overwrite
// made the existence bit public.
describe("CFC existence channel (C3, SC-4 grow-on-overwrite)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const makeRuntime = () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });
    return runtime;
  };

  const seedDoc = async (
    rt: Runtime,
    cause: string,
    value: unknown,
    entries: LabelMapEntry[],
  ): Promise<string> => {
    const seed = rt.edit();
    const cell = rt.getCell(space, cause, undefined, seed);
    const id = cell.getAsNormalizedFullLink().id;
    seed.writeOrThrow({ space, scope: "space", id, path: [] }, {
      value,
      cfc: {
        version: 1,
        schemaHash: "seed-schema",
        labelMap: { version: 1, entries },
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
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const readAddress = (id: string, path: string[]) => ({
    space,
    scope: "space" as const,
    id: id as `${string}:${string}`,
    type: "application/json" as const,
    path: ["value", ...path],
  });

  const uri = (id: string) => id as `${string}:${string}`;

  // Root-writes `value` into a fresh doc while consuming `sourceId`,
  // returning the new doc's id. Root writeOrThrow: leaf-diffing set() would
  // not cover the stamped path on the later overwrite.
  const writeTainted = async (
    rt: Runtime,
    sourceId: string | undefined,
    outCause: string,
    value: Record<string, unknown>,
    writePath: string[] = [],
  ): Promise<string> => {
    const tx = rt.edit();
    if (sourceId !== undefined) {
      tx.readOrThrow(readAddress(sourceId, []));
    }
    const out = rt.getCell(space, outCause, undefined, tx);
    const outId = out.getAsNormalizedFullLink().id;
    tx.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", ...writePath] },
      value,
    );
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    return outId;
  };

  const shapeEntriesAt = (id: string, path: string[]): StoredEntry[] =>
    entriesOf(id).filter((e) =>
      e.observes === "shape" && e.path.join("/") === path.join("/")
    );

  // The SC-4 red case: a clean overwrite (nothing labeled read) previously
  // erased the whole derived pair — the existence bit went public. The
  // existence entry must survive, still carrying the old writer's J.
  it("clean overwrite keeps the existence label (today it vanishes)", async () => {
    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ec-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    const outId = await writeTainted(rt, sourceId, "ec-clean-out", {
      copied: true,
    });
    expect(shapeEntriesAt(outId, [])[0]?.label.confidentiality).toEqual([
      "secret",
    ]);

    // Clean overwrite: reads nothing labeled, root-overwrites the doc.
    const tx = rt.edit();
    tx.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { copied: false },
    );
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const shape = shapeEntriesAt(outId, []);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toContainEqual("secret");
    // The value channel legitimately lowered: no secret-carrying value
    // entry survives the clean recomputation (§8.12.8 replace).
    const valueEntries = entriesOf(outId).filter((e) => e.observes === "value");
    for (const entry of valueEntries) {
      expect(entry.label.confidentiality ?? []).not.toContainEqual("secret");
    }
  });

  // A labeled overwrite: value replaces (precision win), existence grows
  // (join of old and new — soundness fix).
  it("labeled overwrite: value replaces, existence grows to the join", async () => {
    const rt = makeRuntime();
    const secretId = await seedDoc(rt, "ec-secret", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    const publicId = await seedDoc(rt, "ec-public", { n: 2 }, [
      { path: [], label: { confidentiality: ["public-ish"] } },
    ]);
    const outId = await writeTainted(rt, secretId, "ec-grow-out", {
      copied: true,
    });

    const tx = rt.edit();
    tx.readOrThrow(readAddress(publicId, []));
    tx.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { copied: false },
    );
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const valueEntry = entriesOf(outId).find((e) => e.observes === "value");
    expect(valueEntry?.label.confidentiality).toEqual(["public-ish"]);
    const shape = shapeEntriesAt(outId, []);
    expect(shape.length).toBe(1);
    expect([...(shape[0].label.confidentiality ?? [])].sort()).toEqual([
      "public-ish",
      "secret",
    ]);
  });

  // An ancestor overwrite clears derived descendants (§8.12.8) — but their
  // existence folds UP into the written path's existence entry rather than
  // vanishing.
  it("ancestor overwrite folds descendant existence into the written path", async () => {
    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ec-child-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    // Create the doc first (clean tx, no stamps): a nested write on a
    // MISSING doc records as a root creation and would stamp [] instead.
    const outId = await writeTainted(rt, undefined, "ec-fold-out", {
      child: {},
    });
    expect(entriesOf(outId)).toEqual([]);
    // Derived pair lands at ["child"].
    const tainted = rt.edit();
    tainted.readOrThrow(readAddress(sourceId, []));
    tainted.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "child"] },
      { deep: true },
    );
    tainted.prepareCfc();
    expect((await tainted.commit()).ok).toBeDefined();
    expect(shapeEntriesAt(outId, ["child"]).length).toBe(1);

    // Clean ROOT overwrite: descendant pair cleared, existence folds to [].
    const tx = rt.edit();
    tx.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { flat: true },
    );
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    expect(shapeEntriesAt(outId, ["child"])).toEqual([]);
    const rootShape = shapeEntriesAt(outId, []);
    expect(rootShape.length).toBe(1);
    expect(rootShape[0].label.confidentiality).toContainEqual("secret");
  });

  // Pre-C2 covering derived entries carried the existence channel too; a
  // clean overwrite must fold their confidentiality into the new existence
  // entry, not erase it (the same SC-4 leak on legacy data).
  it("legacy covering derived entries feed the existence grow", async () => {
    const rt = makeRuntime();
    // Seed via a real flow write on a pre-C2-shaped doc: seed the covering
    // entry raw, with a loadable schema (the persist region skips docs
    // whose schemaHash does not resolve).
    const sourceId = await seedDoc(rt, "ec-legacy-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["old-secret"] } },
    ]);
    const outId = await writeTainted(rt, sourceId, "ec-legacy-out", {
      copied: true,
    });
    // Rewrite the stored metadata into the pre-C2 single-covering shape.
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): { cfc?: { labelMap?: { entries: unknown[] } } };
    };
    const stored = replica.getDocument(outId).cfc! as Record<
      string,
      unknown
    >;
    const legacy = rt.edit();
    legacy.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["cfc"] },
      {
        ...stored,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: ["old-secret"] },
            origin: "derived",
          }],
        },
      },
    );
    expect((await legacy.commit()).ok).toBeDefined();

    const tx = rt.edit();
    tx.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { copied: false },
    );
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const shape = shapeEntriesAt(outId, []);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toContainEqual("old-secret");
  });

  // Structure stamps are the container-shape half of the same channel: an
  // overwrite that replaces a labeled pure-link container with plain
  // content must keep the membership history on the existence entry.
  it("cleared structure stamps feed the existence grow", async () => {
    const rt = makeRuntime();
    const el0 = await seedDoc(rt, "ec-el-0", { n: 1 }, [
      { path: [], label: { confidentiality: ["alice"] } },
    ]);
    const tx1 = rt.edit();
    tx1.readOrThrow(readAddress(el0, []));
    const el0Cell = rt.getCell(space, "ec-el-0", undefined, tx1);
    const list = rt.getCell(space, "ec-list", {
      type: "array",
      items: { asCell: ["cell"] },
    }, tx1);
    list.set([el0Cell]);
    tx1.prepareCfc();
    expect((await tx1.commit()).ok).toBeDefined();
    const listId = list.getAsNormalizedFullLink().id;
    expect(
      entriesOf(listId).some((e) => e.origin === "structure"),
    ).toBe(true);

    const tx2 = rt.edit();
    tx2.writeOrThrow(
      { space, scope: "space", id: uri(listId), path: ["value"] },
      { replaced: true },
    );
    tx2.prepareCfc();
    expect((await tx2.commit()).ok).toBeDefined();

    const shape = shapeEntriesAt(listId, []);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toContainEqual("alice");
  });

  // A link write replacing a labeled slot is skipped by the stamp loops
  // (the link machinery owns that path), so the cleared existence lands as
  // a bare shape entry at the written path — the leftover branch.
  it("link overwrite of a labeled slot keeps existence as a bare shape entry", async () => {
    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ec-link-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    // Doc with a derived pair at ["slot"]: create clean, then taint the slot.
    const outId = await writeTainted(rt, undefined, "ec-link-out", {
      slot: 0,
    });
    const taint = rt.edit();
    taint.readOrThrow(readAddress(sourceId, []));
    taint.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "slot"] },
      { copied: true },
    );
    taint.prepareCfc();
    expect((await taint.commit()).ok).toBeDefined();
    expect(shapeEntriesAt(outId, ["slot"]).length).toBe(1);

    // Replace the slot with a LINK (a clean tx): the link machinery owns
    // the slot's label now, but the existence history must survive.
    await seedDoc(rt, "ec-link-target", { n: 2 }, []);
    const linkTx = rt.edit();
    const outCell = rt.getCell(space, "ec-link-out", undefined, linkTx);
    const otherCell = rt.getCell(space, "ec-link-target", undefined, linkTx);
    outCell.key("slot").set(otherCell);
    linkTx.prepareCfc();
    expect((await linkTx.commit()).ok).toBeDefined();

    const shape = shapeEntriesAt(outId, ["slot"]);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toContainEqual("secret");
  });

  // Idempotence stays per-class (SC-11): repeating the same clean overwrite
  // must not churn the metadata — the grown existence entry re-derives
  // identically.
  it("the grown existence entry re-derives idempotently", async () => {
    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ec-idem-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    const outId = await writeTainted(rt, sourceId, "ec-idem-out", {
      copied: true,
    });

    const overwrite = async (value: Record<string, unknown>) => {
      const tx = rt.edit();
      tx.writeOrThrow(
        { space, scope: "space", id: uri(outId), path: ["value"] },
        value,
      );
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();
    };
    await overwrite({ copied: false });
    const first = JSON.stringify(entriesOf(outId));
    await overwrite({ copied: 3 });
    expect(JSON.stringify(entriesOf(outId))).toEqual(first);
  });
});

// SC-8, the pointer-identity channel (C0 §4 row 3). The consumption
// mechanism landed with C1 (probes classified followRef, standalone probes
// consume link-origin labels); this pins the channel end-to-end at the
// resolution seam: observing WHICH reference sits at a slot — without
// following it — taints the observer's flow join with the pointer's label.
describe("CFC slot-pointer channel (C3, SC-8 end-to-end)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("resolving a slot link without following it taints with the pointer label", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });
    const seed = runtime.edit();
    const holder = runtime.getCell(space, "sp-holder", undefined, seed);
    const holderId = holder.getAsNormalizedFullLink().id;
    seed.writeOrThrow({ space, scope: "space", id: holderId, path: [] }, {
      value: { slot: { "/": { "link@1": { id: "of:sp-target", path: [] } } } },
      cfc: {
        version: 1,
        schemaHash: "seed-schema",
        labelMap: {
          version: 1,
          entries: [{
            path: ["slot"],
            label: { confidentiality: ["pointer-label"] },
            origin: "link",
          }],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();

    // Observe WHICH link sits at the slot without following it: lastNode
    // "top" stops at the slot after probing it — the row-3 observation.
    const tx = runtime.edit();
    const slotLink: NormalizedFullLink = {
      space,
      id: holderId as `${string}:${string}`,
      path: ["slot"],
      scope: "space",
    } as NormalizedFullLink;
    resolveLink(runtime, tx, slotLink, "top");
    const out = runtime.getCell(space, "sp-out", undefined, tx);
    const outId = out.getAsNormalizedFullLink().id;
    tx.writeOrThrow(
      {
        space,
        scope: "space",
        id: outId as `${string}:${string}`,
        path: ["value"],
      },
      { observed: true },
    );
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const replica = storageManager.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    const derived = (replica.getDocument(outId)?.cfc?.labelMap?.entries ?? [])
      .filter((e) => e.origin === "derived");
    expect(
      derived.flatMap((e) => e.label.confidentiality ?? []),
    ).toContainEqual("pointer-label");
  });
});
