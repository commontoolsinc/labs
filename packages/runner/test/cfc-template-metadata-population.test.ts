import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { canonicalizeCfcMetadata } from "../src/cfc/canonical.ts";
import {
  deriveLabelMetadataTemplateEntries,
  resolveLabelMetadataTemplateConfidentiality,
} from "../src/cfc/label-metadata-population.ts";
import {
  evaluateConfLabelQuery,
  inspectStoredConfLabel,
} from "../src/cfc/label-introspection.ts";
import { containsCfcFieldCommitment } from "../src/cfc/label-representation.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { CfcMetadata, LabelMapEntry } from "../src/cfc/types.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-template-metadata-population",
);
const foreignSigner = await Identity.fromPassphrase(
  "runner-cfc-template-metadata-population-foreign",
);
const space = signer.did();
const foreignSpace = foreignSigner.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: unknown[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

const SOURCE_A = { space: "did:key:remote-a", id: "of:origin-a", path: [] };
const SOURCE_B = { space: "did:key:remote-b", id: "of:origin-b", path: [] };

const caveatAtom = (source: unknown = SOURCE_A) => ({
  type: CFC_ATOM_TYPE.Caveat,
  kind: "prompt-influence",
  source,
});

const metadataWith = (
  entries: CfcMetadata["labelMap"]["entries"],
): CfcMetadata => ({
  version: 1,
  schemaHash: "test-schema",
  labelMap: { version: 1, entries },
});

/** A persisted label-metadata population template, as the mint produces it. */
const templateEntry = (
  targetPath: string[],
  tail: string[],
  confidentiality: unknown[],
): LabelMapEntry => ({
  path: [
    "cfc",
    "labels",
    "value",
    ...targetPath,
    "confidentiality",
    "clauses",
    "*",
    "alternatives",
    "*",
    ...tail,
  ],
  label: { confidentiality },
  origin: "label-metadata",
  observes: "labelMetadata",
});

// Stage B of docs/specs/cfc-template-population.md (§5/§6; spec §4.6.4.1-.2):
// the §4.6.4.2 field-precise label-metadata population profile, carried as
// multi-`*` templates under /cfc/labels/<target-envelope-path>/... — minted at
// the envelope persist seam from each source-bearing derived-containment
// payload entry, consumed ONLY by the introspection surface (which resolves
// them at concrete clause/alternative paths through the wildcard machinery,
// falling back to the computed-in-hand interim rule for pre-Stage-B
// envelopes).

describe("CFC template metadata population (Stage B): persist-seam mints", () => {
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

  // One transaction that reads the labeled criteria doc and writes an out
  // doc: the out doc's derived value/shape entries carry the criteria's J.
  const deriveOutDoc = async (
    rt: Runtime,
    outCause: string,
    criteriaId: string,
    value: unknown = { observed: true },
  ): Promise<string> => {
    const tx = rt.edit();
    tx.readOrThrow(readAddress(criteriaId, []));
    const out = rt.getCell(space, outCause, undefined, tx);
    out.set(value as never);
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    return out.getAsNormalizedFullLink().id;
  };

  // The spec's example shape (§4.6.4.2): a derived entry whose clause list
  // carries Caveat(kind, source=S). The persist seam mints the whole-atom
  // projection template and the per-field `source` template at the multi-`*`
  // metadata paths, both carrying the interim-rule label (the entry's own
  // effective confidentiality), confidentiality-only.
  it("mints the multi-`*` templates for a derived entry with Caveat.source", async () => {
    const rt = makeRuntime();
    const criteriaId = await seedDoc(rt, "mp-criteria", { keep: true }, [
      { path: [], label: { confidentiality: [caveatAtom()] } },
    ]);
    const outId = await deriveOutDoc(rt, "mp-out", criteriaId);

    const templates = entriesOf(outId).filter(
      (e) => e.origin === "label-metadata",
    );
    expect(templates.map((e) => [e.path.join("/"), e.observes])).toEqual([
      [
        "cfc/labels/value/confidentiality/clauses/*/alternatives/*",
        "labelMetadata",
      ],
      [
        "cfc/labels/value/confidentiality/clauses/*/alternatives/*/source",
        "labelMetadata",
      ],
    ]);
    for (const entry of templates) {
      expect(entry.label.confidentiality).toEqual([caveatAtom()]);
      expect(entry.label.integrity).toBeUndefined();
    }
    // Presence/type/kind stay public: NO template materializes for them
    // (absence = public under the §4.6.4.2 default profile).
    expect(templates.some((e) => e.path.at(-1) === "type")).toBe(false);
    expect(templates.some((e) => e.path.at(-1) === "kind")).toBe(false);
  });

  // Declared/authored entries carry no containment guarantee: their
  // source-bearing fields are fail-closed UNOBSERVABLE under the interim
  // rule, so the mint materializes nothing for them (a template would imply
  // an observation label exists).
  it("mints nothing for declared source-bearing entries", async () => {
    const rt = makeRuntime();
    const guarded = internSchema(
      {
        type: "object",
        ifc: { confidentiality: [caveatAtom()] },
      } as JSONSchema,
      true,
    );
    const tx = rt.edit();
    const cell = rt.getCell(space, "mp-declared", guarded.schema, tx);
    cell.set({ n: 1 } as never);
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    const id = cell.getAsNormalizedFullLink().id;

    const stored = entriesOf(id);
    expect(stored.some((e) => e.origin === "declared")).toBe(true);
    expect(stored.some((e) => e.origin === "label-metadata")).toBe(false);
  });

  // All-public atoms (string tags; authored-attribution claims whose every
  // field is table-public) have nothing source-protected to label: no
  // templates.
  it("mints nothing when the derived label has no protected fields", async () => {
    const rt = makeRuntime();
    const criteriaId = await seedDoc(rt, "mp-criteria-pub", { keep: true }, [
      {
        path: [],
        label: {
          confidentiality: [
            "public-tag",
            { kind: "authored-by", subject: "did:key:alice" },
          ],
        },
      },
    ]);
    const outId = await deriveOutDoc(rt, "mp-out-pub", criteriaId);

    const stored = entriesOf(outId);
    expect(stored.some((e) => e.origin === "derived")).toBe(true);
    expect(stored.some((e) => e.origin === "label-metadata")).toBe(false);
  });

  // Replace-on-overwrite alongside the payload entry they describe: a
  // re-derivation under a new J replaces the derived value entry AND its
  // templates — the departed J's atoms leave the templates entirely.
  it("overwrite replaces the templates with the payload entry they describe", async () => {
    const rt = makeRuntime();
    // Creation under a NON-source-bearing J so the frozen shape entry never
    // contributes template atoms of its own.
    const plainId = await seedDoc(rt, "mp-criteria-plain", { keep: true }, [
      { path: [], label: { confidentiality: ["plain-tag"] } },
    ]);
    const criteriaB = await seedDoc(rt, "mp-criteria-b", { keep: true }, [
      { path: [], label: { confidentiality: [caveatAtom(SOURCE_A)] } },
    ]);
    const criteriaC = await seedDoc(rt, "mp-criteria-c", { keep: true }, [
      { path: [], label: { confidentiality: [caveatAtom(SOURCE_B)] } },
    ]);

    const outId = await deriveOutDoc(rt, "mp-out-replace", plainId);
    expect(entriesOf(outId).some((e) => e.origin === "label-metadata")).toBe(
      false,
    );

    // Overwrite under J = caveat(SOURCE_A): templates appear with it.
    const txB = rt.edit();
    txB.readOrThrow(readAddress(criteriaB, []));
    txB.writeOrThrow(
      {
        space,
        scope: "space",
        id: outId as `${string}:${string}`,
        path: [
          "value",
        ],
      },
      { observed: "second" },
    );
    txB.prepareCfc();
    expect((await txB.commit()).ok).toBeDefined();
    const afterB = entriesOf(outId).filter(
      (e) => e.origin === "label-metadata",
    );
    expect(afterB.length).toBe(2);
    for (const entry of afterB) {
      expect(entry.label.confidentiality).toContainEqual(caveatAtom(SOURCE_A));
    }

    // Overwrite under J = caveat(SOURCE_B): SOURCE_A leaves with its entry.
    const txC = rt.edit();
    txC.readOrThrow(readAddress(criteriaC, []));
    txC.writeOrThrow(
      {
        space,
        scope: "space",
        id: outId as `${string}:${string}`,
        path: [
          "value",
        ],
      },
      { observed: "third" },
    );
    txC.prepareCfc();
    expect((await txC.commit()).ok).toBeDefined();
    const afterC = entriesOf(outId).filter(
      (e) => e.origin === "label-metadata",
    );
    expect(afterC.length).toBe(2);
    for (const entry of afterC) {
      expect(entry.label.confidentiality).toContainEqual(caveatAtom(SOURCE_B));
      expect(entry.label.confidentiality).not.toContainEqual(
        caveatAtom(SOURCE_A),
      );
    }
  });

  // SC-11 with metadata templates present: an identical re-derivation is
  // canonically equal to the stored envelope and must not write ["cfc"].
  it("recompute with metadata templates present is a no-op (SC-11)", async () => {
    const rt = makeRuntime();
    const criteriaId = await seedDoc(rt, "mp-criteria-i", { keep: true }, [
      { path: [], label: { confidentiality: [caveatAtom()] } },
    ]);
    const outId = await deriveOutDoc(rt, "mp-out-i", criteriaId, {
      observed: "same",
    });
    expect(
      entriesOf(outId).some((e) => e.origin === "label-metadata"),
    ).toBe(true);
    const before = JSON.stringify(entriesOf(outId));

    const again = rt.edit();
    again.readOrThrow(readAddress(criteriaId, []));
    again.writeOrThrow(
      {
        space,
        scope: "space",
        id: outId as `${string}:${string}`,
        path: [
          "value",
        ],
      },
      { observed: "same" },
    );
    again.prepareCfc();
    const wroteCfc = [...(again.getWriteDetails?.(space) ?? [])].some(
      (w) => w.address.id === outId && w.address.path[0] === "cfc",
    );
    expect(wroteCfc).toBe(false);
    expect((await again.commit()).ok).toBeDefined();
    expect(JSON.stringify(entriesOf(outId))).toEqual(before);
  });

  // Stage-A composition: the membership templates a declared list
  // coordinator mints at [...container,"*"] are derived-containment payload
  // entries with `*` in their TARGET path — their metadata templates nest
  // wildcards three deep and still resolve for concrete slot queries.
  it("mints metadata templates for `*`-path membership entries and resolves them at slots", async () => {
    const rt = makeRuntime();
    await seedDoc(rt, "mp-el", { n: 1 }, []);
    const criteriaId = await seedDoc(rt, "mp-criteria-list", { keep: true }, [
      { path: [], label: { confidentiality: [caveatAtom()] } },
    ]);
    const tx = rt.edit();
    tx.readOrThrow(readAddress(criteriaId, []));
    const member = rt.getCell(space, "mp-el", undefined, tx);
    const list = rt.getCell(space, "mp-list", {
      type: "array",
      items: { asCell: ["cell"] },
    }, tx);
    list.set([member]);
    const listId = list.getAsNormalizedFullLink().id;
    tx.recordCfcStructureContainer({
      space,
      id: listId,
      scope: "space",
      path: [],
    });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const templates = entriesOf(listId).filter(
      (e) => e.origin === "label-metadata",
    );
    // Container-anchored entries (enumerate + frozen shape at []) and the
    // three `*`-child twins each carry the caveat J: one whole-atom + one
    // `source` template per target path — 4 total, the slot pair with the
    // `*` target segment.
    expect(templates.map((e) => e.path.join("/")).sort()).toEqual([
      "cfc/labels/value/*/confidentiality/clauses/*/alternatives/*",
      "cfc/labels/value/*/confidentiality/clauses/*/alternatives/*/source",
      "cfc/labels/value/confidentiality/clauses/*/alternatives/*",
      "cfc/labels/value/confidentiality/clauses/*/alternatives/*/source",
    ]);

    // A slot-addressed introspection ("/0") resolves the `*`-target
    // templates at its concrete consultation paths.
    const inspect = rt.edit();
    const outcome = inspectStoredConfLabel(
      inspect,
      list.getAsNormalizedFullLink(),
      "/0",
      { source: SOURCE_A },
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.atoms.length).toBeGreaterThan(0);
    const observations = inspect.getCfcState().labelMetadataObservations;
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect([...observation.target.path].slice(0, 4)).toEqual([
        "cfc",
        "labels",
        "value",
        "0",
      ]);
      expect([...observation.confidentiality]).toContainEqual(caveatAtom());
    }
    await inspect.commit();
  });

  // Inv-12 Stage 1 rides along: templates derive from the FINAL (post
  // representation transform) payload labels, so a cross-space J persists in
  // commitment form in the templates too — and digest-matching still
  // consumes the right template.
  it("commitment-form templates: digest-matched source queries consume the committed template", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
      cfcLabelMetadataProtection: "enforce",
    });
    const rt = runtime;
    // Foreign labeled doc whose label carries a Caveat with plaintext source.
    const seed = rt.edit();
    const criteria = rt.getCell(
      foreignSpace,
      "mp-xs-criteria",
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
            entries: [
              { path: [], label: { confidentiality: [caveatAtom()] } },
            ],
          },
        },
      },
    );
    expect((await seed.commit()).ok).toBeDefined();

    const tx = rt.edit();
    tx.readOrThrow({
      space: foreignSpace,
      scope: "space",
      id: criteriaId,
      type: "application/json",
      path: ["value"],
    });
    const out = rt.getCell(space, "mp-xs-out", undefined, tx);
    out.set({ observed: true });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    const outId = out.getAsNormalizedFullLink().id;

    const templates = entriesOf(outId).filter(
      (e) => e.origin === "label-metadata",
    );
    expect(templates.length).toBe(2);
    // The templates carry the committed form — no plaintext source anywhere.
    expect(containsCfcFieldCommitment(templates)).toBe(true);
    expect(JSON.stringify(templates)).not.toContain("did:key:remote-a");

    // Digest-matching: the plaintext query still matches the committed
    // stored field, and the consumed observation carries the committed
    // template label.
    const inspect = rt.edit();
    const outcome = inspectStoredConfLabel(
      inspect,
      out.getAsNormalizedFullLink(),
      "",
      { source: SOURCE_A },
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.atoms.length).toBeGreaterThan(0);
    expect(containsCfcFieldCommitment(outcome.atoms[0].atom)).toBe(true);
    const observations = inspect.getCfcState().labelMetadataObservations;
    expect(observations.length).toBeGreaterThan(0);
    expect(
      containsCfcFieldCommitment(
        observations.map((o) => [...o.confidentiality]),
      ),
    ).toBe(true);
    expect(
      JSON.stringify(observations.map((o) => [...o.confidentiality])),
    ).not.toContain("did:key:remote-a");
    await inspect.commit();
  });

  // Guardrail: metadata templates are NOT payload labels. Payload reads —
  // recursive value reads, shape probes — never consume them (pinned with a
  // template carrying a DISTINCT atom, which runtime mints never produce),
  // and raw ["cfc"] envelope reads stay flow-excluded entirely.
  it("payload reads never consume metadata templates; raw cfc reads stay excluded", async () => {
    const rt = makeRuntime();
    const seededId = await seedDoc(rt, "mp-guard", { x: 1 }, [
      {
        path: [],
        label: { confidentiality: ["payload-label", caveatAtom()] },
        origin: "derived",
        observes: "value",
      },
      templateEntry([], [], ["tmpl-only-atom"]),
      templateEntry([], ["source"], ["tmpl-only-atom"]),
    ]);

    const derivedConfidentiality = (id: string): unknown[] =>
      entriesOf(id)
        .filter((e) => e.origin === "derived")
        .flatMap((e) => e.label.confidentiality ?? []);

    // Recursive value read at the root.
    const txValue = rt.edit();
    txValue.readOrThrow(readAddress(seededId, []));
    const outValue = rt.getCell(
      space,
      "mp-guard-out-value",
      undefined,
      txValue,
    );
    outValue.set({ observed: true });
    txValue.prepareCfc();
    expect((await txValue.commit()).ok).toBeDefined();
    const joinValue = derivedConfidentiality(
      outValue.getAsNormalizedFullLink().id,
    );
    expect(joinValue).toContainEqual("payload-label");
    expect(joinValue).not.toContainEqual("tmpl-only-atom");

    // Shape probe (nonRecursive) at the root.
    const txShape = rt.edit();
    txShape.readOrThrow(readAddress(seededId, []), { nonRecursive: true });
    const outShape = rt.getCell(
      space,
      "mp-guard-out-shape",
      undefined,
      txShape,
    );
    outShape.set({ observed: true });
    txShape.prepareCfc();
    expect((await txShape.commit()).ok).toBeDefined();
    expect(
      derivedConfidentiality(outShape.getAsNormalizedFullLink().id),
    ).not.toContainEqual("tmpl-only-atom");

    // Raw ["cfc"] envelope read: flow-excluded (flowReadExcluded), so not
    // even the payload label taints through it.
    const txRaw = rt.edit();
    txRaw.readOrThrow({
      space,
      scope: "space",
      id: seededId as `${string}:${string}`,
      type: "application/json",
      path: ["cfc"],
    });
    const outRaw = rt.getCell(space, "mp-guard-out-raw", undefined, txRaw);
    outRaw.set({ observed: true });
    txRaw.prepareCfc();
    expect((await txRaw.commit()).ok).toBeDefined();
    const rawId = outRaw.getAsNormalizedFullLink().id;
    expect(derivedConfidentiality(rawId)).toEqual([]);

    // The introspection surface is their one consumer: the SAME distinct
    // atom the payload reads never saw is exactly what a query consumes.
    const inspect = rt.edit();
    const evaluation = evaluateConfLabelQuery(
      readStoredCfcMetadata(inspect, { space, id: seededId }),
      [],
      { source: SOURCE_A },
    );
    await inspect.commit();
    expect(evaluation.consumedConfidentiality).toContainEqual(
      "tmpl-only-atom",
    );
    expect(evaluation.consumedConfidentiality).not.toContainEqual(
      "payload-label",
    );
  });

  // The recorded labelMetadata observations reference the CONCRETE metadata
  // paths the evaluation consulted (clause/alternative indices), not the
  // subtree root.
  it("records observations at concrete clause/alternative metadata paths", async () => {
    const rt = makeRuntime();
    const criteriaId = await seedDoc(rt, "mp-criteria-obs", { keep: true }, [
      { path: [], label: { confidentiality: [caveatAtom()] } },
    ]);
    await deriveOutDoc(rt, "mp-out-obs", criteriaId);

    const inspect = rt.edit();
    const out = rt.getCell(space, "mp-out-obs", undefined, inspect);
    const outcome = inspectStoredConfLabel(
      inspect,
      out.getAsNormalizedFullLink(),
      "",
      { source: SOURCE_A },
    );
    expect(outcome.status).toBe("ok");
    const paths = inspect.getCfcState().labelMetadataObservations.map(
      (observation) => [...observation.target.path].join("/"),
    ).sort();
    // The out doc carries the derived shape + value entries at [] (stored in
    // that canonical order), each with the caveat clause: per matching atom,
    // one field consultation and one whole-atom projection, at concrete
    // clause indices across the concatenated per-entry clause lists.
    expect(paths).toEqual([
      "cfc/labels/value/confidentiality/clauses/0/alternatives/0",
      "cfc/labels/value/confidentiality/clauses/0/alternatives/0/source",
      "cfc/labels/value/confidentiality/clauses/1/alternatives/0",
      "cfc/labels/value/confidentiality/clauses/1/alternatives/0/source",
    ]);
    await inspect.commit();
  });
});

