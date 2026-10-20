/**
 * A piece a client opens to run, or starts, is held by that client: it keeps
 * running while any client holds it, and stops once the last one has let go,
 * by `PieceRelease` or by leaving. A worker serving several documents is the
 * case this exists for: without it, a piece that one document showed kept
 * running for the worker's whole life after that document went away.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { PiecesController } from "@commonfabric/piece/ops";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { WorkerClient } from "@/backends/worker-client.ts";
import { RequestType } from "@/protocol/mod.ts";
import { buildProcessor } from "./build-processor.ts";

const signer = await Identity.fromPassphrase("runtime-client piece holds");

const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "export default pattern<{ value: number }>(({ value }) => ({",
      "  doubled: computed(() => value * 2),",
      "}));",
    ].join("\n"),
  }],
};

function client(id: number): WorkerClient {
  return { id, post: () => true };
}

describe("piece holds", () => {
  let space: MemorySpace;
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let root: Cell<unknown>;
  let pieceId: string;

  beforeEach(async () => {
    space = (await Identity.generate()).did();
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: storage,
    });
    pieces = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      runtime,
    );
    await pieces.synced();
    // Created, which starts it for good, then stopped: a stored piece that
    // nothing runs, as a client finds one it opens.
    const piece = await pieces.create<{ doubled: number }>(PROGRAM, {
      input: { value: 3 },
    });
    root = piece.getCell();
    pieceId = entityRefToString(root.entityId);
    await pieces.stopPiece(root);
    expect(runtime.runner.isRunning(root)).toBe(false);
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storage?.close();
  });

  function processor() {
    return buildProcessor({ runtime, cc: pieces, space, identity: signer });
  }

  function open(target: ReturnType<typeof processor>, by: WorkerClient) {
    return target.handlePieceGet(
      { type: RequestType.PieceGet, pieceId, space, runIt: true },
      by,
    );
  }

  it("stops a piece once every client that opened it has left", async () => {
    const worker = processor();
    const first = client(1);
    const second = client(2);
    await open(worker, first);
    await open(worker, second);
    expect(runtime.runner.isRunning(root)).toBe(true);

    worker.disposeClient(first);
    expect(runtime.runner.isRunning(root)).toBe(true);
    worker.disposeClient(second);
    expect(runtime.runner.isRunning(root)).toBe(false);
  });

  it("holds nothing for a client that opened a piece without running it", async () => {
    const worker = processor();
    const reader = client(1);
    await worker.handlePieceGet(
      { type: RequestType.PieceGet, pieceId, space },
      reader,
    );
    expect(runtime.runner.isRunning(root)).toBe(false);
    await expect(
      worker.handlePieceRelease(
        { type: RequestType.PieceRelease, pieceId, space },
        reader,
      ),
    ).resolves.toEqual({ value: false });
  });

  it("stops a piece a client started once it releases it", async () => {
    const worker = processor();
    const starter = client(1);
    await worker.handlePieceStart(
      { type: RequestType.PieceStart, pieceId, space },
      starter,
    );
    expect(runtime.runner.isRunning(root)).toBe(true);

    await expect(
      worker.handlePieceRelease(
        { type: RequestType.PieceRelease, pieceId, space },
        starter,
      ),
    ).resolves.toEqual({ value: true });
    expect(runtime.runner.isRunning(root)).toBe(false);
  });

  it("gives up the hold of a client that left while its open was in flight", async () => {
    const worker = processor();
    const leaving = client(1);
    const opening = open(worker, leaving);
    worker.disposeClient(leaving);
    await opening;

    expect(runtime.runner.isRunning(root)).toBe(false);
  });

  it("leaves a piece the worker started for good when its clients leave", async () => {
    await pieces.startPiece(root);
    const worker = processor();
    const visitor = client(1);
    await open(worker, visitor);

    worker.disposeClient(visitor);
    expect(runtime.runner.isRunning(root)).toBe(true);
  });
});
