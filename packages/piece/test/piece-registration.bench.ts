import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import type { Cell } from "../../runner/src/builder/types.ts";
import { PieceManager } from "../src/manager.ts";

const BENCH_MEMORY_VERSION = Deno.env.get("BENCH_MEMORY_VERSION") === "v1"
  ? "v1"
  : "v2";

const signer = await Identity.fromPassphrase("piece registration bench");

type BenchEnv = {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  runtime: Runtime;
  manager: PieceManager;
  detachedPieces: Cell<unknown>[];
};

const createDefaultPattern = () => {
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
  return pattern<{ allPieces: Cell<unknown>[] }>(
    ({ allPieces }) => ({
      allPieces,
      addPiece: addPiece({ allPieces }),
    }),
  );
};

const createCounterPattern = () => {
  const { commontools } = createBuilder();
  const { handler, pattern } = commontools;
  const increment = handler<void, { value: number }>(
    (_, { value }) => {
      value++;
    },
    { proxy: true },
  );
  return pattern<{ value: number }>(
    ({ value }) => ({
      value,
      increment: increment({ value }),
    }),
  );
};

async function createBenchEnv(pieceCount: number): Promise<BenchEnv> {
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
    spaceName: `piece-registration-bench-${crypto.randomUUID()}`,
  });
  const manager = new PieceManager(session, runtime);
  await manager.synced();

  const defaultPatternPiece = await manager.runPersistent(
    createDefaultPattern(),
    { allPieces: [] },
    "piece-registration-default-pattern",
  );
  await manager.linkDefaultPattern(defaultPatternPiece);
  await manager.runtime.idle();
  await manager.synced();

  const counterPattern = createCounterPattern();
  const detachedPieces: Cell<unknown>[] = [];
  for (let index = 0; index < pieceCount; index++) {
    const piece = await manager.runPersistent(
      counterPattern,
      { value: index },
      `piece-registration-${index}`,
    );
    detachedPieces.push(piece);
  }

  await manager.runtime.idle();
  await manager.synced();

  return { storageManager, runtime, manager, detachedPieces };
}

const cleanup = async (env: BenchEnv) => {
  await env.runtime.dispose();
  await env.storageManager.close();
};

Deno.bench("PieceManager.add(single detached piece)", async () => {
  const env = await createBenchEnv(1);
  try {
    await env.manager.add([env.detachedPieces[0]!]);
  } finally {
    await cleanup(env);
  }
});

Deno.bench("PieceManager.add(four detached pieces)", async () => {
  const env = await createBenchEnv(4);
  try {
    await env.manager.add(env.detachedPieces);
  } finally {
    await cleanup(env);
  }
});