describe("CFC template metadata population (Stage B): evaluator resolution", () => {
  // A derived-component entry guarding /value/body with a source-bearing
  // caveat clause — the interim-rule shape.
  const derivedBodyEntry = (atom: unknown = caveatAtom()): LabelMapEntry => ({
    path: ["body"],
    label: { confidentiality: ["secret", atom] },
    origin: "derived",
  });

  it("resolves per-field observation labels from the persisted template", () => {
    const metadata = metadataWith([
      derivedBodyEntry(),
      templateEntry(["body"], [], ["tmpl-atom-label"]),
      templateEntry(["body"], ["source"], ["tmpl-source-label"]),
    ]);
    const { result, consumedConfidentiality, consumedObservations } =
      evaluateConfLabelQuery(metadata, ["body"], { source: SOURCE_A });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.atoms).toHaveLength(1);
    // The templates are the label CARRIER now: the consumed labels come from
    // them, not from the in-hand fallback (the entry's own confidentiality).
    expect(consumedConfidentiality).toContainEqual("tmpl-source-label");
    expect(consumedConfidentiality).toContainEqual("tmpl-atom-label");
    expect(consumedConfidentiality).not.toContainEqual("secret");
    // Per-consultation records at concrete paths: the source-field consult
    // resolved the field template; the whole-atom projection consumed the
    // atom template.
    const byPath = new Map(
      consumedObservations.map(
        (o) => [o.path.join("/"), o.confidentiality] as const,
      ),
    );
    expect(
      byPath.get(
        "cfc/labels/value/body/confidentiality/clauses/1/alternatives/0/source",
      ),
    ).toEqual(["tmpl-source-label"]);
    expect(
      byPath.get(
        "cfc/labels/value/body/confidentiality/clauses/1/alternatives/0",
      ),
    ).toContainEqual("tmpl-atom-label");
  });

  it("falls back to the in-hand interim rule when no template exists (old envelopes)", () => {
    const metadata = metadataWith([derivedBodyEntry()]);
    const { result, consumedConfidentiality } = evaluateConfLabelQuery(
      metadata,
      ["body"],
      { source: SOURCE_A },
    );
    expect(result.status).toBe("ok");
    expect(consumedConfidentiality).toContainEqual("secret");
  });

  it("template resolution and the in-hand fallback agree on runtime-shaped data", () => {
    // The mint copies the entry's own confidentiality into the templates
    // (the interim rule is the label SOURCE; templates are the CARRIER), so
    // on an envelope the current runtime persisted the two arms agree
    // exactly.
    const entry = derivedBodyEntry();
    const withTemplates = metadataWith([
      entry,
      ...deriveLabelMetadataTemplateEntries([entry]),
    ]);
    const stripped = metadataWith([entry]);
    for (
      const query of [
        { source: SOURCE_A },
        { atomType: CFC_ATOM_TYPE.Caveat },
        {},
        { source: SOURCE_B },
      ]
    ) {
      const resolved = evaluateConfLabelQuery(withTemplates, ["body"], query);
      const fallback = evaluateConfLabelQuery(stripped, ["body"], query);
      expect(resolved.result).toEqual(fallback.result);
      expect([...resolved.consumedConfidentiality].sort()).toEqual(
        [...fallback.consumedConfidentiality].sort(),
      );
    }
  });

  it("keeps declared entries fail-closed even when a sibling template exists", () => {
    // A declared source-bearing entry at the same path as a template (the
    // per-path addressing conflates entries): the containment gate keeps the
    // declared fields unobservable — a template never re-opens them.
    const metadata = metadataWith([
      {
        path: ["body"],
        label: { confidentiality: [caveatAtom()] },
        origin: "declared",
      },
      templateEntry(["body"], [], ["tmpl-atom-label"]),
      templateEntry(["body"], ["source"], ["tmpl-source-label"]),
    ]);
    const { result, consumedConfidentiality } = evaluateConfLabelQuery(
      metadata,
      ["body"],
      { source: SOURCE_A },
    );
    expect(result).toEqual({ status: "notAvailable" });
    expect(consumedConfidentiality).toEqual([]);
  });

  it("treats a crafted EMPTY template as absent (fallback, never public)", () => {
    const metadata = metadataWith([
      derivedBodyEntry(),
      templateEntry(["body"], ["source"], []),
    ]);
    const { result, consumedConfidentiality } = evaluateConfLabelQuery(
      metadata,
      ["body"],
      { source: SOURCE_A },
    );
    expect(result.status).toBe("ok");
    expect(consumedConfidentiality).toContainEqual("secret");
  });

  it("never enumerates template entries as payload label atoms", () => {
    // Template entries live under the ["cfc"] namespace: no payload target
    // path addresses them, so a query's atom projection never includes the
    // template's own label atoms as if they were payload clauses.
    const metadata = metadataWith([
      derivedBodyEntry(),
      templateEntry(["body"], [], ["tmpl-atom-label"]),
    ]);
    const { result } = evaluateConfLabelQuery(metadata, ["body"], {});
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    // Exactly the payload entry's two clauses — nothing from the template.
    expect(result.atoms).toHaveLength(2);
    expect(JSON.stringify(result.atoms)).not.toContain("tmpl-atom-label");
  });
});

