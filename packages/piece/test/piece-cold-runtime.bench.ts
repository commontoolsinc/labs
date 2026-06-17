import { createSession, Identity } from "@commonfabric/identity";
import { entityIdFrom, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { RuntimeProgram } from "../../runner/src/harness/types.ts";
import { pieceId, PieceManager } from "../src/manager.ts";

const signer = await Identity.fromPassphrase("piece cold runtime bench");

const defaultPatternProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { handler, pattern, type Writable } from 'commonfabric';",
        "const addPiece = handler<{ piece: unknown }, { allPieces: Writable<unknown[]> }>(",
        "  ({ piece }, { allPieces }) => {",
        "    allPieces.push(piece);",
        "  },",
        "  { proxy: true },",
        ");",
        "export default pattern<{ allPieces: unknown[] }>(({ allPieces }) => ({",
        "  allPieces,",
        "  addPiece: addPiece({ allPieces }),",
        "}));",
      ].join("\n"),
    },
  ],
};

const persistedPieceProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ value: number }>(({ value }) => ({ value }));",
      ].join("\n"),
    },
  ],
};

type Seed = {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  spaceName: string;
};

async function createSeed(): Promise<Seed> {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const session = await createSession({
    identity: signer,
    spaceName: `piece-cold-runtime-bench-${crypto.randomUUID()}`,
  });
  const manager = new PieceManager(session, runtime);
  await manager.synced();

  const compiledDefaultPattern = await runtime.patternManager.compilePattern(
    defaultPatternProgram,
  );
  const defaultPatternPiece = await manager.runPersistent(
    compiledDefaultPattern,
    { allPieces: [] },
    "piece-cold-runtime-default-pattern",
  );
  await manager.linkDefaultPattern(defaultPatternPiece);
  await manager.runtime.idle();
  await manager.synced();

  const compiledPiecePattern = await runtime.patternManager.compilePattern(
    persistedPieceProgram,
  );
  for (let index = 0; index < 128; index++) {
    await manager.runPersistent(
      compiledPiecePattern,
      { value: index },
      `piece-cold-runtime-${index}`,
    );
  }

  await runtime.dispose();
  return {
    storageManager,
    spaceName: session.spaceName!,
  };
}

async function withFreshManager<T>(
  seed: Seed,
  run: (env: { runtime: Runtime; manager: PieceManager }) => Promise<T>,
): Promise<T> {
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: seed.storageManager,
  });
  const session = await createSession({
    identity: signer,
    spaceName: seed.spaceName,
  });
  const manager = new PieceManager(session, runtime);
  await manager.synced();
  try {
    return await run({ runtime, manager });
  } finally {
    await runtime.idle();
    await manager.synced();
    await runtime.dispose();
  }
}

let nextPieceIndex = 0;

Deno.bench({
  name: "PieceManager.getDefaultPattern(runIt=true, fresh runtime)",
  async fn(b) {
    const seed = await createSeed();
    try {
      await withFreshManager(seed, async ({ manager }) => {
        b.start();
        try {
          await manager.getDefaultPattern(true);
        } finally {
          b.end();
        }
      });
    } finally {
      await seed.storageManager.close();
    }
  },
});

Deno.bench({
  name: "PieceManager.add(single persisted piece, fresh runtime)",
  async fn(b) {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const seedRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const seedSession = await createSession({
      identity: signer,
      spaceName: `piece-cold-runtime-add-${crypto.randomUUID()}`,
    });
    const seedManager = new PieceManager(seedSession, seedRuntime);
    await seedManager.synced();

    try {
      const compiledDefaultPattern = await seedRuntime.patternManager
        .compilePattern(
          defaultPatternProgram,
        );
      const defaultPatternPiece = await seedManager.runPersistent(
        compiledDefaultPattern,
        { allPieces: [] },
        "piece-cold-runtime-default-pattern",
      );
      await seedManager.linkDefaultPattern(defaultPatternPiece);
      await seedManager.runtime.idle();
      await seedManager.synced();

      const compiledPiecePattern = await seedRuntime.patternManager
        .compilePattern(
          persistedPieceProgram,
        );
      const persistedPiece = await seedManager.runPersistent(
        compiledPiecePattern,
        { value: nextPieceIndex++ },
        "piece-cold-runtime-add-piece",
      );
      await seedManager.runtime.idle();
      await seedManager.synced();

      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const session = await createSession({
        identity: signer,
        spaceName: seedSession.spaceName!,
      });
      const manager = new PieceManager(session, runtime);
      await manager.synced();

      try {
        const piece = runtime.getCellFromEntityId(
          manager.getSpace(),
          entityIdFrom(pieceId(persistedPiece)!),
        );
        b.start();
        try {
          await manager.add([piece]);
        } finally {
          b.end();
        }
      } finally {
        await runtime.idle();
        await manager.synced();
        await runtime.dispose();
      }
    } finally {
      await seedRuntime.dispose();
      await storageManager.close();
    }
  },
});
