import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { getPatternIdentityRef, Pattern, Runtime } from "@commonfabric/runner";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PieceManager } from "../src/manager.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece step slot");

function doublePattern(): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: { input: { type: "number" } },
    },
    resultSchema: {
      type: "object",
      properties: { output: { type: "number" } },
    },
    derivedInternalCells: [{ partialCause: "output" }],
    result: { output: { $alias: { partialCause: "output", path: [] } } },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * 2,
        },
        inputs: { $alias: { cell: "argument", path: ["input"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      },
    ],
  };
}

describe("piece run/step through a value-link slot", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
    const session = await createSession({
      identity: signer,
      spaceName: "piece-step-slot-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("starts a piece addressed through a value-link slot (the cf piece step path)", async () => {
    // Canonical piece K carries patternIdentity; the value-link slot R -> K (the
    // shape a piece pushed into a list/object gets addressed by) carries none.
    const k = await manager.runPersistent(
      runtime.unsafeTrustPattern(doublePattern(), {
        reason: "piece step slot test fixture",
      }),
      { input: 5 },
      undefined,
      { start: true },
    );
    const r = runtime.getCell(
      manager.getSpace(),
      "step-slot-" + crypto.randomUUID(),
    );
    await runtime.editWithRetry((tx) => {
      r.withTx(tx).set(k.getAsLink());
    });
    await manager.synced();
    const slotId = entityRefToString(r.entityId);

    // Before this fix, `get(slotId, runIt=true)` -> `runtime.start(R)` threw
    // "Cannot start: no pattern identity" (R has none). `manager.get` now
    // canonicalizes R -> K, so start / read / stop operate on the real piece.
    const pieces = new PiecesController(manager);
    const started = await pieces.get(slotId, true);
    expect(getPatternIdentityRef(started.getCell())).toBeDefined();
    expect(await started.result.get(["output"])).toBe(10);
  });
});
