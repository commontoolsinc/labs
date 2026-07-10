import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { linkResolutionProbe } from "../src/storage/reactivity-log.ts";
import { canonicalizeCfcMetadata } from "../src/cfc/canonical.ts";
import {
  commitCfcFieldValue,
  containsCfcFieldCommitment,
} from "../src/cfc/label-representation.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-template-population");
const foreignSigner = await Identity.fromPassphrase(
  "runner-cfc-template-population-foreign",
);
const space = signer.did();
const foreignSpace = foreignSigner.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: unknown[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

// Stage A of docs/specs/cfc-template-population.md: runtime-minted `*`-path
// per-class `structure` entries (the membership/slot templates) close the two
// SC-4/SC-8 residual under-taints:
//   §1.1 a per-child existence probe ("is /items/3 present?" — a nonRecursive
//        shape read AT the child) never consumed the membership J, because
//        the runner's membership stamp is container-anchored and structure
//        entries applied only at exactly their own path;
//   §1.2 a slot-pointer observation (followRef probe at a computed slot)
//        consumed only the per-slot link entry (the target's transport
//        label), never the assignment J that decided WHICH element sits
//        there.
// The fix mints three `*`-child entries beside the container-anchored
// enumerate stamp — {path:[...container,"*"], origin:"structure", observes}
// for observes ∈ {shape, value, followRef} — all carrying the same per-tx J,
// under the same replace-from-criteria discipline.
describe("CFC template population (Stage A): the two under-taints", () => {
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

  const derivedConfidentiality = (id: string): unknown[] =>
    entriesOf(id)
      .filter((e) => e.origin === "derived")
      .flatMap((e) => e.label.confidentiality ?? []);

  const readAddress = (id: string, path: string[]) => ({
    space,
    scope: "space" as const,
    id: id as `${string}:${string}`,
    type: "application/json" as const,
    path: ["value", ...path],
  });

  const uri = (id: string) => id as `${string}:${string}`;

  // Builds a pure-link list at `listCause` whose membership was decided
  // under the label of `criteriaId` (the predicate-output stand-in the
  // writing tx reads), DECLARED as a list-coordinator result container
  // (`recordCfcStructureContainer`, the S16 hook the filter/flatMap
  // coordinators call each reconcile): the declared container gets the
  // container-anchored `enumerate` stamp AND the `*`-child class templates,
  // all carrying that tx's J — the membership taint. The criteria doc is
  // DISTINCT from the elements so the membership J is distinguishable from
  // the per-slot transport labels.
  const buildList = async (
    rt: Runtime,
    listCause: string,
    criteriaId: string,
    memberCauses: string[],
  ): Promise<string> => {
    const tx = rt.edit();
    tx.readOrThrow(readAddress(criteriaId, []));
    const members = memberCauses.map((cause) =>
      rt.getCell(space, cause, undefined, tx)
    );
    const list = rt.getCell(space, listCause, {
      type: "array",
      items: { asCell: ["cell"] },
    }, tx);
    list.set(members);
    const listId = list.getAsNormalizedFullLink().id;
    tx.recordCfcStructureContainer({
      space,
      id: listId,
      scope: "space",
      path: [],
    });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    return listId;
  };

  // Runs `observe` in a fresh tx that also writes an out doc, commits, and
  // returns the out doc's derived flow confidentiality.
  const flowJoinOf = async (
    rt: Runtime,
    outCause: string,
    observe: (tx: ReturnType<Runtime["edit"]>) => void,
  ): Promise<unknown[]> => {
    const tx = rt.edit();
    observe(tx);
    const out = rt.getCell(space, outCause, undefined, tx);
    out.set({ observed: true });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    return derivedConfidentiality(out.getAsNormalizedFullLink().id);
  };

  // §1.1 — the per-child existence probe. "Is /0 present?" is a shape read
  // AT THE CHILD (spec §8.10.1.1); the membership decision (which slots
  // survived) was computed under `memb-secret`, so the probe must consume
  // it. RED on main: the only membership carrier is the container-anchored
  // enumerate stamp, which a child-path read never consumes.
  it("per-child existence probe consumes the membership J (SC-8 residual №1)", async () => {
    const rt = makeRuntime();
    await seedDoc(rt, "tp-el-a", { n: 1 }, [
      { path: [], label: { confidentiality: ["el-label"] } },
    ]);
    const criteriaId = await seedDoc(rt, "tp-criteria-a", { keep: true }, [
      { path: [], label: { confidentiality: ["memb-secret"] } },
    ]);
    const listId = await buildList(rt, "tp-list-a", criteriaId, ["tp-el-a"]);

    const join = await flowJoinOf(rt, "tp-probe-a-out", (tx) => {
      tx.readOrThrow(readAddress(listId, ["0"]), { nonRecursive: true });
    });
    expect(join).toContainEqual("memb-secret");
    // The probe observed presence, not content or pointer identity: the
    // element's transport label rides the slot's link entry (followRef
    // class) and must NOT taint a shape probe.
    expect(join).not.toContainEqual("el-label");
  });

  // §1.2 — the slot-pointer observation. A followRef probe at a computed
  // slot observes WHICH reference sits there; the assignment J decided
  // exactly that (inv-9 flow-path confidentiality), so the probe must
  // consume it — while still consuming nothing of the container's content
  // classes and nothing of the target beyond its own link entry. RED on
  // main: the probe consumes only the per-slot link entry.
  it("slot followRef probe consumes the assignment J (SC-8 residual №2)", async () => {
    const rt = makeRuntime();
    await seedDoc(rt, "tp-el-b", { n: 2 }, [
      { path: [], label: { confidentiality: ["el-label"] } },
    ]);
    const criteriaId = await seedDoc(rt, "tp-criteria-b", { keep: true }, [
      { path: [], label: { confidentiality: ["memb-secret"] } },
    ]);
    const listId = await buildList(rt, "tp-list-b", criteriaId, ["tp-el-b"]);

    const join = await flowJoinOf(rt, "tp-probe-b-out", (tx) => {
      tx.read(readAddress(listId, ["0"]), { meta: linkResolutionProbe });
    });
    expect(join).toContainEqual("memb-secret");
  });

  // §1.2's value half — materializing the reference scalar at the slot
  // without dereferencing (a raw sigil value read) is a `value` observation
  // of the slot and consumes the value twin. RED on main: value reads skip
  // link-origin entries and no structure entry applies at the slot.
  it("raw sigil value read at the slot consumes the value twin", async () => {
    const rt = makeRuntime();
    await seedDoc(rt, "tp-el-c", { n: 3 }, [
      { path: [], label: { confidentiality: ["el-label"] } },
    ]);
    const criteriaId = await seedDoc(rt, "tp-criteria-c", { keep: true }, [
      { path: [], label: { confidentiality: ["memb-secret"] } },
    ]);
    const listId = await buildList(rt, "tp-list-c", criteriaId, ["tp-el-c"]);

    const join = await flowJoinOf(rt, "tp-probe-c-out", (tx) => {
      tx.readOrThrow(readAddress(listId, ["0"]));
    });
    expect(join).toContainEqual("memb-secret");
  });

  // The template mint itself, pinned: a declared coordinator container gets
  // the container-anchored enumerate stamp, the frozen existence entry, and
  // exactly three `*`-child templates — shape/value/followRef — all
  // carrying the membership J, confidentiality-only.
  it("declared containers mint the three `*`-child class templates beside the enumerate stamp", async () => {
    const rt = makeRuntime();
    await seedDoc(rt, "tp-el-m", { n: 1 }, []);
    const criteriaId = await seedDoc(rt, "tp-criteria-m", { keep: true }, [
      { path: [], label: { confidentiality: ["memb-secret"] } },
    ]);
    const listId = await buildList(rt, "tp-list-m", criteriaId, ["tp-el-m"]);

    const structure = entriesOf(listId).filter((e) => e.origin === "structure");
    const container = structure.filter((e) => e.path.length === 0);
    expect([...new Set(container.map((e) => e.observes))].sort()).toEqual(
      ["enumerate", "shape"],
    );
    const templates = structure.filter((e) => e.path.length === 1);
    expect(templates.map((e) => e.path)).toEqual([["*"], ["*"], ["*"]]);
    expect(templates.map((e) => e.observes).sort()).toEqual(
      ["followRef", "shape", "value"],
    );
    for (const entry of structure) {
      expect(entry.label.confidentiality).toEqual(["memb-secret"]);
      expect(entry.label.integrity).toBeUndefined();
    }
  });

  // Replace-from-criteria (§8.12.8, the discipline the templates share with
  // the enumerate stamp): when the criteria change across reconciles, the
  // templates follow — the departed criteria's atom leaves — while the
  // FROZEN existence entry keeps the creation join. A transient empty-J
  // reconcile (declare with nothing labeled read — resume/loading) does NOT
  // clear a correct prior label.
  it("templates re-stamp from current J each reconcile; transient empty-J reconciles leave them alone", async () => {
    const rt = makeRuntime();
    await seedDoc(rt, "tp-el-r", { n: 1 }, []);
    const criteriaA = await seedDoc(rt, "tp-criteria-r-a", { keep: true }, [
      { path: [], label: { confidentiality: ["alice-criteria"] } },
    ]);
    const criteriaB = await seedDoc(rt, "tp-criteria-r-b", { keep: false }, [
      { path: [], label: { confidentiality: ["bob-criteria"] } },
    ]);
    const listId = await buildList(rt, "tp-list-r", criteriaA, ["tp-el-r"]);

    const templateConf = () =>
      entriesOf(listId)
        .filter((e) => e.origin === "structure" && e.path.length === 1)
        .flatMap((e) => e.label.confidentiality ?? []);
    const frozenConf = () =>
      entriesOf(listId)
        .filter((e) =>
          e.origin === "structure" && e.path.length === 0 &&
          e.observes === "shape"
        )
        .flatMap((e) => e.label.confidentiality ?? []);
    expect(templateConf()).toEqual([
      "alice-criteria",
      "alice-criteria",
      "alice-criteria",
    ]);

    // Re-declare with NO value write under the new criteria: the templates
    // (and the enumerate stamp) are dropped and re-minted from the new J —
    // alice's atom leaves with her criteria (no accumulate-forever).
    const restamp = rt.edit();
    restamp.readOrThrow(readAddress(criteriaB, []));
    restamp.recordCfcStructureContainer({
      space,
      id: listId,
      scope: "space",
      path: [],
    });
    restamp.prepareCfc();
    expect((await restamp.commit()).ok).toBeDefined();
    expect(templateConf()).toEqual([
      "bob-criteria",
      "bob-criteria",
      "bob-criteria",
    ]);
    // The frozen existence entry keeps the CREATION join, untouched.
    expect(frozenConf()).toEqual(["alice-criteria"]);

    // Transient empty-J reconcile: the container is declared but nothing
    // labeled was read (J empty) — the prior templates must survive
    // (fail-safe: keep the existing label, mirroring the enumerate stamp).
    const transient = rt.edit();
    transient.recordCfcStructureContainer({
      space,
      id: listId,
      scope: "space",
      path: [],
    });
    transient.prepareCfc();
    expect((await transient.commit()).ok).toBeDefined();
    expect(templateConf()).toEqual([
      "bob-criteria",
      "bob-criteria",
      "bob-criteria",
    ]);
  });

  // Covering writes clear templates and NEVER pool them into the existence
  // channel: after a criteria change re-stamped the templates to a new atom,
  // a covering overwrite of the container removes every `*` entry, and the
  // re-stamped atom must not surface anywhere else (pooling it into the
  // frozen shape entry would ratchet §8.12.8's replace into a grow).
  it("covering write clears templates without pooling them", async () => {
    const rt = makeRuntime();
    await seedDoc(rt, "tp-el-cw", { n: 1 }, []);
    const criteriaA = await seedDoc(rt, "tp-criteria-cw-a", { keep: true }, [
      { path: [], label: { confidentiality: ["creation-atom"] } },
    ]);
    const criteriaB = await seedDoc(rt, "tp-criteria-cw-b", { keep: true }, [
      { path: [], label: { confidentiality: ["tmpl-only-atom"] } },
    ]);
    const listId = await buildList(rt, "tp-list-cw", criteriaA, ["tp-el-cw"]);
    const restamp = rt.edit();
    restamp.readOrThrow(readAddress(criteriaB, []));
    restamp.recordCfcStructureContainer({
      space,
      id: listId,
      scope: "space",
      path: [],
    });
    restamp.prepareCfc();
    expect((await restamp.commit()).ok).toBeDefined();
    expect(
      entriesOf(listId)
        .filter((e) => e.path.length === 1)
        .flatMap((e) => e.label.confidentiality ?? []),
    ).toContainEqual("tmpl-only-atom");

    // Covering overwrite (clean tx, plain content): every structure entry
    // under the written path is cleared; templates are class-carrying and
    // never pool, so tmpl-only-atom vanishes entirely — while the frozen
    // existence entry (creation-atom) survives the overwrite in place.
    const cover = rt.edit();
    cover.writeOrThrow(
      { space, scope: "space", id: uri(listId), path: ["value"] },
      { replaced: true },
    );
    cover.prepareCfc();
    expect((await cover.commit()).ok).toBeDefined();

    const after = entriesOf(listId);
    expect(after.some((e) => e.path.includes("*"))).toBe(false);
    expect(JSON.stringify(after)).not.toContain("tmpl-only-atom");
    const frozen = after.filter((e) =>
      e.origin === "structure" && e.observes === "shape"
    );
    expect(frozen.length).toBe(1);
    expect(frozen[0].label.confidentiality).toEqual(["creation-atom"]);
  });

  // SC-11 with templates present: an identical re-declaration (same
  // criteria, same members, no value write) re-derives byte-identical
  // metadata and must not write the ["cfc"] envelope at all.
  it("recompute with templates present is a no-op (SC-11: zero cfc writes)", async () => {
    const rt = makeRuntime();
    await seedDoc(rt, "tp-el-i", { n: 1 }, []);
    const criteriaId = await seedDoc(rt, "tp-criteria-i", { keep: true }, [
      { path: [], label: { confidentiality: ["memb-secret"] } },
    ]);
    const listId = await buildList(rt, "tp-list-i", criteriaId, ["tp-el-i"]);
    const before = JSON.stringify(entriesOf(listId));

    const again = rt.edit();
    again.readOrThrow(readAddress(criteriaId, []));
    again.recordCfcStructureContainer({
      space,
      id: listId,
      scope: "space",
      path: [],
    });
    again.prepareCfc();
    const wroteCfc = [...(again.getWriteDetails?.(space) ?? [])].some(
      (w) => w.address.id === listId && w.address.path[0] === "cfc",
    );
    expect(wroteCfc).toBe(false);
    expect((await again.commit()).ok).toBeDefined();
    expect(JSON.stringify(entriesOf(listId))).toEqual(before);
  });

  // The §8.12.8 replace-from-criteria READBACK EXCLUSION, pinned at the
  // unit level: the re-deriving transaction's own reads of the container's
  // slots (an incremental reconciler diffing its previous output) must not
  // feed the replaced templates back into the J it re-mints them from —
  // otherwise replace degenerates into accumulate-forever. The end-to-end
  // pin is cfc-flow-pointwise's "membership replaces from criteria".
  it("the re-deriving tx's own slot readback does not ratchet J (readback exclusion)", async () => {
    const rt = makeRuntime();
    await seedDoc(rt, "tp-el-rb", { n: 1 }, []);
    const criteriaA = await seedDoc(rt, "tp-criteria-rb-a", { keep: true }, [
      { path: [], label: { confidentiality: ["old-criteria"] } },
    ]);
    const criteriaB = await seedDoc(rt, "tp-criteria-rb-b", { keep: true }, [
      { path: [], label: { confidentiality: ["new-criteria"] } },
    ]);
    const listId = await buildList(rt, "tp-list-rb", criteriaA, ["tp-el-rb"]);

    // The reconcile: reads the new criteria AND its own container's slot
    // (the diff readback — a standalone probe at the slot plus a raw slot
    // read), then re-declares. Without the exclusion the readback would
    // resolve the old templates and mint old ∪ new.
    const reconcile = rt.edit();
    reconcile.readOrThrow(readAddress(criteriaB, []));
    reconcile.read(readAddress(listId, ["0"]), { meta: linkResolutionProbe });
    reconcile.readOrThrow(readAddress(listId, ["0"]));
    reconcile.recordCfcStructureContainer({
      space,
      id: listId,
      scope: "space",
      path: [],
    });
    reconcile.prepareCfc();
    expect((await reconcile.commit()).ok).toBeDefined();

    const templateConf = entriesOf(listId)
      .filter((e) => e.origin === "structure" && e.path.length === 1)
      .flatMap((e) => e.label.confidentiality ?? []);
    expect(templateConf).toContainEqual("new-criteria");
    expect(templateConf).not.toContainEqual("old-criteria");
  });

  // The C0 §6.1 row-4 boundary extended to plain reads: a read at a slot
  // that is COVERED by a same-tx dereference trace is resolution machinery
  // passing through — it must not consume the slot templates (the follow's
  // taint arrives via the target's own reads). A standalone read of the
  // same slot (the row-3 case) consumes them — that asymmetry is pinned by
  // this test together with the red tests above.
  it("trace-covered slot reads are machinery: no template consumption", async () => {
    const rt = makeRuntime();
    const elId = await seedDoc(rt, "tp-el-tc", { n: 1 }, []);
    const criteriaId = await seedDoc(rt, "tp-criteria-tc", { keep: true }, [
      { path: [], label: { confidentiality: ["memb-secret"] } },
    ]);
    const listId = await buildList(rt, "tp-list-tc", criteriaId, ["tp-el-tc"]);

    const join = await flowJoinOf(rt, "tp-probe-tc-out", (tx) => {
      tx.readOrThrow(readAddress(listId, ["0"]));
      tx.recordCfcDereferenceTrace({
        source: { space, id: listId, scope: "space", path: ["0"] },
        target: { space, id: elId, scope: "space", path: [] },
        kind: "value",
      });
    });
    expect(join).not.toContainEqual("memb-secret");
  });
});

// Resolution semantics over hand-seeded template entries with DISTINCT
// per-class atoms — the runtime mints identical labels per class, so the
// class split is only observable with seeded metadata.
describe("CFC template population (Stage A): class-split resolution", () => {
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

  const derivedConfidentiality = (id: string): unknown[] =>
    entriesOf(id)
      .filter((e) => e.origin === "derived")
      .flatMap((e) => e.label.confidentiality ?? []);

  const readAddress = (id: string, path: string[]) => ({
    space,
    scope: "space" as const,
    id: id as `${string}:${string}`,
    type: "application/json" as const,
    path: ["value", ...path],
  });

  const flowJoinOf = async (
    rt: Runtime,
    outCause: string,
    observe: (tx: ReturnType<Runtime["edit"]>) => void,
  ): Promise<unknown[]> => {
    const tx = rt.edit();
    observe(tx);
    const out = rt.getCell(space, outCause, undefined, tx);
    out.set({ observed: true });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    return derivedConfidentiality(out.getAsNormalizedFullLink().id);
  };

  // One doc, every class distinct: a covering root entry, the three
  // templates with per-class atoms, and a link-origin pointer label on
  // slot 0.
  const seedSplitDoc = (rt: Runtime, cause: string) =>
    seedDoc(rt, cause, {
      items: [{ "/": { "link@1": { id: "of:tp-target", path: [] } } }],
    }, [
      { path: [], label: { confidentiality: ["root-covering"] } },
      {
        path: ["items", "*"],
        label: { confidentiality: ["memb-shape"] },
        origin: "structure",
        observes: "shape",
      },
      {
        path: ["items", "*"],
        label: { confidentiality: ["memb-value"] },
        origin: "structure",
        observes: "value",
      },
      {
        path: ["items", "*"],
        label: { confidentiality: ["memb-ref"] },
        origin: "structure",
        observes: "followRef",
      },
      {
        path: ["items", "0"],
        label: { confidentiality: ["ptr-label"] },
        origin: "link",
      },
    ]);

  // The refined split, pinned (design §2): a slot followRef consumes the
  // followRef template and the slot's own link entry — NO content-class
  // template (shape/value), NO covering entry (the types.ts:194-199 blind
  // pass-through property, preserved by class), and nothing of the target
  // beyond its own link entry.
  it("slot followRef consumes followRef template + link entry only", async () => {
    const rt = makeRuntime();
    const id = await seedSplitDoc(rt, "tp-split-ref");
    const join = await flowJoinOf(rt, "tp-split-ref-out", (tx) => {
      tx.read(readAddress(id, ["items", "0"]), { meta: linkResolutionProbe });
    });
    expect(join).toContainEqual("memb-ref");
    expect(join).toContainEqual("ptr-label");
    expect(join).not.toContainEqual("memb-shape");
    expect(join).not.toContainEqual("memb-value");
    expect(join).not.toContainEqual("root-covering");
  });

  // A per-child shape probe consumes the shape template (and covering
  // ancestors — content channel), never the value/followRef twins.
  it("per-child shape probe consumes the shape template only", async () => {
    const rt = makeRuntime();
    const id = await seedSplitDoc(rt, "tp-split-shape");
    const join = await flowJoinOf(rt, "tp-split-shape-out", (tx) => {
      tx.readOrThrow(readAddress(id, ["items", "0"]), { nonRecursive: true });
    });
    expect(join).toContainEqual("memb-shape");
    expect(join).not.toContainEqual("memb-value");
    expect(join).not.toContainEqual("memb-ref");
    expect(join).not.toContainEqual("ptr-label");
  });

  // A raw sigil value read at the slot consumes the value twin and the
  // shape twin (value reads consume the shape class, C0 §4) — never the
  // followRef twin or the pointer's transport label.
  it("raw value read at the slot consumes value + shape twins, not followRef", async () => {
    const rt = makeRuntime();
    const id = await seedSplitDoc(rt, "tp-split-value");
    const join = await flowJoinOf(rt, "tp-split-value-out", (tx) => {
      tx.readOrThrow(readAddress(id, ["items", "0"]));
    });
    expect(join).toContainEqual("memb-value");
    expect(join).toContainEqual("memb-shape");
    expect(join).not.toContainEqual("memb-ref");
    expect(join).not.toContainEqual("ptr-label");
  });

  // Templates apply below the direct child too (§4.6.3 recursive descent):
  // a value read strictly inside a slot's subtree still consumes the
  // value/shape twins — the exact-path structure rule does not apply to
  // `*`-path templates.
  it("templates apply to reads strictly below the slot", async () => {
    const rt = makeRuntime();
    const id = await seedDoc(rt, "tp-split-deep", {
      items: [{ name: "x" }],
    }, [
      {
        path: ["items", "*"],
        label: { confidentiality: ["memb-value"] },
        origin: "structure",
        observes: "value",
      },
    ]);
    const join = await flowJoinOf(rt, "tp-split-deep-out", (tx) => {
      tx.readOrThrow(readAddress(id, ["items", "0", "name"]));
    });
    expect(join).toContainEqual("memb-value");
  });

  // The frozen-vs-membership JOIN exception (design §3.2.1): a frozen
  // concrete shape entry (departed history) and the `*` membership template
  // (current shape) answer different questions under one class — where both
  // cover a read their labels JOIN rather than replace-down, in the
  // same-origin case (structure) and the cross-origin case (derived).
  it("frozen concrete shape entry and `*` membership template JOIN", async () => {
    const rt = makeRuntime();
    const id = await seedDoc(rt, "tp-join", {
      items: [[], []],
    }, [
      {
        path: ["items", "*"],
        label: { confidentiality: ["memb-current"] },
        origin: "structure",
        observes: "shape",
      },
      // Same origin, concrete path, same class: a nested container's frozen
      // existence entry.
      {
        path: ["items", "0"],
        label: { confidentiality: ["frozen-structure"] },
        origin: "structure",
        observes: "shape",
      },
      // Cross-origin concrete shape at another slot (a departed derived
      // write's frozen existence).
      {
        path: ["items", "1"],
        label: { confidentiality: ["frozen-derived"] },
        origin: "derived",
        observes: "shape",
      },
    ]);
    const joinSame = await flowJoinOf(rt, "tp-join-same-out", (tx) => {
      tx.readOrThrow(readAddress(id, ["items", "0"]), { nonRecursive: true });
    });
    expect(joinSame).toContainEqual("memb-current");
    expect(joinSame).toContainEqual("frozen-structure");
    const joinCross = await flowJoinOf(rt, "tp-join-cross-out", (tx) => {
      tx.readOrThrow(readAddress(id, ["items", "1"]), { nonRecursive: true });
    });
    expect(joinCross).toContainEqual("memb-current");
    expect(joinCross).toContainEqual("frozen-derived");
  });

  // Declared `*` entries (items schemas) keep their behavior byte-for-byte:
  // the persisted declared entry form is unchanged and a value read at a
  // child consumes it exactly as before this design (regression pin).
  it("declared items-`*` entries persist and resolve unchanged (regression)", async () => {
    const rt = makeRuntime();
    const guarded = internSchema(
      {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              ifc: { confidentiality: ["declared-member"] },
            },
          },
        },
      } as JSONSchema,
      true,
    );
    const tx = rt.edit();
    const cell = rt.getCell(space, "tp-declared-star", guarded.schema, tx);
    cell.set({ items: [{ n: 1 }] });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    const id = cell.getAsNormalizedFullLink().id;

    const declared = entriesOf(id).filter((e) => e.origin === "declared");
    expect(declared).toEqual([{
      path: ["items", "*"],
      label: { confidentiality: ["declared-member"] },
      origin: "declared",
    }]);

    const join = await flowJoinOf(rt, "tp-declared-star-out", (tx2) => {
      tx2.readOrThrow(readAddress(id, ["items", "0"]));
    });
    expect(join).toContainEqual("declared-member");
  });
});

