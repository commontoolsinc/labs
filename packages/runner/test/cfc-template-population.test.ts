import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { linkResolutionProbe } from "../src/storage/reactivity-log.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-template-population");
const space = signer.did();

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
});