describe("CFC template metadata population (Stage B): derivation unit properties", () => {
  const derivedEntry = (confidentiality: unknown[]): LabelMapEntry => ({
    path: ["body"],
    label: { confidentiality },
    origin: "derived",
  });

  it("entry count is O(#field-kinds), independent of clause/alternative counts", () => {
    const single = deriveLabelMetadataTemplateEntries([
      derivedEntry([caveatAtom(SOURCE_A)]),
    ]);
    // Whole-atom template + one `source` field template.
    expect(single.map((e) => e.path.at(-1))).toEqual(["*", "source"]);

    // Many clauses, an anyOf with several alternatives, extra public atoms:
    // same field kinds → same entry count.
    const manyClauses = deriveLabelMetadataTemplateEntries([
      derivedEntry([
        caveatAtom(SOURCE_A),
        { anyOf: [caveatAtom(SOURCE_B), caveatAtom({ id: "of:origin-c" })] },
        caveatAtom({ id: "of:origin-d" }),
        "public-tag",
        { kind: "authored-by", subject: "did:key:alice" },
      ]),
    ]);
    expect(manyClauses.length).toBe(single.length);
    expect(manyClauses.map((e) => e.path.at(-1))).toEqual(["*", "source"]);

    // A second protected field KIND (User.subject is commitment-classified,
    // i.e. protected) adds exactly one per-field template.
    const twoKinds = deriveLabelMetadataTemplateEntries([
      derivedEntry([
        caveatAtom(SOURCE_A),
        { type: CFC_ATOM_TYPE.User, subject: "did:key:alice" },
      ]),
    ]);
    expect(twoKinds.map((e) => e.path.at(-1))).toEqual([
      "*",
      "source",
      "subject",
    ]);
  });

  it("nested-only protected content mints the whole-atom template only", () => {
    // A protected atom smuggled inside a table-public wrapper field: its
    // consultations land at nested concrete paths no per-field template
    // addresses, so only the whole-atom projection template is minted.
    const smuggling = deriveLabelMetadataTemplateEntries([
      derivedEntry([{ kind: "authored-by", subject: caveatAtom() }]),
    ]);
    expect(smuggling.map((e) => e.path.at(-1))).toEqual(["*"]);
  });

  it("derives nothing from non-containment or template entries", () => {
    expect(deriveLabelMetadataTemplateEntries([
      {
        path: ["body"],
        label: { confidentiality: [caveatAtom()] },
        origin: "declared",
      },
      {
        path: ["body"],
        label: { confidentiality: [caveatAtom()] },
        origin: "link",
      },
      { path: ["body"], label: { confidentiality: [caveatAtom()] } },
      templateEntry(["body"], ["source"], [caveatAtom()]),
      // A template entry stays skipped by origin even without its class.
      {
        path: ["cfc", "labels", "value", "body"],
        label: { confidentiality: [caveatAtom()] },
        origin: "label-metadata",
      },
      // Integrity-only derived entries have no confidentiality clauses to
      // describe.
      {
        path: ["body"],
        label: { integrity: [caveatAtom()] },
        origin: "derived",
      },
    ])).toEqual([]);
  });

  it("array and bare-marker alternatives mint the whole-atom template only", () => {
    // An array alternative smuggling a protected record and a bare
    // commitment-marker alternative are protected CONTENT with no direct
    // field addressing: whole-atom template, no per-field entries.
    const derived = deriveLabelMetadataTemplateEntries([
      derivedEntry([
        ["tag", { custom: "protected-field-in-array" }],
        { digestOf: "abc" },
      ]),
    ]);
    expect(derived.map((e) => e.path.at(-1))).toEqual(["*"]);
  });

  it("resolves the most specific template with wildcard segments (replace-down)", () => {
    const entries = [
      templateEntry(["items", "*"], [], ["atom-label"]),
      templateEntry(["items", "*"], ["source"], ["source-label"]),
    ];
    // Field consultation: the per-field template shadows the whole-atom one.
    expect(
      resolveLabelMetadataTemplateConfidentiality(entries, [
        "cfc",
        "labels",
        "value",
        "items",
        "3",
        "confidentiality",
        "clauses",
        "2",
        "alternatives",
        "1",
        "source",
      ]),
    ).toEqual(["source-label"]);
    // Whole-atom consultation: only the atom template covers.
    expect(
      resolveLabelMetadataTemplateConfidentiality(entries, [
        "cfc",
        "labels",
        "value",
        "items",
        "3",
        "confidentiality",
        "clauses",
        "2",
        "alternatives",
        "1",
      ]),
    ).toEqual(["atom-label"]);
    // Equally specific covers JOIN (fail-toward-taint).
    const joined = resolveLabelMetadataTemplateConfidentiality([
      ...entries,
      templateEntry(["items", "3"], ["source"], ["concrete-label"]),
    ], [
      "cfc",
      "labels",
      "value",
      "items",
      "3",
      "confidentiality",
      "clauses",
      "0",
      "alternatives",
      "0",
      "source",
    ]);
    expect([...(joined ?? [])].sort()).toEqual([
      "concrete-label",
      "source-label",
    ]);
    // No cover → undefined (the caller falls back to the in-hand rule).
    expect(
      resolveLabelMetadataTemplateConfidentiality(entries, [
        "cfc",
        "labels",
        "value",
        "other",
        "confidentiality",
        "clauses",
        "0",
        "alternatives",
        "0",
      ]),
    ).toBeUndefined();
    // Only well-formed templates resolve: a label-metadata entry missing
    // its class, and payload entries of other origins, never cover.
    expect(
      resolveLabelMetadataTemplateConfidentiality([
        {
          path: ["cfc", "labels", "value", "items", "*"],
          label: { confidentiality: ["classless"] },
          origin: "label-metadata",
        },
        {
          path: ["cfc", "labels", "value", "items", "*", "confidentiality"],
          label: { confidentiality: ["wrong-origin"] },
          origin: "derived",
          observes: "value",
        },
      ], [
        "cfc",
        "labels",
        "value",
        "items",
        "*",
        "confidentiality",
      ]),
    ).toBeUndefined();
  });
});