// The §4 schema-walk extension: record-only `additionalProperties` descends
// as a `*` segment; mixed properties+additionalProperties schemas mint NO
// `*` entry (pinned — the restriction is load-bearing, `*` matches any
// segment and would over-taint the named fields).
describe("CFC template population (Stage A): record-only additionalProperties walk", () => {
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

  const entriesOf = (id: string): StoredEntry[] => {
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const persistThroughSchema = async (
    rt: Runtime,
    cause: string,
    schema: JSONSchema,
    value: unknown,
  ): Promise<string> => {
    const interned = internSchema(schema, true);
    const tx = rt.edit();
    const cell = rt.getCell(space, cause, interned.schema, tx);
    cell.set(value as never);
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    return cell.getAsNormalizedFullLink().id;
  };

  it("record-only additionalProperties mints a declared `*` entry", async () => {
    const rt = makeRuntime();
    const id = await persistThroughSchema(rt, "tp-ap-record", {
      type: "object",
      additionalProperties: {
        type: "string",
        ifc: { confidentiality: ["map-member"] },
      },
    } as JSONSchema, { anyKey: "v" });

    const declared = entriesOf(id).filter((e) => e.origin === "declared");
    expect(declared).toEqual([{
      path: ["*"],
      label: { confidentiality: ["map-member"] },
      origin: "declared",
    }]);
  });

  it("mixed properties + additionalProperties mints NO `*` entry (§4 restriction)", async () => {
    const rt = makeRuntime();
    const id = await persistThroughSchema(rt, "tp-ap-mixed", {
      type: "object",
      properties: {
        named: { type: "string", ifc: { confidentiality: ["named-field"] } },
      },
      additionalProperties: {
        type: "string",
        ifc: { confidentiality: ["map-member"] },
      },
    } as JSONSchema, { named: "v", extra: "w" });

    const stored = entriesOf(id);
    expect(stored.some((e) => e.path.includes("*"))).toBe(false);
    expect(JSON.stringify(stored)).not.toContain("map-member");
    // The named field's declared entry still lands.
    expect(
      stored.some((e) =>
        e.origin === "declared" && e.path.join("/") === "named"
      ),
    ).toBe(true);
  });

  it("boolean additionalProperties never descends", async () => {
    const rt = makeRuntime();
    const id = await persistThroughSchema(rt, "tp-ap-bool", {
      type: "object",
      additionalProperties: true,
      ifc: { confidentiality: ["root-label"] },
    } as JSONSchema, { k: 1 });
    const stored = entriesOf(id);
    expect(stored.some((e) => e.path.includes("*"))).toBe(false);
  });
});

// Inv-12 Stage 1 rides along (design §3.3): template entries opt into the
// cross-space representation transform at mint exactly like the container
// stamps they accompany — a membership J fed by a foreign labeled read
// persists in commitment form under `enforce`.
describe("CFC template population (Stage A): cross-space label protection", () => {
  const userAtom = { type: CFC_ATOM_TYPE.User, subject: "did:key:alice" };

  it("templates with cross-space J persist commitment forms under enforce", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
      cfcLabelMetadataProtection: "enforce",
    });
    try {
      // Foreign labeled criteria doc in spaceA.
      const seed = runtime.edit();
      const criteria = runtime.getCell(
        foreignSpace,
        "tp-xs-criteria",
        undefined,
        seed,
      );
      const criteriaId = criteria.getAsNormalizedFullLink().id;
      seed.writeOrThrow(
        { space: foreignSpace, scope: "space", id: criteriaId, path: [] },
        {
          value: { keep: true },
          cfc: {
            version: 1,
            schemaHash: "seed-schema",
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { confidentiality: [userAtom] } }],
            },
          },
        },
      );
      expect((await seed.commit()).ok).toBeDefined();

      // Declared container in the local space whose membership J consumed
      // the foreign read.
      const tx = runtime.edit();
      tx.readOrThrow({
        space: foreignSpace,
        scope: "space",
        id: criteriaId,
        type: "application/json",
        path: ["value"],
      });
      const el = runtime.getCell(space, "tp-xs-el", undefined, tx);
      const list = runtime.getCell(space, "tp-xs-list", {
        type: "array",
        items: { asCell: ["cell"] },
      }, tx);
      list.set([el]);
      const listId = list.getAsNormalizedFullLink().id;
      tx.recordCfcStructureContainer({
        space,
        id: listId,
        scope: "space",
        path: [],
      });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const replica = storageManager.open(space).replica as unknown as {
        getDocument(id: string): {
          cfc?: { labelMap?: { entries: StoredEntry[] } };
        } | undefined;
      };
      const entries = replica.getDocument(listId)?.cfc?.labelMap?.entries ??
        [];
      const templates = entries.filter((e) =>
        e.origin === "structure" && e.path.length === 1 && e.path[0] === "*"
      );
      expect(templates.length).toBe(3);
      for (const entry of templates) {
        expect(entry.label.confidentiality).toContainEqual({
          type: CFC_ATOM_TYPE.User,
          subject: commitCfcFieldValue("did:key:alice"),
        });
      }
      expect(JSON.stringify(entries)).not.toContain("did:key:alice");
      expect(containsCfcFieldCommitment(entries)).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

