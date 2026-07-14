import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  jsonFromValue,
  valueFromJson,
} from "@commonfabric/data-model/codec-json";
import {
  factoryStateOf,
  type FactoryStateV1,
  isAdmittedFabricFactory,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type {
  HandlerFactory,
  ModuleFactory,
  PatternFactory,
} from "../src/builder/types.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { convertCellsToLinks } from "../src/cell.ts";
import { setCompileCacheRuntimeVersionForTesting } from "../src/compilation-cache/cell-cache.ts";
import {
  type MaterializedFactory,
  materializeFactory,
  prepareFactory,
} from "../src/factory-materialization.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("factory roundtrip integration");
const sourceSpace = signer.did();
const destinationSpace = (await Identity.fromPassphrase(
  "factory roundtrip integration destination",
)).did();

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { handler, lift, pattern } from 'commonfabric';",
      "export const patternFactory = pattern<{ value: number }>(({ value }) => ({ result: value }));",
      "export const moduleFactory = lift((value: number) => value + 1);",
      "export const handlerFactory = handler((_event: number, _context: { prefix: string }) => undefined);",
      "export default pattern<{ value: number }>(({ value }) => ({ result: value }));",
    ].join("\n"),
  }],
};

const SYMBOLS = [
  "patternFactory",
  "moduleFactory",
  "handlerFactory",
] as const;

type FactoryTuple = readonly [
  PatternFactory<unknown, unknown>,
  ModuleFactory<unknown, unknown>,
  HandlerFactory<unknown, unknown>,
];

type PersistedFactoryValues = {
  pattern: FactoryTuple[0];
  module: FactoryTuple[1];
  handler: FactoryTuple[2];
};

// Each instance owns a separate cold client replica while all instances talk
// to one in-process server. This catches false "fresh runtime" tests that keep
// using a writer's warm StorageManager cache.
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

interface StoredFactories {
  readonly identity: string;
  readonly factories: FactoryTuple;
  readonly states: readonly [FactoryStateV1, FactoryStateV1, FactoryStateV1];
  readonly encoded: string;
  readonly shells: FactoryTuple;
}

