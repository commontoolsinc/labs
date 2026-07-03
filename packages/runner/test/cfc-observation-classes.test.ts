import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { linkResolutionProbe } from "../src/storage/reactivity-log.ts";
import { canonicalizeCfcMetadata } from "../src/cfc/canonical.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-observation-classes");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

// Epic C stage C1 (docs/specs/cfc-observation-classes.md §4/§6): flow
// observations are classified by WHAT they observed — recursive value read,
// nonRecursive shape read, or followRef slot-pointer probe — and consume
// only class-compatible labelMap entries.
//
// The parity contract is SCOPED (C0 §6): value/shape/enumerate reads over
// legacy covering entries stay byte-identical to the pre-C1 join; the
// followRef path intentionally WIDENS — a standalone slot-pointer probe now
// consumes the pointer's link-origin label, which is the SC-8 fix — and is
// asserted below as the new, wider join, not claimed as parity.
describe("CFC observation classes (C1 read-shape plumbing)", () => {
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

  const derivedConfidentiality = (id: string): string[] | undefined =>
    entriesOf(id).find((e) => e.origin === "derived")?.label.confidentiality;

  const readAddress = (id: string, path: string[]) => ({
    space,
    scope: "space" as const,
    id: id as `${string}:${string}`,
    type: "application/json" as const,
    path: ["value", ...path],
  });

  // The doc every test seeds: a legacy covering entry at the root, a
  // covering derived entry on a field, and a link-origin pointer label on a
  // slot (implicitly `observes:"followRef"` per the C0 §3 carve-out).
  const seedMixedDoc = (rt: Runtime, cause: string) =>
    seedDoc(rt, cause, { field: "f", slot: { "/": { "link@1": {} } } }, [
      { path: [], label: { confidentiality: ["root-covering"] } },
      {
        path: ["field"],
        label: { confidentiality: ["field-derived"] },
        origin: "derived",
      },
      {
        path: ["slot"],
        label: { confidentiality: ["pointer-label"] },
        origin: "link",
      },
    ]);

  // Runs `observe` inside a fresh tx that also writes an output doc, then
  // commits (prepareCfc explicitly unless `autoRelevance`), and returns the
  // output doc's derived flow confidentiality.
  const flowJoinOf = async (
    rt: Runtime,
    outCause: string,
    observe: (tx: ReturnType<Runtime["edit"]>) => void,
    options?: { autoRelevance?: boolean },
  ): Promise<string[] | undefined> => {
    const tx = rt.edit();
    observe(tx);
    const out = rt.getCell(space, outCause, undefined, tx);
    out.set({ copied: true });
    if (!options?.autoRelevance) {
      tx.prepareCfc();
    }
    expect((await tx.commit()).ok).toBeDefined();
    return derivedConfidentiality(out.getAsNormalizedFullLink().id);
  };

  // C0 §6 parity, scoped: a recursive VALUE read joins the covering root
  // entry and the descendant derived entry — byte-identical to the pre-C1
  // join — and still never consumes the link-origin pointer label (the
  // §3 carve-out: origin:"link" with absent observes is followRef-only,
  // never covering).
  it("value reads: legacy covering join is byte-identical; link-origin entries stay excluded", async () => {
    const rt = makeRuntime();
    const id = await seedMixedDoc(rt, "occ-value-read");
    const join = await flowJoinOf(rt, "occ-value-out", (tx) => {
      tx.readOrThrow(readAddress(id, []));
    });
    expect(join).toEqual(["root-covering", "field-derived"]);
  });

  // Shape reads (nonRecursive: key-add, length — the spec's `count` class
  // folds into `enumerate`, C0 §4) consume covering + shape + enumerate
  // entries at the node: not descendants, not value-class entries, not
  // pointer labels.
  it("shape reads consume enumerate + covering at the node only; value-class entries are skipped", async () => {
    const rt = makeRuntime();
    const id = await seedDoc(rt, "occ-shape-read", { field: "f" }, [
      { path: [], label: { confidentiality: ["root-covering"] } },
      {
        path: [],
        label: { confidentiality: ["members-secret"] },
        origin: "derived",
        observes: "enumerate",
      },
      {
        path: [],
        label: { confidentiality: ["content-secret"] },
        origin: "derived",
        observes: "value",
      },
      {
        path: ["field"],
        label: { confidentiality: ["field-derived"] },
        origin: "derived",
      },
    ]);
    const join = await flowJoinOf(rt, "occ-shape-out", (tx) => {
      tx.readOrThrow(readAddress(id, []), { nonRecursive: true });
    });
    expect(join).toEqual(["root-covering", "members-secret"]);
  });

  // The SC-8 widening (NOT parity — C0 §6 scopes it out deliberately): a
  // standalone slot-pointer probe — a `linkResolutionProbe` read with no
  // dereference trace covering the slot — observed WHICH reference sits at
  // the slot. Pre-C1 this observation was skipped and the flow join stayed
  // empty; it now consumes the pointer's link-origin label, and ONLY that:
  // covering entries label content/shape a pointer observation never read.
  it("standalone probes consume the link-origin pointer label (SC-8 widening, the new wider join)", async () => {
    const rt = makeRuntime();
    const id = await seedMixedDoc(rt, "occ-probe-read");
    const join = await flowJoinOf(rt, "occ-probe-out", (tx) => {
      tx.read(readAddress(id, ["slot"]), { meta: linkResolutionProbe });
    });
    expect(join).toEqual(["pointer-label"]);
  });

  // The relevance trigger widens with the reader: a tx whose only labeled
  // contact is a standalone probe over a doc holding only a link-origin
  // entry must auto-mark flow relevance at commit (no prepareCfc call).
  it("standalone probes auto-mark flow relevance without an explicit prepareCfc", async () => {
    const rt = makeRuntime();
    const id = await seedDoc(rt, "occ-probe-relevance", {
      slot: { "/": { "link@1": {} } },
    }, [
      {
        path: ["slot"],
        label: { confidentiality: ["pointer-label"] },
        origin: "link",
      },
    ]);
    const join = await flowJoinOf(rt, "occ-probe-relevance-out", (tx) => {
      tx.read(readAddress(id, ["slot"]), { meta: linkResolutionProbe });
    }, { autoRelevance: true });
    expect(join).toEqual(["pointer-label"]);
  });

  // C0 §4's dereference row stays unchanged: a probe that belongs to a
  // dereference this tx performed (a recorded trace source at-or-above the
  // probed path) is resolution machinery, not a followRef observation — the
  // taint of what was read arrives via ordinary reads of the target.
  it("probes covered by a dereference trace are machinery: no followRef consumption", async () => {
    const rt = makeRuntime();
    const id = await seedMixedDoc(rt, "occ-deref-read");
    const join = await flowJoinOf(rt, "occ-deref-out", (tx) => {
      tx.read(readAddress(id, ["slot"]), { meta: linkResolutionProbe });
      tx.recordCfcDereferenceTrace({
        source: { space, id, scope: "space", path: ["slot"] },
        target: {
          space,
          id: "of:target-doc",
          scope: "space",
          path: [],
        },
        kind: "value",
      });
    });
    expect(join).toBeUndefined();
  });

  // Explicit `observes:"followRef"` entries behave like the implicit link
  // carve-out: consumed by probes only, never as covering entries.
  it("explicit followRef entries are consumed by probes only", async () => {
    const rt = makeRuntime();
    const seed = (cause: string) =>
      seedDoc(rt, cause, { slot: { "/": { "link@1": {} } } }, [
        {
          path: ["slot"],
          label: { confidentiality: ["ref-secret"] },
          origin: "derived",
          observes: "followRef",
        },
      ]);

    const valueId = await seed("occ-explicit-followref-value");
    const valueJoin = await flowJoinOf(rt, "occ-explicit-value-out", (tx) => {
      tx.readOrThrow(readAddress(valueId, []));
    });
    expect(valueJoin).toBeUndefined();

    const probeId = await seed("occ-explicit-followref-probe");
    const probeJoin = await flowJoinOf(rt, "occ-explicit-probe-out", (tx) => {
      tx.read(readAddress(probeId, ["slot"]), { meta: linkResolutionProbe });
    });
    expect(probeJoin).toEqual(["ref-secret"]);
  });

  // followRef observations contribute confidentiality only: the hereditary
  // integrity meet quantifies over the transformation's content inputs
  // (§8.9.3), so a standalone probe that resolves no label must not empty
  // the meet and end certification propagation.
  it("followRef observations do not participate in the hereditary integrity meet", async () => {
    const rt = makeRuntime();
    const certified = {
      type: CFC_ATOM_TYPE.PolicyCertified,
      policy: "p1",
    };
    const certifiedId = await seedDoc(rt, "occ-meet-certified", { n: 1 }, [
      {
        path: [],
        label: {
          confidentiality: ["certified-secret"],
          integrity: [certified],
        },
      },
    ]);
    const bareId = await seedDoc(rt, "occ-meet-bare", {
      slot: { "/": { "link@1": {} } },
    }, []);

    const tx = rt.edit();
    tx.readOrThrow(readAddress(certifiedId, []));
    // A standalone probe of an unlabeled slot: resolves no label. Letting it
    // into the meet would empty it.
    tx.read(readAddress(bareId, ["slot"]), { meta: linkResolutionProbe });
    // Read-free write (`cell.set()` would journal an uncertified read of the
    // output doc's prior value and rightly empty the meet on its own).
    const out = rt.getCell(space, "occ-meet-out", undefined, tx);
    const outId = out.getAsNormalizedFullLink().id;
    tx.writeOrThrow(
      { space, scope: "space", id: outId, path: ["value"] },
      { copied: true },
    );
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    // C2 splits the derived stamp into a value + shape pair (integrity
    // rides the value entry) — collect across the pair.
    const derived = entriesOf(outId).filter((e) => e.origin === "derived");
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.flatMap((e) => e.label.integrity ?? []))
      .toContainEqual(certified);
  });

  // The class axis survives persistence: canonicalization keeps `observes`
  // (ordering per-class deterministically), and the persist region's
  // carry-forward of untouched paths preserves it across unrelated writes.
  it("canonicalization and carry-forward preserve the observes axis", async () => {
    const canonical = canonicalizeCfcMetadata({
      version: 1,
      schemaHash: "h",
      labelMap: {
        version: 1,
        entries: [
          {
            path: ["a"],
            label: { confidentiality: ["s"] },
            origin: "derived",
            observes: "value",
          },
          {
            path: ["a"],
            label: { confidentiality: ["e"] },
            origin: "derived",
            observes: "shape",
          },
        ],
      },
    });
    expect(canonical.labelMap.entries.map((e) => e.observes)).toEqual([
      "shape",
      "value",
    ]);

    const rt = makeRuntime();
    // The persist region only rewrites a doc whose stored schemaHash loads
    // (and skips docs entirely when the flow join is empty), so exercising
    // carry-forward needs a real interned schema + its cid: document + a
    // labeled read making the flow join non-empty.
    const guarded = internSchema({ type: "object" } as JSONSchema, true);
    const seed = rt.edit();
    const cell0 = rt.getCell(space, "occ-carry-forward", undefined, seed);
    const id = cell0.getAsNormalizedFullLink().id;
    seed.writeOrThrow({ space, scope: "space", id, path: [] }, {
      value: { slot: { "/": { "link@1": {} } }, other: 1 },
      cfc: {
        version: 1,
        schemaHash: guarded.taggedHashString,
        labelMap: {
          version: 1,
          entries: [
            {
              path: ["slot"],
              label: { confidentiality: ["ref-secret"] },
              origin: "derived",
              observes: "followRef",
            },
            // The C2 persist-split shape: same (path, origin), distinct
            // classes. Coalescing keys per class — merging these into one
            // covering entry would both widen (value reads would consume
            // the existence label) and destroy the SC-4 grow-vs-replace
            // split.
            {
              path: ["v"],
              label: { confidentiality: ["v-content"] },
              origin: "derived",
              observes: "value",
            },
            {
              path: ["v"],
              label: { confidentiality: ["v-existence"] },
              origin: "derived",
              observes: "shape",
            },
          ],
        },
      },
    });
    seed.writeOrThrow({
      space,
      scope: "space",
      id: `cid:${guarded.taggedHashString}`,
      path: [],
    }, { value: guarded.schema });
    expect((await seed.commit()).ok).toBeDefined();
    const taintId = await seedDoc(rt, "occ-carry-forward-taint", { n: 1 }, [
      { path: [], label: { confidentiality: ["taint"] } },
    ]);

    const tx = rt.edit();
    tx.readOrThrow(readAddress(taintId, []));
    const cell = rt.getCell(space, "occ-carry-forward", undefined, tx);
    cell.key("other").set(2);
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const stored = entriesOf(id);
    // The write really did rewrite the labelMap (the flow stamp landed) —
    // without this the assertions below pass trivially on untouched
    // metadata.
    expect(
      stored.find((e) => e.origin === "derived" && e.path.join("/") === "other")
        ?.label.confidentiality,
    ).toEqual(["taint"]);
    const slotEntry = stored.find((e) => e.path.join("/") === "slot");
    expect(slotEntry).toBeDefined();
    expect(slotEntry!.observes).toBe("followRef");
    const vClasses = stored.filter((e) => e.path.join("/") === "v")
      .map((e) => [e.observes, ...(e.label.confidentiality ?? [])]);
    expect(vClasses.sort()).toEqual([
      ["shape", "v-existence"],
      ["value", "v-content"],
    ]);
  });
});
