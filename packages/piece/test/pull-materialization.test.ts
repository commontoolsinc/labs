import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { NAME, Pattern, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PieceManager } from "../src/manager.ts";
import { PieceController } from "../src/ops/piece-controller.ts";

const signer = await Identity.fromPassphrase("piece pull materialization");

function doublePattern(): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        output: { type: "number" },
      },
    },
    result: {
      output: { $alias: { path: ["internal", "output"] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * 2,
        },
        inputs: { $alias: { path: ["argument", "input"] } },
        outputs: { $alias: { path: ["internal", "output"] } },
      },
    ],
  };
}

function tenfoldPattern(): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        output: { type: "number" },
      },
    },
    result: {
      output: { $alias: { path: ["internal", "output"] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * 10,
        },
        inputs: { $alias: { path: ["argument", "input"] } },
        outputs: { $alias: { path: ["internal", "output"] } },
      },
    ],
  };
}

function namedPattern(name: string, multiplier: number): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        [NAME]: { type: "string" },
        output: { type: "number" },
      },
      required: [NAME, "output"],
    },
    result: {
      [NAME]: name,
      output: { $alias: { path: ["internal", "output"] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * multiplier,
        },
        inputs: { $alias: { path: ["argument", "input"] } },
        outputs: { $alias: { path: ["internal", "output"] } },
      },
    ],
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting ${timeoutMs}ms`);
}

function trustPattern(runtime: Runtime, pattern: Pattern): Pattern {
  return runtime.unsafeTrustPattern(pattern, {
    reason: "piece pull materialization test fixture",
  });
}

describe("piece pull materialization", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
    runtime.scheduler.enablePullMode();

    const session = await createSession({
      identity: signer,
      spaceName: "pull-materialization-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("pulls before reading result values", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const inputCell = await controller.input.getCell();

    await runtime.editWithRetry((tx) => {
      inputCell.withTx(tx).key("input").set(7);
    });

    expect(await controller.result.get(["output"])).toBe(14);
  });

  it("materializes piece results before setInput returns", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.setInput({ input: 7 });

    expect(manager.getResult(piece).get()).toEqual({ output: 14 });
  });

  it("materializes piece results before runWithPattern returns", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      undefined,
      { start: true },
    );

    expect(manager.getResult(piece).get()).toEqual({ output: 10 });

    await manager.runWithPattern(
      trustPattern(runtime, tenfoldPattern()),
      piece.entityId!["/"] as string,
      { input: 5 },
      { start: true },
    );

    expect(manager.getResult(piece).get()).toEqual({ output: 50 });
  });

  it("waits for setup to settle before setupPersistent syncs pattern metadata", async () => {
    const pattern = doublePattern();
    const patternId = "test-pattern-id";
    const originalSetup = manager.runtime.setup.bind(manager.runtime);
    const originalGetPatternMeta = manager.runtime.patternManager.getPatternMeta
      .bind(manager.runtime.patternManager);
    const originalSyncPatternById = manager.syncPatternById.bind(manager);
    let setupResolved = false;
    let releaseSetup: (() => void) | undefined;

    manager.runtime.setup = ((...args) => {
      const piece = args[3];
      return new Promise<typeof piece>((resolve) => {
        releaseSetup = () => {
          setupResolved = true;
          resolve(piece);
        };
      });
    }) as typeof manager.runtime.setup;

    const getPatternMetaStub: unknown = () => ({
      id: patternId,
    });
    manager.runtime.patternManager.getPatternMeta =
      getPatternMetaStub as typeof manager.runtime.patternManager.getPatternMeta;

    manager.syncPatternById = ((id: string) => {
      expect(id).toBe(patternId);
      expect(setupResolved).toBe(true);
      return Promise.resolve(pattern);
    }) as typeof manager.syncPatternById;

    try {
      const pending = manager.setupPersistent(pattern, { input: 5 });
      await waitFor(() => releaseSetup !== undefined);
      expect(setupResolved).toBe(false);
      if (!releaseSetup) {
        throw new Error("Expected runtime.setup to be called");
      }
      releaseSetup();
      await pending;
    } finally {
      manager.runtime.setup = originalSetup;
      manager.runtime.patternManager.getPatternMeta = originalGetPatternMeta;
      manager.syncPatternById = originalSyncPatternById;
    }
  });

  it("restarts stopped pieces when runWithPattern is called with start", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      undefined,
      { start: true },
    );

    expect(runtime.runner.cancels.size).toBe(1);

    await manager.stopPiece(piece);

    expect(runtime.runner.cancels.size).toBe(0);

    await manager.runWithPattern(
      trustPattern(runtime, tenfoldPattern()),
      piece.entityId!["/"] as string,
      { input: 5 },
      { start: true },
    );

    expect(runtime.runner.cancels.size).toBe(1);
    expect(manager.getResult(piece).get()).toEqual({ output: 50 });
  });

  it("updates piece names when runWithPattern changes patterns", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, namedPattern("double", 2)),
      { input: 5 },
      undefined,
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    expect(controller.name()).toBe("double");
    expect(manager.getResult(piece).get()).toEqual({
      [NAME]: "double",
      output: 10,
    });

    await manager.runWithPattern(
      trustPattern(runtime, namedPattern("tenfold", 10)),
      piece.entityId!["/"] as string,
      { input: 5 },
      { start: true },
    );

    expect(controller.name()).toBe("tenfold");
    expect(manager.getResult(piece).get()).toEqual({
      [NAME]: "tenfold",
      output: 50,
    });
  });
});
