#!/usr/bin/env -S deno run -A

import { assertEquals } from "@std/assert";
import {
  type JSONSchema,
  type MemorySpace,
  Runtime,
  type RuntimeProgram,
} from "@commontools/runner";
import { Identity, type IdentityCreateConfig } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import { env } from "@commontools/integration";

const API_URL = new URL(env.API_URL);
const TIMEOUT_MS = 180000;

const keyConfig: IdentityCreateConfig = {
  implementation: "noble",
};

const SOURCE_CELL_ID = "cfc-complex-roundtrip-source";
const RESULT_CELL_ID = "cfc-complex-roundtrip-result";

const sourceSchema = {
  type: "array",
  items: { type: "number" },
} as const satisfies JSONSchema;

const resultSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "number" },
      ifc: {
        classification: ["secret"],
        collection: {
          sourceCollection: "/source",
          lengthPreserved: true,
        },
      },
    },
    count: { type: "number" },
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
} as const satisfies JSONSchema;

const patternProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { cell, derive, handler, lift, pattern, type JSONSchema } from 'commontools';",
        "",
        "const inputSchema = {",
        "  type: 'object',",
        "  properties: {",
        "    source: {",
        "      type: 'array',",
        "      items: { type: 'number' }",
        "    }",
        "  },",
        "  required: ['source']",
        "} as const satisfies JSONSchema;",
        "",
        "const outputSchema = {",
        "  type: 'object',",
        "  properties: {",
        "    items: {",
        "      type: 'array',",
        "      items: { type: 'number' },",
        "      ifc: {",
        "        classification: ['secret'],",
        "        collection: {",
        "          sourceCollection: '/source',",
        "          lengthPreserved: true,",
        "        },",
        "      },",
        "    },",
        "    count: { type: 'number' },",
        "    tick: {",
        "      type: 'object',",
        "      properties: { step: { type: 'number' } },",
        "      required: ['step'],",
        "      asStream: true,",
        "    },",
        "  },",
        "  required: ['items', 'count', 'tick'],",
        "} as const satisfies JSONSchema;",
        "",
        "const tickEventSchema = {",
        "  type: 'object',",
        "  properties: { step: { type: 'number' } },",
        "  required: ['step'],",
        "} as const satisfies JSONSchema;",
        "",
        "const tickStateSchema = {",
        "  type: 'object',",
        "  properties: {",
        "    count: { type: 'number', asCell: true },",
        "  },",
        "  required: ['count'],",
        "} as const satisfies JSONSchema;",
        "",
        "const shift = lift((values: number[]) => values.map((value) => value + 10));",
        "",
        "const tick = handler(",
        "  tickEventSchema,",
        "  tickStateSchema,",
        "  (event: unknown, state: unknown) => {",
        "    const { step } = event as { step: number };",
        "    const { count } = state as {",
        "      count: { get: () => number; set: (value: number) => void };",
        "    };",
        "    count.set((count.get() ?? 0) + step);",
        "  },",
        ");",
        "",
        "export default pattern<{ source: number[] }>(",
        "  ({ source }) => {",
        "    const count = cell<number>(0);",
        "    return {",
        "      items: shift(source),",
        "      count: derive(count, (value) => value),",
        "      tick: tick({ count }),",
        "    };",
        "  },",
        "  inputSchema,",
        "  outputSchema,",
        ");",
      ].join("\n"),
    },
  ],
};

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

function snapshotResult(resultCell: ReturnType<Runtime["getCell"]>) {
  const value = resultCell.getAsQueryResult() as {
    items?: number[];
    count?: number;
  };
  return {
    items: [...(value.items ?? [])],
    count: Number(value.count ?? 0),
  };
}

