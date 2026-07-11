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

import type {
  HandlerFactory,
  ModuleFactory,
  PatternFactory,
} from "../src/builder/types.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { convertCellsToLinks } from "../src/cell.ts";
import {
  type MaterializedFactory,
  materializeFactory,
  prepareFactory,
} from "../src/factory-materialization.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

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
