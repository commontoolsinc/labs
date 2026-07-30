import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  factoryStateOf,
  type FactoryStateV1,
  isAdmittedFabricFactory,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { createSession, Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type MemorySpace,
  popFrame,
  pushFrame,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";

import { EmulatedStorageManager } from "../../runner/src/storage/v2-emulate.ts";
import type { Options } from "../../runner/src/storage/v2.ts";
import { TEST_MEMORY_SERVER_AUTH } from "../../runner/test/memory-v2-test-utils.ts";
import { pieceId, PieceManager } from "../src/manager.ts";
import { PieceController } from "../src/ops/piece-controller.ts";

const signer = await Identity.fromPassphrase(
  "piece factory result round trip",
);

const FACTORY_RESULT_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { handler, lift, pattern, type HandlerFactory } from 'commonfabric';",
      "export const patternFactory = pattern<{ value: number }, { result: number }>(({ value }) => ({ result: value }));",
      "export const moduleFactory = lift((value: number): number => value + 1);",
      "export const handlerFactory: HandlerFactory<{ prefix: string }, number> = handler(",
      "  { type: 'number' },",
      "  { type: 'object', properties: { prefix: { type: 'string' } }, required: ['prefix'] },",
      "  (_event: number, _context: { prefix: string }) => undefined,",
      ");",
      "const exposeFactories = lift((_trigger: null) => ({",
      "  nested: {",
      "    pattern: patternFactory,",
      "    module: moduleFactory,",
      "    handler: handlerFactory,",
      "  },",
      "}));",
      "export default pattern(() => exposeFactories(null));",
    ].join("\n"),
  }],
};

const FACTORY_SYMBOLS = [
  "patternFactory",
  "moduleFactory",
  "handlerFactory",
] as const;
const FACTORY_KINDS = ["pattern", "module", "handler"] as const;

type StoredFactoryResult = {
  nested: {
    pattern: FabricValue;
    module: FabricValue;
    handler: FabricValue;
  };
};

type FactoryResultSchema = {
  properties?: {
    nested?: {
      properties?: Record<
        string,
        { asFactory?: { kind?: unknown } }
      >;
    };
  };
};

class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.sharedServer = server;
    return manager;
  }

  private sharedServer!: MemoryV2Server.Server;

  protected override server(): MemoryV2Server.Server {
    return this.sharedServer;
  }
}

function createSharedServer(): MemoryV2Server.Server {
  return new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });
}

function resultFactories(result: StoredFactoryResult): FabricValue[] {
  return [
    result.nested.pattern,
    result.nested.module,
    result.nested.handler,
  ];
}

function expectInertFactory(
  value: FabricValue,
  expectedState: FactoryStateV1,
): void {
  expect(isAdmittedFabricFactory(value)).toBe(true);
  expect(factoryStateOf(value)).toEqual(expectedState);
  expect(Object.isFrozen(value)).toBe(true);
  expect(() => (value as unknown as () => unknown)()).toThrow(
    "factory requires runner materialization",
  );
}

function invokeFactories(
  runtime: Runtime,
  space: MemorySpace,
  factories: FabricValue[],
): void {
  const frame = pushFrame({
    space,
    generatedIdCounter: 0,
    reactives: new Set(),
    runtime,
  });
  try {
    (factories[0] as unknown as (value: { value: number }) => unknown)({
      value: 1,
    });
    (factories[1] as unknown as (value: number) => unknown)(1);
    (factories[2] as unknown as (value: { prefix: string }) => unknown)({
      prefix: "piece-result",
    });
  } finally {
    popFrame(frame);
  }
}

