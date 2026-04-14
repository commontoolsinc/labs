import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import { PieceManager } from "../src/manager.ts";

const signer = await Identity.fromPassphrase("piece startup regression");

describe("PieceManager.startPiece", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const session = await createSession({
      identity: signer,
      spaceName: "piece-startup-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("resolves once the initial result is available, without waiting for global sync", async () => {
    const { commonfabric } = createBuilder();
    const { pattern } = commonfabric;

    const counterPattern = pattern<{ value: number }>(({ value }) => ({
      value,
    }));

    const piece = await manager.runPersistent(
      counterPattern,
      { value: 7 },
      "piece-startup-regression",
      undefined,
      { start: false },
    );

    const originalSynced = manager.synced.bind(manager);
    manager.synced = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 250));

    const startedAt = performance.now();
    try {
      await manager.startPiece(piece);
    } finally {
      manager.synced = originalSynced;
    }

    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(200);
    expect(piece.get()).toEqual({ value: 7 });
  });
});
