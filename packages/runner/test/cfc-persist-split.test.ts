import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { linkResolutionProbe } from "../src/storage/reactivity-log.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-persist-split");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

// Epic C stage C2 (docs/specs/cfc-observation-classes.md §5/§8): the persist
// region writes the per-tx flow join as per-class entries — an
// `observes:"value"` derived entry carrying the full J plus an
// `observes:"shape"` (existence) entry carrying confidentiality only — and
// `structure` stamps state `observes:"shape"` explicitly.
//
// Rollout (C0 §9): additively safe, no dial. A class-unaware reader treats
// both split entries as covering and sees exactly today's atoms; the C1
// class-aware reader joins them back identically for value reads. No
// `observes:"followRef"` entry is newly persisted here — link-origin entries
// already carry that class implicitly.
describe("CFC observation classes (C2 persist split)", () => {
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

  const rawDocOf = (
    id: string,
  ): { cfc?: { labelMap?: { entries: StoredEntry[] } } } | undefined => {
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id);
  };

  const entriesOf = (id: string): StoredEntry[] =>
    rawDocOf(id)?.cfc?.labelMap?.entries ?? [];

  const readAddress = (id: string, path: string[]) => ({
    space,
    scope: "space" as const,
    id: id as `${string}:${string}`,
    type: "application/json" as const,
    path: ["value", ...path],
  });

  // Copies a labeled value into a fresh output doc and returns the output's
  // stored entries.
  const launder = async (
    rt: Runtime,
    sourceId: string,
    outCause: string,
  ): Promise<{ id: string; entries: StoredEntry[] }> => {
    const tx = rt.edit();
    tx.readOrThrow(readAddress(sourceId, []));
    const out = rt.getCell(space, outCause, undefined, tx);
    out.set({ copied: true });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    const id = out.getAsNormalizedFullLink().id;
    return { id, entries: entriesOf(id) };
  };

  // The core split: a derived flow stamp lands as an `observes:"value"`
  // entry carrying the full J (confidentiality + integrity) plus an
  // `observes:"shape"` existence entry carrying confidentiality only.
  it("persists the flow join as a value + shape entry pair", async () => {
    const rt = makeRuntime();
    const certified = { type: CFC_ATOM_TYPE.PolicyCertified, policy: "p1" };
    const sourceId = await seedDoc(rt, "ps-source", { n: 1 }, [
      {
        path: [],
        label: { confidentiality: ["secret"], integrity: [certified] },
      },
    ]);

    // Read-free output write so the hereditary meet keeps the certification
    // and the value entry demonstrably carries integrity.
    const tx = rt.edit();
    tx.readOrThrow(readAddress(sourceId, []));
    const out = rt.getCell(space, "ps-out", undefined, tx);
    const outId = out.getAsNormalizedFullLink().id;
    tx.writeOrThrow(
      { space, scope: "space", id: outId, path: ["value"] },
      { copied: true },
    );
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const derived = entriesOf(outId).filter((e) => e.origin === "derived");
    expect(derived.map((e) => e.observes).sort()).toEqual(["shape", "value"]);
    const valueEntry = derived.find((e) => e.observes === "value")!;
    const shapeEntry = derived.find((e) => e.observes === "shape")!;
    expect(valueEntry.label.confidentiality).toEqual(["secret"]);
    expect(valueEntry.label.integrity).toContainEqual(certified);
    // The existence channel carries confidentiality only: integrity there
    // would be joined by C3's grow-on-overwrite, an over-claim.
    expect(shapeEntry.label.confidentiality).toEqual(["secret"]);
    expect(shapeEntry.label.integrity).toBeUndefined();
    expect(shapeEntry.path).toEqual(valueEntry.path);
  });

  // Structure stamps (pure-link-structure writes) split per channel: the
  // MEMBERSHIP stamp is observes:"enumerate" (replace-from-criteria,
  // §8.12.8 — labs-axis approximation of the spec's container-level
  // iterate classes) and the container's EXISTENCE is a separate frozen
  // observes:"shape" entry minted at creation (freeze-at-creation, spec
  // branch cfc/existence-freeze-at-creation).
  it("structure stamps split into enumerate membership + frozen shape existence", async () => {
    const rt = makeRuntime();
    const el0 = await seedDoc(rt, "ps-el-0", { n: 1 }, [
      { path: [], label: { confidentiality: ["alice"] } },
    ]);

    // A tx that reads labeled content and writes a pure-link container: the
    // container gets an exact-path structure stamp with J.
    const tx = rt.edit();
    tx.readOrThrow(readAddress(el0, []));
    const el0Cell = rt.getCell(space, "ps-el-0", undefined, tx);
    const list = rt.getCell(space, "ps-list", {
      type: "array",
      items: { asCell: ["cell"] },
    }, tx);
    list.set([el0Cell]);
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const listId = list.getAsNormalizedFullLink().id;
    const structure = entriesOf(listId).filter((e) => e.origin === "structure");
    expect(structure.length).toBeGreaterThan(0);
    const classes = [...new Set(structure.map((e) => e.observes))].sort();
    expect(classes).toEqual(["enumerate", "shape"]);
    for (const entry of structure) {
      expect(entry.label.confidentiality).toEqual(["alice"]);
    }
  });

  // SC-11 idempotence per class: re-deriving an unchanged label must not
  // rewrite the ["cfc"] doc — the split pair must canonicalize identically
  // across re-derivations.
  it("keeps re-derivation idempotent per class (SC-11)", async () => {
    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ps-idem-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    const first = await launder(rt, sourceId, "ps-idem-out");
    const before = JSON.stringify(rawDocOf(first.id)?.cfc);

    // Same read, same write, same derivation → the metadata write must be
    // skipped (canonically identical), not re-split or duplicated.
    const tx = rt.edit();
    tx.readOrThrow(readAddress(sourceId, []));
    const out = rt.getCell(space, "ps-idem-out", undefined, tx);
    out.set({ copied: true });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const after = JSON.stringify(rawDocOf(first.id)?.cfc);
    expect(after).toEqual(before);
    const derived = entriesOf(first.id).filter((e) => e.origin === "derived");
    expect(derived.map((e) => e.observes).sort()).toEqual(["shape", "value"]);
  });

  // Reader parity across the split: a class-aware value read of split
  // entries derives the same downstream join a single covering entry
  // produced.
  it("value-read flow joins over split entries match the covering join", async () => {
    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ps-parity-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    const first = await launder(rt, sourceId, "ps-parity-mid");
    // Second hop reads the split-labeled doc and copies onward.
    const second = await launder(rt, first.id, "ps-parity-out");
    const derived = second.entries.filter((e) => e.origin === "derived");
    expect(derived.map((e) => e.observes).sort()).toEqual(["shape", "value"]);
    for (const entry of derived) {
      expect(entry.label.confidentiality).toEqual(["secret"]);
    }
  });

  // Per-class consumption refinement (intended, fail-safe): a nonRecursive
  // (shape) read of a split-labeled path consumes the existence
  // confidentiality but no longer inherits the value entry's content
  // certification into the hereditary meet — shape observations are not
  // content inputs (SC-9: under-claim, never over-claim).
  it("shape reads over split entries taint without inheriting content certification", async () => {
    const rt = makeRuntime();
    const certified = { type: CFC_ATOM_TYPE.PolicyCertified, policy: "p1" };
    const sourceId = await seedDoc(rt, "ps-shape-source", { n: 1 }, [
      {
        path: [],
        label: { confidentiality: ["secret"], integrity: [certified] },
      },
    ]);
    const first = await launder(rt, sourceId, "ps-shape-mid");

    const tx = rt.edit();
    tx.readOrThrow(readAddress(first.id, []), { nonRecursive: true });
    const out = rt.getCell(space, "ps-shape-out", undefined, tx);
    const outId = out.getAsNormalizedFullLink().id;
    tx.writeOrThrow(
      { space, scope: "space", id: outId, path: ["value"] },
      { counted: true },
    );
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const derived = entriesOf(outId).filter((e) => e.origin === "derived");
    const valueEntry = derived.find((e) => e.observes === "value")!;
    expect(valueEntry.label.confidentiality).toEqual(["secret"]);
    // No PolicyCertified inherited through a shape-only observation.
    expect(
      (valueEntry.label.integrity ?? []).filter((atom) =>
        (atom as { type?: string }).type === CFC_ATOM_TYPE.PolicyCertified
      ),
    ).toEqual([]);
  });

  // Overwrite discipline at C2: the value entry is replaced by the new
  // derivation (§8.12.8). The shape entry's replace-vs-grow is deliberately
  // NOT pinned here — C3 upgrades it to grow (SC-4).
  it("overwrite replaces the value entry with the new derivation", async () => {
    const rt = makeRuntime();
    const secretId = await seedDoc(rt, "ps-ow-secret", { n: 1 }, [
      { path: [], label: { confidentiality: ["old-secret"] } },
    ]);
    const publicId = await seedDoc(rt, "ps-ow-public", { n: 2 }, [
      { path: [], label: { confidentiality: ["public-ish"] } },
    ]);
    const first = await launder(rt, secretId, "ps-ow-out");
    expect(
      first.entries.find((e) => e.observes === "value")?.label.confidentiality,
    ).toEqual(["old-secret"]);

    // A ROOT overwrite (whole-value write at the stamped path) — a leaf
    // write below the stamp must NOT clear it, so `out.set({...})`'s
    // leaf-diffing would not exercise replace-on-overwrite.
    const tx = rt.edit();
    tx.readOrThrow(readAddress(publicId, []));
    tx.writeOrThrow(
      {
        space,
        scope: "space",
        id: first.id as `${string}:${string}`,
        path: ["value"],
      },
      { copied: false },
    );
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const valueEntry = entriesOf(first.id).find((e) =>
      e.origin === "derived" && e.observes === "value"
    );
    expect(valueEntry?.label.confidentiality).toEqual(["public-ish"]);
    expect(valueEntry?.label.confidentiality).not.toContainEqual("old-secret");
  });

  // Wire-compat (C0 §9, the plan's mixed-version discipline): a
  // class-UNAWARE reader — one that ignores `observes` entirely and treats
  // every entry as covering — resolves exactly today's atoms from the split
  // pair: same confidentiality, and the integrity still present via the
  // value entry. More restrictive is allowed, less is not.
  it("split entries read as covering by a class-unaware reader lose nothing", async () => {
    const rt = makeRuntime();
    const certified = { type: CFC_ATOM_TYPE.PolicyCertified, policy: "p1" };
    const sourceId = await seedDoc(rt, "ps-compat-source", { n: 1 }, [
      {
        path: [],
        label: { confidentiality: ["secret"], integrity: [certified] },
      },
    ]);
    const tx = rt.edit();
    tx.readOrThrow(readAddress(sourceId, []));
    const out = rt.getCell(space, "ps-compat-out", undefined, tx);
    const outId = out.getAsNormalizedFullLink().id;
    tx.writeOrThrow(
      { space, scope: "space", id: outId, path: ["value"] },
      { copied: true },
    );
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    // Legacy resolution: union every entry's atoms regardless of class.
    const derived = entriesOf(outId).filter((e) => e.origin === "derived");
    const legacyConfidentiality = [
      ...new Set(derived.flatMap((e) => e.label.confidentiality ?? [])),
    ];
    const legacyIntegrity = derived.flatMap((e) => e.label.integrity ?? []);
    expect(legacyConfidentiality).toEqual(["secret"]);
    expect(legacyIntegrity).toContainEqual(certified);
  });

  // The SC-8 probe consumption composes with the split: standalone probes
  // still consume only followRef-class entries — never the new value/shape
  // pair.
  it("standalone probes do not consume the split value/shape entries", async () => {
    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ps-probe-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    const first = await launder(rt, sourceId, "ps-probe-mid");

    const tx = rt.edit();
    tx.read(readAddress(first.id, []), { meta: linkResolutionProbe });
    const out = rt.getCell(space, "ps-probe-out", undefined, tx);
    const outId = out.getAsNormalizedFullLink().id;
    tx.writeOrThrow(
      { space, scope: "space", id: outId, path: ["value"] },
      { probed: true },
    );
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    expect(entriesOf(outId).filter((e) => e.origin === "derived")).toEqual([]);
  });
});