describe("PieceManager Factory@1 result persistence", () => {
  it("round-trips nested factories through a fresh PieceManager runtime", async () => {
    const server = createSharedServer();
    let writerStorage: SharedServerStorageManager | undefined =
      SharedServerStorageManager.connectTo(server, { as: signer });
    let writerRuntime: Runtime | undefined = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    let readerStorage: SharedServerStorageManager | undefined;
    let readerRuntime: Runtime | undefined;

    try {
      const spaceName = `piece-factory-result-${crypto.randomUUID()}`;
      const writerSession = await createSession({
        identity: signer,
        spaceName,
      });
      const writerManager = new PieceManager(writerSession, writerRuntime);
      await writerManager.synced();

      let identity: string | undefined;
      const pattern = await writerRuntime.patternManager.compilePattern(
        FACTORY_RESULT_PROGRAM,
        {
          space: writerManager.getSpace(),
          onEntryIdentity(value) {
            identity = value;
          },
        },
      );
      expect(identity).toBeDefined();

      const resultSchema = pattern.resultSchema as FactoryResultSchema;
      for (let index = 0; index < FACTORY_KINDS.length; index++) {
        const kind = FACTORY_KINDS[index];
        expect(
          resultSchema.properties?.nested?.properties?.[kind]?.asFactory?.kind,
        ).toBe(kind);
      }

      const expectedStates = FACTORY_SYMBOLS.map((symbol) => {
        const factory = writerRuntime!.patternManager
          .artifactFromIdentitySync(identity!, symbol);
        expect(factory).toBeDefined();
        return sealFactoryState(factory);
      });

      const piece = await writerManager.runPersistent<StoredFactoryResult>(
        pattern,
        {},
        "piece-factory-result-roundtrip",
        { start: true },
      );
      const id = pieceId(piece);
      expect(id).toBeDefined();
      await writerRuntime.patternManager.flushCompileCacheWrites();
      await writerManager.synced();
      await writerStorage.synced();

      await writerRuntime.dispose();
      writerRuntime = undefined;
      await writerStorage.close();
      writerStorage = undefined;

      readerStorage = SharedServerStorageManager.connectTo(server, {
        as: signer,
      });
      readerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: readerStorage,
      });
      const readerSession = await createSession({
        identity: signer,
        spaceName,
      });
      const readerManager = new PieceManager(readerSession, readerRuntime);
      await readerManager.synced();

      for (const symbol of FACTORY_SYMBOLS) {
        expect(
          readerRuntime.patternManager.artifactFromIdentitySync(
            identity!,
            symbol,
          ),
        ).toBeUndefined();
      }

      const freshPiece = await readerManager.get<StoredFactoryResult>(
        id!,
        true,
      );
      const rawResult = freshPiece.resolveAsCell().getRaw() as
        | StoredFactoryResult
        | undefined;
      expect(rawResult).toBeDefined();
      const rawFactories = resultFactories(rawResult!);
      for (let index = 0; index < rawFactories.length; index++) {
        expectInertFactory(rawFactories[index], expectedStates[index]);
      }

      expect(
        readerRuntime.patternManager.isArtifactAvailableInSpace(
          identity!,
          readerManager.getSpace(),
        ),
      ).toBe(true);
      for (const symbol of FACTORY_SYMBOLS) {
        expect(
          readerRuntime.patternManager.artifactFromIdentitySync(
            identity!,
            symbol,
          ),
        ).toBeDefined();
      }

      const controller = new PieceController(readerManager, freshPiece);
      const exposed = await controller.result.get() as StoredFactoryResult;
      const exposedFactories = resultFactories(exposed);
      for (let index = 0; index < exposedFactories.length; index++) {
        expect(isAdmittedFabricFactory(exposedFactories[index])).toBe(true);
        expect(sealFactoryState(exposedFactories[index])).toEqual(
          expectedStates[index],
        );
        expect(exposedFactories[index]).not.toBe(rawFactories[index]);
        expect(exposedFactories[index]).toBe(
          readerRuntime.patternManager.artifactFromIdentitySync(
            identity!,
            FACTORY_SYMBOLS[index],
          ),
        );
      }
      invokeFactories(
        readerRuntime,
        readerManager.getSpace(),
        exposedFactories,
      );
    } finally {
      await readerRuntime?.dispose();
      await readerStorage?.close();
      await writerRuntime?.dispose();
      await writerStorage?.close();
    }
  });
});
