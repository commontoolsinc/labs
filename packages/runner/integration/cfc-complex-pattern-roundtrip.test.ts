#!/usr/bin/env -S deno run -A

import { assertEquals, assertExists } from "@std/assert";
import {
  type JSONSchema,
  type MemorySpace,
  Runtime,
} from "@commontools/runner";
import { Identity, type IdentityCreateConfig } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import { computeCfcSchemaHash } from "../src/cfc/schema-hash.ts";
import type { URI } from "../src/storage/interface.ts";
import { env } from "@commontools/integration";

const API_URL = new URL(env.API_URL);
const TIMEOUT_MS = 180000;

const keyConfig: IdentityCreateConfig = {
  implementation: "noble",
};

const producerSourceSchema = {
  type: "array",
  items: { type: "number" },
} as const satisfies JSONSchema;

const producerInputSchema = {
  type: "object",
  properties: {
    source: producerSourceSchema,
  },
  required: ["source"],
} as const satisfies JSONSchema;

const consumerInputSchema = {
  type: "object",
  properties: {
    upstream: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "number" },
        },
        count: {
          type: "number",
          ifc: {
            requiredIntegrity: ["trusted-source"],
            maxConfidentiality: ["secret"],
          },
        },
        tick: {
          type: "object",
          properties: {
            step: { type: "number" },
          },
          required: ["step"],
          asStream: true,
        },
      },
      required: ["items", "count", "tick"],
    },
  },
  required: ["upstream"],
} as const satisfies JSONSchema;

const consumerOutputSchema = {
  type: "object",
  properties: {
    shifted: {
      type: "array",
      items: { type: "number" },
      ifc: {
        classification: ["secret"],
        collection: {
          sourceCollection: "/upstream/items",
          lengthPreserved: true,
        },
      },
    },
    observedCount: { type: "number" },
    eventCount: { type: "number" },
    pulse: {
      type: "object",
      properties: {
        step: { type: "number" },
      },
      required: ["step"],
      asStream: true,
    },
  },
  required: ["shifted", "observedCount", "eventCount", "pulse"],
} as const satisfies JSONSchema;

const trustedNumberReadSchema = {
  type: "number",
  ifc: {
    requiredIntegrity: ["trusted-source"],
    maxConfidentiality: ["secret"],
  },
} as const satisfies JSONSchema;

interface TestContext {
  runtime: Runtime;
  storageManager: ReturnType<typeof StorageManager.open>;
}

function createContext(identity: Identity): TestContext {
  const storageManager = StorageManager.open({
    as: identity,
    address: new URL("/api/storage/memory", API_URL),
  });
  const runtime = new Runtime({
    apiUrl: API_URL,
    storageManager,
  });
  return { runtime, storageManager };
}

async function disposeContext(ctx: TestContext): Promise<void> {
  await ctx.runtime.dispose();
  await ctx.storageManager.close();
}

async function waitForIdle(runtime: Runtime): Promise<void> {
  await runtime.idle();
  await runtime.storageManager.synced();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await runtime.idle();
}

function createProducerOutputSchema(itemsIntegrity: string): JSONSchema {
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "number" },
        ifc: {
          classification: ["secret"],
          integrity: [itemsIntegrity],
        },
      },
      count: {
        type: "number",
        ifc: {
          classification: ["secret"],
          integrity: [itemsIntegrity],
        },
      },
      tick: {
        type: "object",
        properties: {
          step: { type: "number" },
        },
        required: ["step"],
        asStream: true,
      },
    },
    required: ["items", "count", "tick"],
  };
}

function createProducerPattern(outputSchema: JSONSchema) {
  const { commontools } = createBuilder();
  const { cell, derive, handler, lift, pattern } = commontools;

  const numberSchema = {
    type: "number",
  } as const satisfies JSONSchema;

  const numberArraySchema = {
    type: "array",
    items: numberSchema,
  } as const satisfies JSONSchema;

  const tickEventSchema = {
    type: "object",
    properties: {
      step: numberSchema,
    },
    required: ["step"],
  } as const satisfies JSONSchema;

  const tickStateSchema = {
    type: "object",
    properties: {
      count: { type: "number", asCell: true },
    },
    required: ["count"],
  } as const satisfies JSONSchema;

  const shift = lift(
    numberArraySchema,
    numberArraySchema,
    (values: number[]) => values.map((value: number) => value + 10),
  );

  const tick = handler(
    tickEventSchema,
    tickStateSchema,
    (event: unknown, state: unknown) => {
      const { step } = event as { step: number };
      const { count } = state as {
        count: { get: () => number; set: (value: number) => void };
      };
      count.set((count.get() ?? 0) + step);
    },
  );

  return pattern<{ source: number[] }>(
    ({ source }) => {
      const count = cell<number>(0);
      return {
        items: shift(source),
        count: derive(count, (value) => value),
        tick: tick({ count }),
      };
    },
    producerInputSchema,
    outputSchema,
  );
}

