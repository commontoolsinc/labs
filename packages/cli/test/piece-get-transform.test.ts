import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model/interface";
import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  derivePieceGetValue,
  evaluatePieceGetPredicate,
  parsePieceGetFilter,
  parsePieceGetProjection,
  PieceGetTransformError,
} from "../lib/piece-get-transform.ts";

const signer = await Identity.fromPassphrase("cf-piece-get-transform");
const space = signer.did();

describe("cf piece get transforms", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("parses and evaluates jq-inspired predicates", () => {
    const parsed = parsePieceGetFilter(
      '.status == "open" and (.score >= 10 or .priority == true)',
    );
    expect(parsed.paths).toEqual([
      ["status"],
      ["score"],
      ["priority"],
    ]);
    expect(evaluatePieceGetPredicate(parsed.predicate, {
      status: "open",
      score: 12,
      priority: false,
    })).toBe(true);
    expect(evaluatePieceGetPredicate(parsed.predicate, {
      status: "closed",
      score: 12,
      priority: true,
    })).toBe(false);
  });

  it("supports bracket paths, negative indices, and not", () => {
    const parsed = parsePieceGetFilter(
      'not .disabled and .["tags"][-1] == "current"',
    );
    expect(evaluatePieceGetPredicate(parsed.predicate, {
      disabled: false,
      tags: ["old", "current"],
    })).toBe(true);
  });

  it("rejects non-boolean predicates", () => {
    const parsed = parsePieceGetFilter(".name");
    expect(() => evaluatePieceGetPredicate(parsed.predicate, { name: "Ada" }))
      .toThrow(PieceGetTransformError);
  });

  it("parses concise, inline, and file projection schemas", async () => {
    const concise = await parsePieceGetProjection("id,author.name");
    expect(concise.kind).toBe("concise");
    expect(concise.schema).toEqual({
      type: "object",
      properties: {
        id: true,
        author: {
          type: "object",
          properties: { name: true },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });

    const inline = await parsePieceGetProjection(
      '{"type":"object","properties":{"title":{"type":"string"}}}',
    );
    expect(inline.schema).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      additionalProperties: false,
    });

    const fromFile = await parsePieceGetProjection("@projection.json", {
      readTextFile: () =>
        Promise.resolve(
          '{"type":"array","items":{"type":"object","properties":{"id":true}}}',
        ),
    });
    expect(fromFile.kind).toBe("json");
    expect(fromFile.schema).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: true },
        additionalProperties: false,
      },
    });
  });

  it("does not let caller projection schemas forge CFC metadata", async () => {
    await expect(parsePieceGetProjection(
      '{"type":"string","ifc":{"confidentiality":["fake"]}}',
    )).rejects.toThrow(PieceGetTransformError);
    await expect(parsePieceGetProjection(
      '{"type":"object","properties":{"secret":{"asCell":["cell"]}}}',
    )).rejects.toThrow(PieceGetTransformError);
  });

  it("filters and projects arrays through the runtime pattern graph", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "plain-transform-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            title: { type: "string" },
            status: { type: "string" },
          },
        },
      },
      tx,
    );
    source.set([
      { id: 1, title: "First", status: "open" },
      { id: 2, title: "Second", status: "closed" },
      { id: 3, title: "Third", status: "open" },
    ]);
    expect((await tx.commit()).ok).toBeDefined();

    const result = await derivePieceGetValue(runtime, space, source, {
      filter: parsePieceGetFilter('.status == "open"'),
      projection: await parsePieceGetProjection("id,title"),
    });

    expect(result).toEqual([
      { id: 1, title: "First" },
      { id: 3, title: "Third" },
    ]);
  });

  it("rejects --filter for non-array sources", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "object-filter-source",
      { type: "object", properties: { id: { type: "number" } } },
      tx,
    );
    source.set({ id: 1 });
    expect((await tx.commit()).ok).toBeDefined();

    await expect(derivePieceGetValue(runtime, space, source, {
      filter: parsePieceGetFilter(".id == 1"),
    })).rejects.toThrow("--filter can only be applied to an array");
  });

  it("carries predicate labels on filtered membership like a pattern", async () => {
    await seedLabeledDoc(runtime, "filter-element-a", {
      id: 1,
      status: "open",
    }, "alice-secret");
    await seedLabeledDoc(runtime, "filter-element-b", {
      id: 2,
      status: "closed",
    }, "bob-secret");

    const setup = runtime.edit();
    const elementA = runtime.getCell(
      space,
      "filter-element-a",
      undefined,
      setup,
    );
    const elementB = runtime.getCell(
      space,
      "filter-element-b",
      undefined,
      setup,
    );
    const source = runtime.getCell(
      space,
      "labeled-filter-source",
      { type: "array", items: { asCell: ["cell"] } },
      setup,
    );
    source.set([elementA, elementB]);
    expect((await setup.commit()).ok).toBeDefined();
    const sourceRead = runtime.getCell(
      space,
      "labeled-filter-source",
      { type: "array", items: { asCell: ["cell"] } },
    );

    let resultCell: Cell<unknown> | undefined;
    const result = await derivePieceGetValue(runtime, space, sourceRead, {
      filter: parsePieceGetFilter('.status == "open"'),
    }, {
      onResultCell: (cell) => resultCell = cell,
    });
    expect(result).toEqual([{ id: 1, status: "open" }]);

    const probeTx = runtime.edit();
    const kept = resultCell!.key("value").withTx(probeTx).get() as unknown[];
    const probe = runtime.getCell(
      space,
      "filter-membership-probe",
      undefined,
      probeTx,
    );
    probe.set({ count: kept.length });
    probeTx.prepareCfc();
    expect((await probeTx.commit()).ok).toBeDefined();

    const labels = derivedConfidentiality(
      probe.getAsNormalizedFullLink().id,
    );
    expect(labels).toContain("alice-secret");
    expect(labels).toContain("bob-secret");
  });

  it("derives projected field labels from source CFC metadata", async () => {
    const setup = runtime.edit();
    const source = runtime.getCell(
      space,
      "static-label-projection-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {
              type: "number",
              ifc: { confidentiality: ["source-secret"] },
            },
            ignored: { type: "string" },
          },
        },
      },
      setup,
    );
    source.set([{ id: 7, ignored: "not returned" }]);
    expect((await setup.commit()).ok).toBeDefined();

    let resultCell: Cell<unknown> | undefined;
    const result = await derivePieceGetValue(runtime, space, source, {
      projection: await parsePieceGetProjection("id"),
    }, {
      onResultCell: (cell) => resultCell = cell,
    });
    expect(result).toEqual([{ id: 7 }]);

    const probeTx = runtime.edit();
    const projectedId = resultCell!.key("value").key(0).key("id").withTx(
      probeTx,
    ).get();
    const probe = runtime.getCell(
      space,
      "projection-label-probe",
      undefined,
      probeTx,
    );
    probe.set({ projectedId });
    probeTx.prepareCfc();
    expect((await probeTx.commit()).ok).toBeDefined();

    expect(derivedConfidentiality(
      probe.getAsNormalizedFullLink().id,
    )).toContain("source-secret");
  });

  async function seedLabeledDoc(
    targetRuntime: Runtime,
    cause: string,
    value: FabricValue,
    atom: string,
  ): Promise<void> {
    const seed = targetRuntime.edit();
    const cell = targetRuntime.getCell(space, cause, undefined, seed);
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
          entries: [{
            path: [],
            label: { confidentiality: [atom] },
          }],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();
  }

  function derivedConfidentiality(id: string): string[] {
    type StoredEntry = {
      origin?: string;
      label: { confidentiality?: string[] };
    };
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(
        id: string,
      ): { cfc?: { labelMap?: { entries: StoredEntry[] } } } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries
      ?.filter((entry) => entry.origin === "derived")
      .flatMap((entry) => entry.label.confidentiality ?? []) ?? [];
  }
});