async function phase1CompileAndPersistPattern(
  identity: Identity,
  space: MemorySpace,
): Promise<string> {
  const ctx = createContext(identity);
  const compiled = await ctx.runtime.patternManager.compilePattern(
    patternProgram,
  );
  const patternId = ctx.runtime.patternManager.registerPattern(
    compiled,
    patternProgram,
  );
  await ctx.runtime.patternManager.saveAndSyncPattern({ patternId, space });

  const tx = ctx.runtime.edit();
  const sourceCell = ctx.runtime.getCell<number[]>(
    space,
    SOURCE_CELL_ID,
    sourceSchema,
    tx,
  );
  sourceCell.set([1, 2, 3]);
  const commit = await tx.commit();
  if (commit.error) {
    throw new Error(`phase1 source commit failed: ${commit.error.name}`);
  }
  await ctx.runtime.storageManager.synced();
  await disposeContext(ctx);
  return patternId;
}

async function phase2LoadRunAndPersistOutput(
  identity: Identity,
  space: MemorySpace,
  patternId: string,
): Promise<void> {
  const ctx = createContext(identity);
  const pattern = await ctx.runtime.patternManager.loadPattern(
    patternId,
    space,
  );

  const sourceCell = ctx.runtime.getCell<number[]>(
    space,
    SOURCE_CELL_ID,
    sourceSchema,
  );
  await sourceCell.sync();

  const resultCell = ctx.runtime.getCell<any>(
    space,
    RESULT_CELL_ID,
    resultSchema,
  );
  const tx = ctx.runtime.edit();
  const runResult = ctx.runtime.run(
    tx,
    pattern,
    { source: sourceCell },
    resultCell,
  );
  await prepareCfcCommitIfNeeded(tx);
  const commit = await tx.commit();
  if (commit.error) {
    throw new Error(`phase2 run commit failed: ${commit.error.name}`);
  }

  await runResult.pull();
  await waitForIdle(ctx.runtime);

  const beforeEvents = snapshotResult(resultCell);
  assertEquals(beforeEvents.items, [11, 12, 13]);
  assertEquals(beforeEvents.count, 0);

  const tickStream = resultCell.key("tick") as {
    send: (event: { step: number }) => void;
  };
  tickStream.send({ step: 1 });
  tickStream.send({ step: 2 });
  await waitForIdle(ctx.runtime);
  await resultCell.pull();

  const afterEvents = snapshotResult(resultCell);
  assertEquals(afterEvents.items, [11, 12, 13]);
  assertEquals(afterEvents.count, 3);

  await disposeContext(ctx);
}

async function phase3ReloadAndResumeReactivity(
  identity: Identity,
  space: MemorySpace,
): Promise<void> {
  const ctx = createContext(identity);
  const sourceCell = ctx.runtime.getCell<number[]>(
    space,
    SOURCE_CELL_ID,
    sourceSchema,
  );
  const resultCell = ctx.runtime.getCell<any>(
    space,
    RESULT_CELL_ID,
    resultSchema,
  );
  await sourceCell.sync();
  await resultCell.sync();
  await ctx.runtime.storageManager.synced();

  const persisted = snapshotResult(resultCell);
  assertEquals(persisted.items, [11, 12, 13]);
  assertEquals(persisted.count, 3);

  await ctx.runtime.start(resultCell);
  const tx = ctx.runtime.edit();
  sourceCell.withTx(tx).set([5, 6]);
  const commit = await tx.commit();
  if (commit.error) {
    throw new Error(`phase3 source update commit failed: ${commit.error.name}`);
  }
  await waitForIdle(ctx.runtime);
  await resultCell.pull();

  const resumed = snapshotResult(resultCell);
  assertEquals(resumed.items, [15, 16]);
  assertEquals(resumed.count, 3);

  await disposeContext(ctx);
}

async function runRoundtripTest(): Promise<void> {
  const identity = await Identity.fromPassphrase(
    `cfc-complex-roundtrip-${Date.now()}`,
    keyConfig,
  );
  const space = identity.did();

  const patternId = await phase1CompileAndPersistPattern(identity, space);
  await phase2LoadRunAndPersistOutput(identity, space, patternId);
  await phase3ReloadAndResumeReactivity(identity, space);
}

Deno.test({
  name:
    "complex cfc pattern roundtrip with lift+handler persists across runtimes",
  fn: async () => {
    let timeoutHandle: number;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Test timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });
    try {
      await Promise.race([runRoundtripTest(), timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