function createConsumerPattern() {
  const { commontools } = createBuilder();
  const { cell, derive, handler, lift, pattern } = commontools;

  const numberSchema = {
    type: "number",
  } as const satisfies JSONSchema;

  const pulseEventSchema = {
    type: "object",
    properties: {
      step: numberSchema,
    },
    required: ["step"],
  } as const satisfies JSONSchema;

  const pulseStateSchema = {
    type: "object",
    properties: {
      observed: { type: "number", asCell: true },
    },
    required: ["observed"],
  } as const satisfies JSONSchema;

  const identity = lift(
    numberSchema,
    numberSchema,
    (value: number) => value,
  );

  const pulse = handler(
    pulseEventSchema,
    pulseStateSchema,
    (event: unknown, state: unknown) => {
      const { step } = event as { step: number };
      const { observed } = state as {
        observed: { get: () => number; set: (value: number) => void };
      };
      observed.set((observed.get() ?? 0) + step);
    },
  );

  return pattern<{ upstream: { items: number[]; count: number } }>(
    ({ upstream }) => {
      const observed = cell<number>(0);
      const observedCell = derive(observed, (value) => value);
      return {
        shifted: upstream.items,
        observedCount: upstream.count,
        eventCount: identity(observedCell),
        pulse: pulse({ observed }),
      };
    },
    consumerInputSchema,
    consumerOutputSchema,
  );
}

async function readDocumentPath(
  ctx: TestContext,
  space: MemorySpace,
  id: string,
  path: readonly string[],
): Promise<unknown> {
  const tx = ctx.runtime.edit();
  const value = tx.readOrThrow({
    space,
    id: id as URI,
    type: "application/json",
    path: [...path],
  });
  const { error } = await tx.commit();
  if (error) {
    throw new Error(
      `failed reading ${id} at /${path.join("/")}: ${error.name}`,
    );
  }
  return value;
}

async function syncDocumentPath(
  ctx: TestContext,
  space: MemorySpace,
  id: string,
  path: readonly string[],
): Promise<void> {
  const provider = ctx.storageManager.open(space);
  const result = await provider.sync(id as URI, {
    path: [...path],
    schema: false,
  });
  if (result.error) {
    throw new Error(
      `failed syncing ${id} at /${path.join("/")}: ${result.error.name}`,
    );
  }
}

function resetReplicaCacheIfSupported(
  ctx: TestContext,
  space: MemorySpace,
): void {
  const provider = ctx.storageManager.open(space) as {
    replica?: { reset?: () => void };
  };
  if (typeof provider.replica?.reset === "function") {
    provider.replica.reset();
  }
}

