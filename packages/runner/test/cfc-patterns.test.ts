import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  getCfcDebugCounters,
  resetCfcDebugCounters,
} from "../src/cfc/debug-counters.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import { Runtime } from "../src/runtime.ts";
import type { Labels, URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc pattern integration test");
const space = signer.did();

const secretNumberSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const secureArgumentSchema = {
  type: "object",
  properties: {
    source: secretNumberSchema,
  },
  required: ["source"],
} as const satisfies JSONSchema;

const secretResultSchema = {
  type: "object",
  properties: {
    result: secretNumberSchema,
  },
  required: ["result"],
} as const satisfies JSONSchema;

const plainResultSchema = {
  type: "object",
  properties: {
    result: { type: "number" },
  },
  required: ["result"],
} as const satisfies JSONSchema;

const maxConfidentialInputSchema = {
  type: "object",
  properties: {
    source: {
      type: "number",
      ifc: {
        maxConfidentiality: ["confidential"],
      },
    },
  },
  required: ["source"],
} as const satisfies JSONSchema;

const requiredIntegrityInputSchema = {
  type: "object",
  properties: {
    source: {
      type: "number",
      ifc: {
        requiredIntegrity: ["trusted-source"],
      },
    },
  },
  required: ["source"],
} as const satisfies JSONSchema;

describe("CFC pattern integration", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];

  beforeEach(() => {
    resetCfcDebugCounters();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
    const { commontools } = createBuilder();
    ({ pattern } = commontools);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function seedRootLabels(
    id: URI,
    labels: Labels,
  ): Promise<void> {
    const tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, { "/": labels });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  }

  function readOutputMetadata(id: URI): {
    schemaHash: unknown;
    labelsByPath: unknown;
  } {
    const tx = runtime.edit();
    const schemaHash = tx.readOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "schemaHash"],
    });
    const labelsByPath = tx.readOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "labels"],
    });
    tx.abort("inspection-complete");
    return { schemaHash, labelsByPath };
  }

  it("runs a pattern with explicit IFC schemas and persists output CFC metadata", async () => {
    const copyPattern = pattern<{ source: number }>(
      ({ source }) => ({ result: source }),
      secureArgumentSchema,
      secretResultSchema,
    );

    let tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-pattern-copy-source",
      undefined,
      tx,
    );
    sourceCell.set(7);
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "cfc-pattern-copy-result",
      secretResultSchema,
      tx,
    );
    resultCell.set({ result: 0 });
    await prepareCfcCommitIfNeeded(tx);
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    await seedRootLabels(sourceCell.getAsNormalizedFullLink().id, {
      classification: ["secret"],
      integrity: ["proof-token"],
    });

    tx = runtime.edit();
    const result = runtime.run(
      tx,
      copyPattern,
      { source: sourceCell },
      resultCell,
    );
    await prepareCfcCommitIfNeeded(tx);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const value = await result.pull();
    expect(value).toEqual({ result: 7 });

    const metadata = readOutputMetadata(
      resultCell.getAsNormalizedFullLink().id,
    );
    expect(typeof metadata.schemaHash).toBe("string");
    expect(
      ((metadata.labelsByPath as Record<string, Labels>)["/result"] ?? {})
        .classification,
    ).toContain("secret");
    expect(getCfcDebugCounters().cfcPreparedTx).toBeGreaterThan(0);
  });

  it("runs a pattern with explicit maxConfidentiality input schema when labels satisfy the bound", async () => {
    const passthrough = pattern<{ source: number }>(
      ({ source }) => ({ result: source }),
      maxConfidentialInputSchema,
      plainResultSchema,
    );

    let tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-pattern-required-integrity-source",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "cfc-pattern-maxconf-result",
      plainResultSchema,
      tx,
    );
    sourceCell.set(11);
    resultCell.set({ result: 0 });
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    await seedRootLabels(sourceCell.getAsNormalizedFullLink().id, {
      classification: ["confidential"],
    });

    tx = runtime.edit();
    const result = runtime.run(
      tx,
      passthrough,
      { source: sourceCell },
      resultCell,
    );
    await prepareCfcCommitIfNeeded(tx);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    await runtime.scheduler.idle();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runtime.scheduler.idle();
    await result.pull();

    const value = await result.pull();
    expect(value).toEqual({ result: 11 });
    expect(getCfcDebugCounters().cfcGateRejects).toBe(0);
  });

  it("runs a pattern with explicit requiredIntegrity input schema when integrity evidence is present", async () => {
    const requireTrustedInput = pattern<{ source: number }>(
      ({ source }) => ({ result: source }),
      requiredIntegrityInputSchema,
      plainResultSchema,
    );

    let tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-pattern-maxconf-source",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "cfc-pattern-required-integrity-result",
      plainResultSchema,
      tx,
    );
    sourceCell.set(5);
    resultCell.set({ result: 0 });
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    await seedRootLabels(sourceCell.getAsNormalizedFullLink().id, {
      classification: ["confidential"],
      integrity: ["trusted-source"],
    });

    tx = runtime.edit();
    const result = runtime.run(
      tx,
      requireTrustedInput,
      { source: sourceCell },
      resultCell,
    );
    await prepareCfcCommitIfNeeded(tx);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const value = await result.pull();
    expect(value).toEqual({ result: 5 });
    expect(getCfcDebugCounters().cfcGateRejects).toBe(0);
  });
});
