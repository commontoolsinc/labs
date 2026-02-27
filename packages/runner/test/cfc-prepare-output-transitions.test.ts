import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { URI } from "../src/storage/interface.ts";
import { recordCfcWriteSchemaContext } from "../src/cfc/schema-context.ts";

const signer = await Identity.fromPassphrase(
  "cfc prepare output transition test",
);
const space = signer.did();

const exactCopyIfc = {
  exactCopyOf: "/",
} as const;

const projectionIfc = {
  projection: {
    from: "/",
    path: "/count",
  },
} as const;

const subsetCollectionIfc = {
  collection: {
    subsetOf: "/",
  },
} as const;

const permutationCollectionIfc = {
  collection: {
    permutationOf: "/",
  },
} as const;

const filteredFromCollectionIfc = {
  collection: {
    filteredFrom: "/",
  },
} as const;

const lengthPreservedCollectionIfc = {
  collection: {
    sourceCollection: "/",
    lengthPreserved: true,
  },
} as const;

const recomposeProjectionsIfc = {
  recomposeProjections: {
    from: "/",
    baseIntegrityType: "https://commonfabric.org/cfc/atom/Coordinates",
    parts: [
      { outputPath: "/lat", projectionPath: "/latitude" },
      { outputPath: "/long", projectionPath: "/longitude" },
    ],
  },
} as const;

const secretNumberSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const confidentialNumberSchema = {
  type: "number",
  ifc: { classification: ["confidential"] },
} as const satisfies JSONSchema;

const exactCopyNumberSchema = {
  type: "number",
  ifc: {
    classification: ["secret"],
    ...exactCopyIfc,
  },
} as const satisfies JSONSchema;