describe("Factory@1 runner round trips", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let writer: Runtime;
  const extraRuntimes: Runtime[] = [];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    while (extraRuntimes.length > 0) {
      await extraRuntimes.pop()!.dispose();
    }
    await writer.dispose();
    await storageManager.close();
  });

  async function storeFactories(): Promise<StoredFactories> {
    let identity: string | undefined;
    await writer.patternManager.compilePattern(PROGRAM, {
      space: sourceSpace,
      onEntryIdentity(value) {
        identity = value;
      },
    });
    expect(identity).toBeDefined();
    await storageManager.synced();

    const baseFactories = SYMBOLS.map((symbol) =>
      writer.patternManager.artifactFromIdentitySync(identity!, symbol)
    ) as unknown as FactoryTuple;
    const factories = [
      baseFactories[0].asScope("user").inSpace("execution-target"),
      baseFactories[1].asScope("session"),
      baseFactories[2],
    ] as const satisfies FactoryTuple;
    for (const factory of factories) {
      expect(isAdmittedFabricFactory(factory)).toBe(true);
    }
    const states = factories.map((factory) =>
      sealFactoryState(factory)
    ) as unknown as StoredFactories["states"];
    const encoded = jsonFromValue({
      nested: { factories: [...factories] },
    } as FabricValue);
    const decoded = valueFromJson(encoded) as {
      nested: { factories: FactoryTuple };
    };
    return {
      identity: identity!,
      factories,
      states,
      encoded,
      shells: decoded.nested.factories,
    };
  }

  function invokeAll(
    runtime: Runtime,
    factories: readonly MaterializedFactory[],
  ): void {
    const frame = pushFrame({
      space: sourceSpace,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
    try {
      expect(() => factories[0]!({ value: 1 } as never)).not.toThrow();
      expect(() => factories[1]!(1 as never)).not.toThrow();
      expect(() => factories[2]!({ prefix: "x" } as never)).not.toThrow();
    } finally {
      popFrame(frame);
    }
  }

  it("context-free decodes all kinds inertly and warm-materializes nested values", async () => {
    const { encoded, factories, shells, states } = await storeFactories();

    expect(jsonFromValue({ nested: { factories: [...shells] } } as FabricValue))
      .toBe(encoded);
    for (let index = 0; index < shells.length; index++) {
      expect(typeof shells[index]).toBe("function");
      expect(factoryStateOf(shells[index])).toEqual(states[index]);
      expect(() => shells[index]!(undefined as never)).toThrow(
        "factory requires runner materialization",
      );
    }

    const materialized = shells.map((shell) =>
      materializeFactory(shell, {
        runtime: writer,
        artifactSpace: sourceSpace,
      })
    );
    for (let index = 0; index < materialized.length; index++) {
      expect(sealFactoryState(materialized[index])).toEqual(states[index]);
      expect(materialized[index]).not.toBe(shells[index]);
      expect(typeof factories[index]).toBe("function");
    }
    invokeAll(writer, materialized);
  });

  it("genuinely cold-loads and invokes each kind in an independent fresh runtime", async () => {
    const { identity, shells, states } = await storeFactories();
    const independentlyLoaded: MaterializedFactory[] = [];

    for (let index = 0; index < SYMBOLS.length; index++) {
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      extraRuntimes.push(runtime);
      expect(
        runtime.patternManager.artifactFromIdentitySync(
          identity,
          SYMBOLS[index],
        ),
      ).toBeUndefined();
      const materialized = await prepareFactory(shells[index], {
        runtime,
        artifactSpace: sourceSpace,
      });
      expect(sealFactoryState(materialized)).toEqual(states[index]);
      expect(
        runtime.patternManager.artifactFromIdentitySync(
          identity,
          SYMBOLS[index],
        ),
      ).toBeDefined();
      invokeOne(runtime, index, materialized, sourceSpace);
      independentlyLoaded.push(materialized);
    }

    const secondPatternRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(secondPatternRuntime);
    const secondPattern = await prepareFactory(shells[0], {
      runtime: secondPatternRuntime,
      artifactSpace: sourceSpace,
    });
    expect(hashOf(secondPattern).toString()).toBe(
      hashOf(independentlyLoaded[0]).toString(),
    );
  });

  it("publishes synchronously after a storage-backed compiled artifact load", async () => {
    const { identity, shells } = await storeFactories();
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(runtime);

    await prepareFactory(shells[0], {
      runtime,
      artifactSpace: sourceSpace,
    });
    const publication = runtime.patternManager.prepareArtifactPublication(
      identity,
      sourceSpace,
      destinationSpace,
    );

    expect(Array.isArray(publication)).toBe(true);
    expect((publication as readonly unknown[]).length).toBeGreaterThan(0);
  });

  it("publishes synchronously after source recovery for a new runtime version", async () => {
    const restoreVersionA = setCompileCacheRuntimeVersionForTesting(
      "factory-publication-version-a",
    );
    try {
      const { identity, shells } = await storeFactories();
      const restoreVersionB = setCompileCacheRuntimeVersionForTesting(
        "factory-publication-version-b",
      );
      try {
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        extraRuntimes.push(runtime);

        await prepareFactory(shells[0], {
          runtime,
          artifactSpace: sourceSpace,
        });
        expect(runtime.patternManager.getCompileCacheStats().byIdentityHits)
          .toBe(0);
        const publication = runtime.patternManager.prepareArtifactPublication(
          identity,
          sourceSpace,
          destinationSpace,
        );

        expect(Array.isArray(publication)).toBe(true);
        expect((publication as readonly unknown[]).length).toBeGreaterThan(0);
        await runtime.patternManager.flushCompileCacheWrites();
      } finally {
        restoreVersionB();
      }
    } finally {
      restoreVersionA();
    }
  });

  it("warm-materializes a decoded root PatternFactory before synchronous run", async () => {
    const { identity } = await storeFactories();
    const live = writer.patternManager.artifactFromIdentitySync(
      identity,
      "patternFactory",
    ) as PatternFactory<unknown, unknown>;
    const shell = valueFromJson(
      jsonFromValue(live as unknown as FabricValue),
    ) as PatternFactory<unknown, unknown>;
    const tx = writer.edit();
    const result = writer.getCell<{ result: number }>(
      sourceSpace,
      "warm-decoded-root-factory",
      undefined,
      tx,
    );

    writer.run(tx, shell as never, { value: 9 } as never, result);
    writer.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();

    expect(await result.pull()).toEqual({ result: 9 });
    expect(result.getMetaRaw("patternIdentity")).toEqual({
      identity,
      symbol: "patternFactory",
    });
  });

  it("cold-materializes a decoded root PatternFactory before non-transactional setup", async () => {
    const { identity } = await storeFactories();
    const live = writer.patternManager.artifactFromIdentitySync(
      identity,
      "patternFactory",
    ) as PatternFactory<unknown, unknown>;
    const shell = valueFromJson(
      jsonFromValue(live as unknown as FabricValue),
    ) as PatternFactory<unknown, unknown>;
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(runtime);
    expect(
      runtime.patternManager.artifactFromIdentitySync(
        identity,
        "patternFactory",
      ),
    ).toBeUndefined();
    const result = runtime.getCell<{ result: number }>(
      sourceSpace,
      "cold-decoded-root-factory",
    );

    await runtime.setup(undefined, shell as never, { value: 11 }, result);

    expect(
      runtime.patternManager.artifactFromIdentitySync(
        identity,
        "patternFactory",
      ),
    ).toBeDefined();
    expect(result.getMetaRaw("patternIdentity")).toEqual({
      identity,
      symbol: "patternFactory",
    });
  });

  it("rejects a decoded HandlerFactory at root setup before writing piece state", async () => {
    const { shells } = await storeFactories();
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(runtime);
    const result = runtime.getCell(
      sourceSpace,
      "rejected-handler-root-factory",
    );

    await expect(
      runtime.setup(undefined, shells[2] as never, {}, result),
    ).rejects.toThrow(
      "Root setup requires a pattern or module factory, got handler",
    );

    expect(result.getRaw()).toBeUndefined();
  });

  it("preserves modifier state, including anonymous and link-mapped selectors", async () => {
    const { factories } = await storeFactories();
    const patternFactory = factories[0];
    const anonymous = patternFactory.inSpace();
    const selectorCell = writer.getCell(sourceSpace, "factory selector");
    const cellSelected = convertCellsToLinks(
      patternFactory.inSpace(selectorCell as never),
    ) as PatternFactory<unknown, unknown>;

    for (const carried of [anonymous, cellSelected]) {
      const encoded = jsonFromValue(carried as FabricValue);
      const shell = valueFromJson(encoded) as PatternFactory<unknown, unknown>;
      expect(jsonFromValue(shell as FabricValue)).toBe(encoded);
      const materialized = materializeFactory(shell, {
        runtime: writer,
        artifactSpace: sourceSpace,
      });
      expect(sealFactoryState(materialized)).toEqual(sealFactoryState(carried));
    }

    const anonymousState = sealFactoryState(anonymous);
    const cellState = sealFactoryState(cellSelected);
    expect(anonymousState.kind).toBe("pattern");
    expect(cellState.kind).toBe("pattern");
    if (anonymousState.kind === "pattern" && cellState.kind === "pattern") {
      expect(anonymousState.defaultScope).toBe("user");
      expect(anonymousState.spaceSelector).toBe("");
      expect(cellState.defaultScope).toBe("user");
      expect(cellState.spaceSelector).toEqual(selectorCell.getAsLink());
    }
  });

  it("loads a replicated by-value factory from its containing space while retaining its execution selector", async () => {
    const { identity, factories, shells, states } = await storeFactories();
    expect(() => writer.getImmutableCell(destinationSpace, factories[0]))
      .toThrow(`is not available in space ${destinationSpace}`);

    await writer.patternManager.ensureArtifactClosureInSpace(
      identity,
      sourceSpace,
      destinationSpace,
    );
    expect(() => writer.getImmutableCell(destinationSpace, factories[0])).not
      .toThrow();

    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(runtime);
    const materialized = await prepareFactory(shells[0], {
      runtime,
      artifactSpace: destinationSpace,
    });
    expect(sealFactoryState(materialized)).toEqual(states[0]);
    const state = sealFactoryState(materialized);
    if (state.kind !== "pattern") throw new Error("expected pattern state");
    expect(state.spaceSelector).toBe("execution-target");
    expect(destinationSpace).not.toBe(state.spaceSelector);
  });

  it("atomically publishes every by-value factory kind into its destination space", async () => {
    const { identity, factories, shells, states } = await storeFactories();
    const tx = writer.edit();
    const destination = writer.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "auto-published-factory-kinds",
      undefined,
      tx,
    );
    destination.set({ factories });

    writer.prepareTxForCommit(tx);
    expect(destination.getRaw()).toEqual({ factories });
    expect((await tx.commit()).error).toBeUndefined();
    expect(
      writer.patternManager.isArtifactAvailableInSpace(
        identity,
        destinationSpace,
      ),
    ).toBe(true);

    const cold = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(cold);
    for (let index = 0; index < shells.length; index += 1) {
      const materialized = await prepareFactory(shells[index], {
        runtime: cold,
        artifactSpace: destinationSpace,
      });
      expect(sealFactoryState(materialized)).toEqual(states[index]);
    }
  });

  it("cold-loads private source provenance while keeping the destination write optimistic", async () => {
    const { factories } = await storeFactories();
    const sourceTx = writer.edit();
    const source = writer.getCell<{ factories: FactoryTuple }>(
      sourceSpace,
      "cold-publication-source",
      undefined,
      sourceTx,
    );
    source.set({ factories });
    writer.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit()).error).toBeUndefined();

    const mover = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(mover);
    const carried = mover.getCell<{ factories: FactoryTuple }>(
      sourceSpace,
      "cold-publication-source",
    ).getRaw()! as unknown as { factories: FactoryTuple };
    const destinationTx = mover.edit();
    const destination = mover.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "cold-publication-destination",
      undefined,
      destinationTx,
    );
    destination.set(carried);
    mover.prepareTxForCommit(destinationTx);

    // Source verification is async in this fresh PatternManager, but local
    // speculative visibility is not.
    expect(destination.getRaw()).toEqual(carried);
    expect((await destinationTx.commit()).error).toBeUndefined();
  });
});

