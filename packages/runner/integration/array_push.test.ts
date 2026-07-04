#!/usr/bin/env -S deno run -A

/**
 * Integration test: verify writable-array `.push()` works against the real
 * remote memory transport and toolshed app.
 */
import app from "../../toolshed/app.ts";
import { Identity } from "@commonfabric/identity";
import { type JSONSchema, Runtime } from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

type ErrorConstructorWithStackTraceLimit = ErrorConstructor & {
  stackTraceLimit: number;
};

(Error as ErrorConstructorWithStackTraceLimit).stackTraceLimit = 100;

const TOTAL_COUNT = 20;
const TIMEOUT_MS = 180000;

const OutputSchema = {
  type: "object",
  properties: {
    my_numbers_array: {
      type: "array",
      items: { type: "number" },
    },
    my_objects_array: {
      type: "array",
      items: {
        type: "object",
        properties: { count: { type: "number" } },
      },
    },
    pushNumbersHandler: {
      type: "object",
      properties: { value: { type: "number" } },
      asCell: ["stream"],
    },
    pushObjectsHandler: {
      type: "object",
      properties: {
        value: {
          type: "object",
          properties: { count: { type: "number" } },
        },
      },
      asCell: ["stream"],
    },
  },
  required: [
    "my_numbers_array",
    "my_objects_array",
    "pushNumbersHandler",
    "pushObjectsHandler",
  ],
} as const satisfies JSONSchema;

function readExperimentalFlag(name: string): boolean | undefined {
  const value = Deno.env.get(name);
  if (value === undefined || value === "") return undefined;
  return value === "true" || value === "1";
}

function createRuntime(identity: Identity, base: URL): Runtime {
  return new Runtime({
    apiUrl: base,
    storageManager: StorageManager.open({
      as: identity,
      memoryHost: new URL(base),
    }),
    experimental: {
      modernCellRep: readExperimentalFlag("EXPERIMENTAL_MODERN_CELL_REP"),
      persistentSchedulerState: readExperimentalFlag(
        "EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE",
      ),
    },
  });
}

async function runTest(base: URL) {
  const account = await Identity.fromPassphrase(
    `array-push-test-${crypto.randomUUID()}`,
  );
  const runtime = createRuntime(account, base);
  const space = account.did();

  try {
    const patternSource = await Deno.readTextFile(
      new URL("./array_push.test.tsx", import.meta.url),
    );
    const pattern = await runtime.patternManager.compilePattern(patternSource, {
      space,
    });

    const resultCell = runtime.getCell(
      space,
      `array-push-result-${crypto.randomUUID()}`,
      pattern.resultSchema,
    );
    const result = await runtime.runSynced(resultCell, pattern, {});
    const shaped = result.asSchema(OutputSchema);
    const cancelSink = shaped.sink(() => {});

    const expectedNumbers: number[] = [];
    const expectedObjects: { count: number }[] = [];

    for (let i = 0; i < TOTAL_COUNT; i++) {
      await runtime.editWithRetry((tx) =>
        shaped.key("pushNumbersHandler").withTx(tx).send({ value: i })
      );
      await runtime.editWithRetry((tx) =>
        shaped.key("pushObjectsHandler").withTx(tx).send({
          value: { count: i },
        })
      );
      expectedNumbers.push(i);
      expectedObjects.push({ count: i });
    }

    await runtime.idle();
    await runtime.storageManager.synced();

    const actualNumbers = await shaped.key("my_numbers_array").pull() as
      | number[]
      | undefined;
    const actualObjects = await shaped.key("my_objects_array").pull() as
      | { count: number }[]
      | undefined;

    if (!actualNumbers || !actualObjects) {
      throw new Error("Pattern result did not materialize expected arrays");
    }

    if (actualNumbers.length !== TOTAL_COUNT) {
      throw new Error(
        `Expected ${TOTAL_COUNT} numbers but got ${actualNumbers.length}`,
      );
    }

    if (actualObjects.length !== TOTAL_COUNT) {
      throw new Error(
        `Expected ${TOTAL_COUNT} objects but got ${actualObjects.length}`,
      );
    }

    if (JSON.stringify(actualNumbers) !== JSON.stringify(expectedNumbers)) {
      throw new Error(
        `Numbers array mismatch\nExpected: ${
          JSON.stringify(expectedNumbers)
        }\nActual: ${JSON.stringify(actualNumbers)}`,
      );
    }

    if (JSON.stringify(actualObjects) !== JSON.stringify(expectedObjects)) {
      throw new Error(
        `Objects array mismatch\nExpected: ${
          JSON.stringify(expectedObjects)
        }\nActual: ${JSON.stringify(actualObjects)}`,
      );
    }

    cancelSink();
  } finally {
    await runtime.dispose();
  }
}

Deno.test({
  name: "array push test",
  fn: async () => {
    const server = Deno.serve({ port: 0 }, app.fetch);
    const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);

    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Test timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });

    try {
      await Promise.race([runTest(base), timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle!);
      await server.shutdown();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