// Canonicalization and coalescing over multi-`*` paths (design §3.3 "no
// changes required" — verified, not assumed).
describe("CFC template population (Stage A): canonical form with `*` paths", () => {
  const entry = (
    path: string[],
    atom: string,
    observes?: string,
  ): LabelMapEntry => ({
    path,
    label: { confidentiality: [atom] },
    origin: "structure",
    ...(observes !== undefined
      ? { observes: observes as LabelMapEntry["observes"] }
      : {}),
  });

  it("sorts multi-`*` template entries deterministically and keeps classes separate", () => {
    const entries: LabelMapEntry[] = [
      entry(["items", "*"], "a", "value"),
      entry(["items", "*", "*"], "b", "shape"),
      entry(["items", "*"], "c", "shape"),
      entry(["items", "*"], "d", "followRef"),
      entry(["items", "0"], "e", "shape"),
    ];
    const canonical = canonicalizeCfcMetadata({
      version: 1,
      schemaHash: "h",
      labelMap: { version: 1, entries },
    });
    // Deterministic: same set in any input order canonicalizes identically.
    const permuted = canonicalizeCfcMetadata({
      version: 1,
      schemaHash: "h",
      labelMap: { version: 1, entries: [...entries].reverse() },
    });
    expect(permuted).toEqual(canonical);
    // Idempotent.
    expect(canonicalizeCfcMetadata(canonical)).toEqual(canonical);
    // No cross-class merge: all five entries survive distinct, ordered by
    // (path pointer, origin, observes).
    expect(
      canonical.labelMap.entries.map((e) => [e.path.join("/"), e.observes]),
    ).toEqual([
      ["items/*", "followRef"],
      ["items/*", "shape"],
      ["items/*", "value"],
      ["items/*/*", "shape"],
      ["items/0", "shape"],
    ]);
  });
});
