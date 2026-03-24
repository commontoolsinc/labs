import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Pattern, Runtime } from "@commonfabric/runner";
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
      doublePattern(),
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
      doublePattern(),
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
      doublePattern(),
      { input: 5 },
      undefined,
      undefined,
      { start: true },
    );

    expect(manager.getResult(piece).get()).toEqual({ output: 10 });

    await manager.runWithPattern(
      tenfoldPattern(),
      piece.entityId!["/"] as string,
      { input: 5 },
      { start: true },
    );

    expect(manager.getResult(piece).get()).toEqual({ output: 50 });
  });

  it("waits for setup to settle before setupPersistent syncs pattern metadata", async () => {
    const pattern = doublePattern();
    const originalSetup = manager.runtime.setup.bind(manager.runtime);
    const originalSyncPattern = manager.syncPattern.bind(manager);
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

    manager.syncPattern = (() => {
      expect(setupResolved).toBe(true);
      return Promise.resolve(pattern);
    }) as typeof manager.syncPattern;

    try {
      const pending = manager.setupPersistent(pattern, { input: 5 });
      await Promise.resolve();
      expect(setupResolved).toBe(false);
      if (!releaseSetup) {
        throw new Error("Expected runtime.setup to be called");
      }
      releaseSetup();
      await pending;
    } finally {
      manager.runtime.setup = originalSetup;
      manager.syncPattern = originalSyncPattern;
    }
  });

  it("restarts stopped pieces when runWithPattern is called with start", async () => {
    const piece = await manager.runPersistent(
      doublePattern(),
      { input: 5 },
      undefined,
      undefined,
      { start: true },
    );

    expect(runtime.runner.cancels.size).toBe(1);

    await manager.stopPiece(piece);

    expect(runtime.runner.cancels.size).toBe(0);

    await manager.runWithPattern(
      tenfoldPattern(),
      piece.entityId!["/"] as string,
      { input: 5 },
      { start: true },
    );

    expect(runtime.runner.cancels.size).toBe(1);
    expect(manager.getResult(piece).get()).toEqual({ output: 50 });
  });
});