async function runTwoPatternScenario(args: {
  runId: string;
  producerIntegrity: string;
  expectedConsumerFailure?: string;
}): Promise<void> {
  const identity = await Identity.fromPassphrase(
    `cfc-two-pattern-${args.runId}-${Date.now()}`,
    keyConfig,
  );
  const space = identity.did();
  const producerOutputSchema = createProducerOutputSchema(
    args.producerIntegrity,
  );

  const sourceCellId = `cfc-two-pattern-source-${args.runId}`;
  const producerResultCellId = `cfc-two-pattern-producer-result-${args.runId}`;
  const consumerResultCellId = `cfc-two-pattern-consumer-result-${args.runId}`;

  const phase1 = createContext(identity);
  const producerPattern = createProducerPattern(producerOutputSchema);

  let tx = phase1.runtime.edit();
  const sourceCell = phase1.runtime.getCell<number[]>(
    space,
    sourceCellId,
    producerSourceSchema,
    tx,
  );
  const producerResultCell = phase1.runtime.getCell<any>(
    space,
    producerResultCellId,
    producerOutputSchema,
    tx,
  );
  sourceCell.set([1, 2, 3]);
  producerResultCell.set({
    items: [0, 0, 0],
    count: 0,
    tick: { step: 0 },
  });
  await prepareCfcCommitIfNeeded(tx);
  let commit = await tx.commit();
  if (commit.error) {
    throw new Error(`producer bootstrap commit failed: ${commit.error.name}`);
  }

  tx = phase1.runtime.edit();
  const producerRun = phase1.runtime.run(
    tx,
    producerPattern,
    { source: sourceCell },
    producerResultCell,
  );
  await prepareCfcCommitIfNeeded(tx);
  commit = await tx.commit();
  if (commit.error) {
    throw new Error(`producer commit failed: ${commit.error.name}`);
  }

  await producerRun.pull();
  await waitForIdle(phase1.runtime);

  const producerTick = producerResultCell.key("tick") as {
    send: (event: { step: number }) => void;
  };
  producerTick.send({ step: 1 });
  producerTick.send({ step: 2 });
  await waitForIdle(phase1.runtime);
  await producerResultCell.pull();

  const producerValue = producerResultCell.getAsQueryResult() as {
    items?: number[];
    count?: number;
  };
  assertEquals(producerValue.items ?? [], [11, 12, 13]);
  assertEquals(Number(producerValue.count ?? 0), 3);
  const producerResultEntityId =
    producerResultCell.getAsNormalizedFullLink().id;

  await phase1.runtime.storageManager.synced();
  await disposeContext(phase1);

  const phase2 = createContext(identity);
  resetReplicaCacheIfSupported(phase2, space);
  const producerResultView = phase2.runtime.getCell<any>(
    space,
    producerResultCellId,
  );
  await producerResultView.sync();
  const producerResultWithSchema = producerResultView.asSchema(
    producerOutputSchema,
  );
  await producerResultWithSchema.sync();
  await producerResultWithSchema.pull();
  await phase2.runtime.storageManager.synced();

  const restoredProducer = producerResultWithSchema.getAsQueryResult() as {
    items?: number[];
    count?: number;
  };
  assertEquals(restoredProducer.items ?? [], [11, 12, 13]);
  assertEquals(Number(restoredProducer.count ?? 0), 3);

  const metadataId = producerResultEntityId;
  await syncDocumentPath(
    phase2,
    space,
    metadataId,
    ["cfc", "schemaHash"],
  );
  const persistedHashValue = await readDocumentPath(
    phase2,
    space,
    metadataId,
    ["cfc", "schemaHash"],
  );
  if (
    typeof persistedHashValue !== "string" ||
    persistedHashValue.length === 0
  ) {
    throw new Error(
      "missing persisted cfc.schemaHash on producer result entity",
    );
  }
  const persistedHash = persistedHashValue;

  assertEquals(
    persistedHash,
    await computeCfcSchemaHash(producerOutputSchema),
  );

  await syncDocumentPath(
    phase2,
    space,
    metadataId,
    ["cfc", "labels"],
  );
  const persistedLabels = await readDocumentPath(
    phase2,
    space,
    metadataId,
    ["cfc", "labels"],
  ) as Record<string, { classification?: string[]; integrity?: string[] }>;
  assertExists(persistedLabels["/items"]);
  assertEquals(persistedLabels["/items"].classification, ["secret"]);
  assertEquals(
    persistedLabels["/count"].integrity,
    [args.producerIntegrity],
  );

  await syncDocumentPath(
    phase2,
    space,
    `blob:${persistedHash}`,
    ["value"],
  );
  const persistedSchema = await readDocumentPath(
    phase2,
    space,
    `blob:${persistedHash}`,
    ["value"],
  );
  assertEquals(persistedSchema, producerOutputSchema);
  const producerInputCell = phase2.runtime.getCell<any>(
    space,
    metadataId,
    producerOutputSchema,
  );
  await producerInputCell.sync();
  await producerInputCell.pull();

  const consumerPattern = createConsumerPattern();
  tx = phase2.runtime.edit();
  const consumerResultCell = phase2.runtime.getCell<any>(
    space,
    consumerResultCellId,
    consumerOutputSchema,
    tx,
  );
  if (args.expectedConsumerFailure) {
    const trustedCount = Number(
      producerInputCell.withTx(tx).key("count")
        .asSchema(trustedNumberReadSchema).get() ?? 0,
    );
    phase2.runtime.getCell<number>(
      space,
      `${consumerResultCellId}-trusted-count`,
      undefined,
      tx,
    ).set(trustedCount);
  }
  const consumerRun = phase2.runtime.run(
    tx,
    consumerPattern,
    { upstream: producerInputCell },
    consumerResultCell,
  );

  let prepareError: unknown;
  try {
    await prepareCfcCommitIfNeeded(tx);
  } catch (error) {
    prepareError = error;
  }

  if (prepareError) {
    tx.abort(prepareError);
  }

  if (args.expectedConsumerFailure) {
    assertEquals(
      (prepareError as { name?: string } | undefined)?.name,
      args.expectedConsumerFailure,
    );
    await disposeContext(phase2);
    return;
  }

  if (prepareError) {
    throw prepareError;
  }

  commit = await tx.commit();
  if (commit.error) {
    throw new Error(`consumer commit failed: ${commit.error.name}`);
  }

  await consumerRun.pull();
  await waitForIdle(phase2.runtime);

  await disposeContext(phase2);
}

async function runWithTimeout(fn: () => Promise<void>): Promise<void> {
  let timeoutHandle: number;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Test timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
  });
  try {
    await Promise.race([fn(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}

Deno.test({
  name:
    "complex cfc two-pattern restart rejects when producer integrity is insufficient",
  fn: async () => {
    await runWithTimeout(async () => {
      await runTwoPatternScenario({
        runId: "insufficient-integrity",
        producerIntegrity: "untrusted-source",
        expectedConsumerFailure: "CfcInputRequirementViolationError",
      });
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name:
    "complex cfc two-pattern restart persists schema blob+labels and allows trusted integrity",
  fn: async () => {
    await runWithTimeout(async () => {
      await runTwoPatternScenario({
        runId: "trusted-integrity",
        producerIntegrity: "trusted-source",
      });
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