const secretObjectSchema = {
  type: "object",
  properties: {
    count: { type: "number" },
  },
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const projectionNumberSchema = {
  type: "number",
  ifc: {
    classification: ["secret"],
    ...projectionIfc,
  },
} as const satisfies JSONSchema;

const subsetArraySchema = {
  type: "array",
  items: { type: "number" },
  ifc: {
    classification: ["secret"],
    ...subsetCollectionIfc,
  },
} as const satisfies JSONSchema;

const permutationArraySchema = {
  type: "array",
  items: { type: "number" },
  ifc: {
    classification: ["secret"],
    ...permutationCollectionIfc,
  },
} as const satisfies JSONSchema;

const filteredFromArraySchema = {
  type: "array",
  items: { type: "number" },
  ifc: {
    classification: ["secret"],
    ...filteredFromCollectionIfc,
  },
} as const satisfies JSONSchema;

const lengthPreservedArraySchema = {
  type: "array",
  items: { type: "number" },
  ifc: {
    classification: ["secret"],
    ...lengthPreservedCollectionIfc,
  },
} as const satisfies JSONSchema;

const sourceCoordsSchema = {
  type: "object",
  properties: {
    latitude: { type: "number" },
    longitude: { type: "number" },
  },
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const recomposeCoordsSchema = {
  type: "object",
  properties: {
    lat: { type: "number" },
    long: { type: "number" },
  },
  ifc: {
    classification: ["secret"],
    ...recomposeProjectionsIfc,
  },
} as const satisfies JSONSchema;

describe("CFC prepare output transitions", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function seedInputClassification(
    id: URI,
    value: unknown,
    classification: string,
  ): Promise<void> {
    const tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["value"],
    }, value as any);
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, { "/": { classification: [classification] } });
    const { error } = await tx.commit();
    if (error) {
      throw new Error(`seed classification failed: ${error.name}`);
    }
  }

  it("allows prepare when output classification is monotone with consumed input", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-monotone-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, 1, "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-output-monotone-source",
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-output-monotone-target",
    );
    const value = Number(
      sourceCell.withTx(tx).asSchema(secretNumberSchema).get() ?? 0,
    );
    targetCell.withTx(tx).asSchema(secretNumberSchema).set(value + 1);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects prepare when output classification downgrades consumed input", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-downgrade-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, 1, "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-output-downgrade-source",
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-output-downgrade-target",
    );
    const value = Number(
      sourceCell.withTx(tx).asSchema(secretNumberSchema).get() ?? 0,
    );
    targetCell.withTx(tx).asSchema(confidentialNumberSchema).set(value + 1);

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("confidentialityMonotonicity");
  });

  it("allows prepare when exactCopyOf assertion is satisfied", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-exact-copy-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, 11, "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-output-exact-copy-source",
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-output-exact-copy-target",
    );
    const value = Number(
      sourceCell.withTx(tx).asSchema(secretNumberSchema).get() ?? 0,
    );
    targetCell.withTx(tx).asSchema(exactCopyNumberSchema).set(value);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects prepare when exactCopyOf assertion is violated", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-exact-copy-fail-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, 11, "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-output-exact-copy-fail-source",
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-output-exact-copy-fail-target",
    );
    const value = Number(
      sourceCell.withTx(tx).asSchema(secretNumberSchema).get() ?? 0,
    );
    targetCell.withTx(tx).asSchema(exactCopyNumberSchema).set(value + 1);

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("exactCopyOf");
  });

  it("prefers same-entity source when multiple consumed reads share source path", async () => {
    const targetId = runtime.getCell(
      space,
      "cfc-output-exact-copy-prioritize-target-low-level",
    ).getAsNormalizedFullLink().id;
    const unrelatedId = runtime.getCell(
      space,
      "cfc-output-exact-copy-prioritize-unrelated-low-level",
    ).getAsNormalizedFullLink().id;
    await seedInputClassification(targetId, 7, "secret");
    await seedInputClassification(unrelatedId, 99, "secret");

    const tx = runtime.edit();
    tx.readValueOrThrow({
      space,
      id: unrelatedId,
      type: "application/json",
      path: [],
    });
    tx.readValueOrThrow({
      space,
      id: targetId,
      type: "application/json",
      path: [],
    });
    tx.writeOrThrow({
      space,
      id: targetId,
      type: "application/json",
      path: ["value"],
    }, 7);
    recordCfcWriteSchemaContext(tx, {
      space,
      id: targetId,
      type: "application/json",
      path: [],
    }, exactCopyNumberSchema);
    tx.markCfcRelevant("ifc-write-schema");

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("allows prepare when projection assertion is satisfied", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-projection-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, { count: 7 }, "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<{ count: number }>(
      space,
      "cfc-output-projection-source",
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-output-projection-target",
    );
    const source = sourceCell.withTx(tx).asSchema(secretObjectSchema).get() ?? {
      count: 0,
    };
    targetCell.withTx(tx).asSchema(projectionNumberSchema).set(
      Number(source.count ?? 0),
    );

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects prepare when projection assertion is violated", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-projection-fail-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, { count: 7 }, "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<{ count: number }>(
      space,
      "cfc-output-projection-fail-source",
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-output-projection-fail-target",
    );
    const source = sourceCell.withTx(tx).asSchema(secretObjectSchema).get() ?? {
      count: 0,
    };
    targetCell.withTx(tx).asSchema(projectionNumberSchema).set(
      Number(source.count ?? 0) + 1,
    );

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("projection");
  });

  it("allows prepare when subsetOf collection assertion is satisfied", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-subset-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, [1, 2, 3], "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number[]>(
      space,
      "cfc-output-subset-source",
    );
    const targetCell = runtime.getCell<number[]>(
      space,
      "cfc-output-subset-target",
    );
    const source = sourceCell.withTx(tx).asSchema(subsetArraySchema).get() ??
      [];
    targetCell.withTx(tx).asSchema(subsetArraySchema).set(
      source.filter((value: number) => value !== 1),
    );

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects prepare when subsetOf collection assertion is violated", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-subset-fail-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, [1, 2, 3], "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number[]>(
      space,
      "cfc-output-subset-fail-source",
    );
    const targetCell = runtime.getCell<number[]>(
      space,
      "cfc-output-subset-fail-target",
    );
    sourceCell.withTx(tx).asSchema(subsetArraySchema).get();
    targetCell.withTx(tx).asSchema(subsetArraySchema).set([2, 4]);

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("subsetOf");
  });

  it("allows prepare when permutationOf collection assertion is satisfied", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-permutation-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, [1, 2, 3], "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number[]>(
      space,
      "cfc-output-permutation-source",
    );
    const targetCell = runtime.getCell<number[]>(
      space,
      "cfc-output-permutation-target",
    );
    const source =
      sourceCell.withTx(tx).asSchema(permutationArraySchema).get() ??
        [];
    targetCell.withTx(tx).asSchema(permutationArraySchema).set([
      source[2] ?? 0,
      source[0] ?? 0,
      source[1] ?? 0,
    ]);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects prepare when permutationOf collection assertion is violated", async () => {
    const sourceId =
      runtime.getCell(space, "cfc-output-permutation-fail-source")
        .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, [1, 2, 3], "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number[]>(
      space,
      "cfc-output-permutation-fail-source",
    );
    const targetCell = runtime.getCell<number[]>(
      space,
      "cfc-output-permutation-fail-target",
    );
    sourceCell.withTx(tx).asSchema(permutationArraySchema).get();
    targetCell.withTx(tx).asSchema(permutationArraySchema).set([1, 2, 4]);

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("permutationOf");
  });

  it("allows prepare when filteredFrom collection assertion is satisfied", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-filtered-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, [1, 2, 3], "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number[]>(
      space,
      "cfc-output-filtered-source",
    );
    const targetCell = runtime.getCell<number[]>(
      space,
      "cfc-output-filtered-target",
    );
    const source =
      sourceCell.withTx(tx).asSchema(filteredFromArraySchema).get() ??
        [];
    targetCell.withTx(tx).asSchema(filteredFromArraySchema).set(
      source.filter((value: number) => value > 1),
    );

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects prepare when filteredFrom collection assertion is violated", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-filtered-fail-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, [1, 2, 3], "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number[]>(
      space,
      "cfc-output-filtered-fail-source",
    );
    const targetCell = runtime.getCell<number[]>(
      space,
      "cfc-output-filtered-fail-target",
    );
    sourceCell.withTx(tx).asSchema(filteredFromArraySchema).get();
    targetCell.withTx(tx).asSchema(filteredFromArraySchema).set([4]);

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("filteredFrom");
  });

  it("allows prepare when lengthPreserved collection assertion is satisfied", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-length-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, [1, 2, 3], "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number[]>(
      space,
      "cfc-output-length-source",
    );
    const targetCell = runtime.getCell<number[]>(
      space,
      "cfc-output-length-target",
    );
    const source =
      sourceCell.withTx(tx).asSchema(lengthPreservedArraySchema).get() ??
        [];
    targetCell.withTx(tx).asSchema(lengthPreservedArraySchema).set(
      source.map((value: number) => value + 10),
    );

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects prepare when lengthPreserved collection assertion is violated", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-length-fail-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, [1, 2, 3], "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number[]>(
      space,
      "cfc-output-length-fail-source",
    );
    const targetCell = runtime.getCell<number[]>(
      space,
      "cfc-output-length-fail-target",
    );
    sourceCell.withTx(tx).asSchema(lengthPreservedArraySchema).get();
    targetCell.withTx(tx).asSchema(lengthPreservedArraySchema).set([11, 12]);

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("lengthPreserved");
  });

  it("allows prepare when recomposeProjections assertion is satisfied", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-recompose-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(
      sourceId,
      { latitude: 37.77, longitude: -122.41 },
      "secret",
    );

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<{ latitude: number; longitude: number }>(
      space,
      "cfc-output-recompose-source",
    );
    const targetCell = runtime.getCell<{ lat: number; long: number }>(
      space,
      "cfc-output-recompose-target",
    );
    const source = sourceCell.withTx(tx).asSchema(sourceCoordsSchema).get() ?? {
      latitude: 0,
      longitude: 0,
    };
    targetCell.withTx(tx).asSchema(recomposeCoordsSchema).set({
      lat: Number(source.latitude ?? 0),
      long: Number(source.longitude ?? 0),
    });

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects prepare when recomposeProjections assertion is violated", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-recompose-fail-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(
      sourceId,
      { latitude: 37.77, longitude: -122.41 },
      "secret",
    );

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<{ latitude: number; longitude: number }>(
      space,
      "cfc-output-recompose-fail-source",
    );
    const targetCell = runtime.getCell<{ lat: number; long: number }>(
      space,
      "cfc-output-recompose-fail-target",
    );
    const source = sourceCell.withTx(tx).asSchema(sourceCoordsSchema).get() ?? {
      latitude: 0,
      longitude: 0,
    };
    targetCell.withTx(tx).asSchema(recomposeCoordsSchema).set({
      lat: Number(source.latitude ?? 0),
      long: Number(source.longitude ?? 0) + 1,
    });

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("recomposeProjections");
  });
});
