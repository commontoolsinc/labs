import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { canonicalizeBoundaryActivity } from "../src/cfc/canonical-activity.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "cfc asSchema projected observation test",
);
const space = signer.did();

describe("CFC asSchema projected observations", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("records only projected descendant observations for nested object reads", async () => {
    const seedTx = runtime.edit();
    const seedCell = runtime.getCell<
      { error: { code: number; details: { reason: string } } }
    >(
      space,
      "cfc-as-schema-projected-observations",
      undefined,
      seedTx,
    );
    seedCell.set({
      error: {
        code: 403,
        details: { reason: "scope-insufficient" },
      },
    });
    expect((await seedTx.commit()).error).toBeUndefined();

    const projectionSchema = {
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: {
            code: { type: "number" },
          },
        },
      },
    } as const satisfies JSONSchema;

    const tx = runtime.edit();
    const cell = runtime.getCell<
      { error: { code: number; details: { reason: string } } }
    >(
      space,
      "cfc-as-schema-projected-observations",
      undefined,
      tx,
    );
    const value = cell.withTx(tx).asSchema(projectionSchema).get();
    expect(value?.error?.code).toBe(403);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => !read.internalVerifierRead);

    expect(
      reads.some((read) => read.path === "/" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/error" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/error/code" && read.op === "value"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/" && read.op === "value"),
    ).toBe(false);
    expect(
      reads.some((read) => read.path === "/error/details"),
    ).toBe(false);
    expect(
      reads.some((read) => read.path === "/error/details/reason"),
    ).toBe(false);
    expect(
      reads.some((read) => read.path === "/~1/link@1"),
    ).toBe(false);
    expect(
      reads.some((read) => read.path === "/$alias/path"),
    ).toBe(false);
    expect(
      reads.some((read) => read.path === "/cell/~1"),
    ).toBe(false);

    tx.abort();
  });

  it("records followRef before reading projected descendants through links", async () => {
    const seedTx = runtime.edit();
    const targetCell = runtime.getCell<{ code: number; secret: string }>(
      space,
      "cfc-as-schema-linked-target",
      undefined,
      seedTx,
    );
    targetCell.set({ code: 403, secret: "scope-insufficient" });
    const sourceCell = runtime.getCell<{ error: typeof targetCell }>(
      space,
      "cfc-as-schema-linked-source",
      undefined,
      seedTx,
    );
    sourceCell.set({ error: targetCell });
    expect((await seedTx.commit()).error).toBeUndefined();

    const projectionSchema = {
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: {
            code: { type: "number" },
          },
        },
      },
    } as const satisfies JSONSchema;

    const tx = runtime.edit();
    const source = runtime.getCell<{ error: { code: number } }>(
      space,
      "cfc-as-schema-linked-source",
      undefined,
      tx,
    );
    const value = source.withTx(tx).asSchema(projectionSchema).get();
    expect(value?.error?.code).toBe(403);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => !read.internalVerifierRead);
    const followRefIndex = reads.findIndex((read) =>
      read.id === source.getAsNormalizedFullLink().id &&
      read.path === "/error" &&
      read.op === "followRef"
    );
    const targetValueIndex = reads.findIndex((read) =>
      read.id === targetCell.getAsNormalizedFullLink().id &&
      read.path === "/code" &&
      read.op === "value"
    );

    expect(followRefIndex).toBeGreaterThanOrEqual(0);
    expect(targetValueIndex).toBeGreaterThan(followRefIndex);
    expect(
      reads.some((read) =>
        read.id === targetCell.getAsNormalizedFullLink().id &&
        read.path === "/secret"
      ),
    ).toBe(false);

    tx.abort();
  });

  it("records array count and enumeration without reading unprojected sibling fields", async () => {
    const seedTx = runtime.edit();
    const cell = runtime.getCell<
      Array<{ code: number; secret: string }>
    >(
      space,
      "cfc-as-schema-array-projected-observations",
      undefined,
      seedTx,
    );
    cell.set([
      { code: 1, secret: "a" },
      { code: 2, secret: "b" },
    ]);
    expect((await seedTx.commit()).error).toBeUndefined();

    const projectionSchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "number" },
        },
      },
    } as const satisfies JSONSchema;

    const tx = runtime.edit();
    const source = runtime.getCell<Array<{ code: number }>>(
      space,
      "cfc-as-schema-array-projected-observations",
      undefined,
      tx,
    );
    const value = source.withTx(tx).asSchema(projectionSchema).get();
    expect(value?.map((entry) => entry.code)).toEqual([1, 2]);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => !read.internalVerifierRead);

    expect(
      reads.some((read) => read.path === "/" && read.op === "count"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/" && read.op === "enumerate"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/secret"),
    ).toBe(false);

    tx.abort();
  });
});