describe("CFC template metadata population (Stage B): canonical form", () => {
  it("canonicalizes deep multi-`*` template paths deterministically", () => {
    const entries: LabelMapEntry[] = [
      templateEntry(["items", "*"], ["source"], ["a"]),
      templateEntry(["items", "*"], [], ["b"]),
      templateEntry([], ["source"], ["c"]),
      {
        path: ["items", "*"],
        label: { confidentiality: ["memb"] },
        origin: "structure",
        observes: "shape",
      },
    ];
    const canonical = canonicalizeCfcMetadata({
      version: 1,
      schemaHash: "h",
      labelMap: { version: 1, entries },
    });
    const permuted = canonicalizeCfcMetadata({
      version: 1,
      schemaHash: "h",
      labelMap: { version: 1, entries: [...entries].reverse() },
    });
    expect(permuted).toEqual(canonical);
    expect(canonicalizeCfcMetadata(canonical)).toEqual(canonical);
    expect(
      canonical.labelMap.entries.map((e) => [
        e.path.join("/"),
        e.origin,
        e.observes,
      ]),
    ).toEqual([
      [
        "cfc/labels/value/confidentiality/clauses/*/alternatives/*/source",
        "label-metadata",
        "labelMetadata",
      ],
      [
        "cfc/labels/value/items/*/confidentiality/clauses/*/alternatives/*",
        "label-metadata",
        "labelMetadata",
      ],
      [
        "cfc/labels/value/items/*/confidentiality/clauses/*/alternatives/*/source",
        "label-metadata",
        "labelMetadata",
      ],
      ["items/*", "structure", "shape"],
    ]);
  });
});