describe("Factory@1 fresh-runtime value round trip", () => {
  it("persists, cold-decodes, materializes, and invokes every factory kind", async () => {
    const server = createSharedServer();
    let writerStorage: SharedServerStorageManager | undefined =
      SharedServerStorageManager.connectTo(server, { as: signer });
    let coldWriter: Runtime | undefined = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    let readerStorage: SharedServerStorageManager | undefined;
    let reader: Runtime | undefined;

    try {
      let identity: string | undefined;
      await coldWriter.patternManager.compilePattern(PROGRAM, {
        space: sourceSpace,
        onEntryIdentity(value) {
          identity = value;
        },
      });
      expect(identity).toBeDefined();

      const factories = SYMBOLS.map((symbol) =>
        coldWriter!.patternManager.artifactFromIdentitySync(identity!, symbol)
      ) as unknown as FactoryTuple;
      const values: PersistedFactoryValues = {
        pattern: factories[0],
        module: factories[1],
        handler: factories[2],
      };
      const states = factories.map((factory) => sealFactoryState(factory));
      for (const state of states) {
        expect(state.ref.identity).toBe(identity);
        expect("$implRef" in state).toBe(false);
      }

      const tx = coldWriter.edit();
      const cell = coldWriter.getCell<PersistedFactoryValues>(
        sourceSpace,
        "fresh-runtime persisted factory values",
        undefined,
        tx,
      );
      cell.set(values);
      coldWriter.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await coldWriter.patternManager.flushCompileCacheWrites();
      await writerStorage.synced();

      // End the writer session completely before constructing the reader. The
      // only remaining bridge is the shared server's persisted memory.
      await coldWriter.dispose();
      coldWriter = undefined;
      await writerStorage.close();
      writerStorage = undefined;

      readerStorage = SharedServerStorageManager.connectTo(server, {
        as: signer,
      });
      reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: readerStorage,
      });
      for (let index = 0; index < SYMBOLS.length; index++) {
        expect(
          reader.patternManager.artifactFromIdentitySync(
            identity!,
            SYMBOLS[index],
          ),
        ).toBeUndefined();
      }

      const stored = reader.getCell<PersistedFactoryValues>(
        sourceSpace,
        "fresh-runtime persisted factory values",
      );
      await stored.sync();
      const decoded = stored.getRaw() as unknown as PersistedFactoryValues;
      const shells = [
        decoded.pattern,
        decoded.module,
        decoded.handler,
      ] as const satisfies FactoryTuple;
      for (let index = 0; index < shells.length; index++) {
        expect(isAdmittedFabricFactory(shells[index])).toBe(true);
        expect(factoryStateOf(shells[index])).toEqual(states[index]);
        expect(() => shells[index](undefined as never)).toThrow(
          "factory requires runner materialization",
        );
      }

      // Trusted provenance comes from the containing cell, never Factory@1
      // state. This is the exact space the cold artifact loader must query.
      const artifactSpace = stored.getAsNormalizedFullLink().space;
      expect(artifactSpace).toBe(sourceSpace);
      const loads: Array<{
        identity: string;
        symbol: string;
        sourceSpace: MemorySpace;
      }> = [];
      const loadArtifact = reader.patternManager.loadArtifactByIdentity.bind(
        reader.patternManager,
      );
      reader.patternManager.loadArtifactByIdentity = (
        loadedIdentity,
        symbol,
        loadedSourceSpace,
      ) => {
        loads.push({
          identity: loadedIdentity,
          symbol,
          sourceSpace: loadedSourceSpace,
        });
        return loadArtifact(loadedIdentity, symbol, loadedSourceSpace);
      };

      const materialized: MaterializedFactory[] = [];
      for (let index = 0; index < shells.length; index++) {
        const factory = await prepareFactory(shells[index], {
          runtime: reader,
          artifactSpace,
        });
        expect(sealFactoryState(factory)).toEqual(states[index]);
        invokeOne(reader, index, factory, sourceSpace);
        materialized.push(factory);
      }
      expect(loads.length).toBeGreaterThan(0);
      expect(loads.every((load) => load.sourceSpace === sourceSpace)).toBe(
        true,
      );
      expect(loads.every((load) => load.identity === identity)).toBe(true);
      expect(materialized).toHaveLength(3);
    } finally {
      await reader?.dispose();
      await readerStorage?.close();
      await coldWriter?.dispose();
      await writerStorage?.close();
      await server.close();
    }
  });
});

function invokeOne(
  runtime: Runtime,
  index: number,
  factory: MaterializedFactory,
  space: MemorySpace,
): void {
  const frame = pushFrame({
    space,
    generatedIdCounter: 0,
    reactives: new Set(),
    runtime,
  });
  try {
    const inputs = [{ value: 1 }, 1, { prefix: "x" }] as const;
    expect(() => factory(inputs[index] as never)).not.toThrow();
  } finally {
    popFrame(frame);
  }
}
