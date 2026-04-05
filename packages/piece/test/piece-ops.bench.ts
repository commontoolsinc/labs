import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import type { Cell } from "../../runner/src/builder/types.ts";
import { pieceId, PieceManager } from "../src/manager.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const BENCH_MEMORY_VERSION = Deno.env.get("BENCH_MEMORY_VERSION") === "v1"
  ? "v1"
  : "v2";

const signer = await Identity.fromPassphrase("piece bench");

type BenchEnv = {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  runtime: Runtime;
  manager: PieceManager;
  pieces: PiecesController;
  piece: Cell<unknown>;
};

async function createBenchEnv(): Promise<BenchEnv> {
  const storageManager = StorageManager.emulate({
    as: signer,
    memoryVersion: BENCH_MEMORY_VERSION,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    memoryVersion: BENCH_MEMORY_VERSION,
  });
  const session = await createSession({
    identity: signer,
    spaceName: `piece-bench-${crypto.randomUUID()}`,
  });
  const manager = new PieceManager(session, runtime);
  await manager.synced();
  const pieces = new PiecesController(manager);

  const { commontools } = createBuilder();
  const { handler, pattern } = commontools;

  const addPiece = handler<
    { piece: Cell<unknown> },
    { allPieces: Cell<unknown>[] }
  >(
    ({ piece }, { allPieces }) => {
      allPieces.push(piece);
    },
    { proxy: true },
  );
  const defaultPattern = pattern<{ allPieces: Cell<unknown>[] }>(
    ({ allPieces }) => ({
      allPieces,
      addPiece: addPiece({ allPieces }),
    }),
  );
  const defaultPatternPiece = await manager.runPersistent(
    defaultPattern,
    { allPieces: [] },
    "piece-bench-default-pattern",
  );
  await manager.linkDefaultPattern(defaultPatternPiece);
  await manager.runtime.idle();
  await manager.synced();

  const increment = handler<void, { value: number }>(
    (_, { value }) => {
      value++;
    },
    { proxy: true },
  );
  const counterPattern = pattern<{ value: number }>(
    ({ value }) => ({
      value,
      increment: increment({ value }),
    }),
  );
  const piece = await manager.runPersistent(
    counterPattern,
    { value: 0 },
    "piece-bench-counter",
  );
  await manager.add([piece]);

  return { storageManager, runtime, manager, pieces, piece };
}

const env = await createBenchEnv();

Deno.bench("PiecesController.ensureDefaultPattern(existing)", async () => {
  await env.pieces.ensureDefaultPattern();
});

Deno.bench("PieceManager.startPiece(existing)", async () => {
  await env.manager.stopPiece(env.piece);
  await env.manager.startPiece(env.piece);
});

Deno.bench("PiecesController.get(runIt=true)", async () => {
  await env.manager.stopPiece(env.piece);
  await env.pieces.get(pieceId(env.piece)!, true);
});
