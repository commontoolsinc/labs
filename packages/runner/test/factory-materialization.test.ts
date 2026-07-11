import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  createFactoryShell,
  type FactoryStateV1,
  registerFabricFactory,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";

import type { JSONSchema } from "../src/builder/types.ts";
import { byRef, handler, lift } from "../src/builder/module.ts";
import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import type { Frame } from "../src/builder/types.ts";
import {
  type FactoryContract,
  materializeFactory,
  prepareFactory,
} from "../src/factory-materialization.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("factory-materialization-test");
const artifactSpace = signer.did();

const ARGUMENT_SCHEMA = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
} as const satisfies JSONSchema;
const RESULT_SCHEMA = {
  type: "object",
  properties: { result: { type: "number" } },
  required: ["result"],
} as const satisfies JSONSchema;
const CONTEXT_SCHEMA = {
  type: "object",
  properties: { prefix: { type: "string" } },
} as const satisfies JSONSchema;
const EVENT_SCHEMA = { type: "number" } as const satisfies JSONSchema;

const REFS = {
  pattern: { identity: "A".repeat(43), symbol: "patternFactory" },
  module: { identity: `${"B".repeat(42)}A`, symbol: "moduleFactory" },
  handler: { identity: `${"C".repeat(42)}A`, symbol: "handlerFactory" },
  other: { identity: `${"D".repeat(42)}A`, symbol: "otherFactory" },
} as const;

function key(identity: string, symbol: string): string {
  return `${identity}#${symbol}`;
}

function contractOf(state: FactoryStateV1): FactoryContract {
  switch (state.kind) {
    case "pattern":
      return {
        kind: "pattern",
        argumentSchema: state.argumentSchema,
        resultSchema: state.resultSchema,
      };
    case "module":
      return {
        kind: "module",
        argumentSchema: state.argumentSchema,
        resultSchema: state.resultSchema,
      };
    case "handler":
      return {
        kind: "handler",
        contextSchema: state.contextSchema,
        eventSchema: state.eventSchema,
      };
  }
}

describe("runner-owned factory materialization", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let frame: Frame;
  let warm: Map<string, unknown>;
  let cold: Map<string, unknown>;
  let loads: Array<{
    identity: string;
    symbol: string;
    artifactSpace: MemorySpace;
  }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    frame = pushFrame({
      space: artifactSpace,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
    warm = new Map();
    cold = new Map();
    loads = [];
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      warm.get(key(identity, symbol));
    runtime.patternManager.loadArtifactByIdentity = (
      identity,
      symbol,
      sourceSpace,
    ) => {
      loads.push({ identity, symbol, artifactSpace: sourceSpace });
      const value = cold.get(key(identity, symbol));
      if (value !== undefined) warm.set(key(identity, symbol), value);
      return Promise.resolve(value as object | undefined);
    };
  });

  afterEach(async () => {
    popFrame(frame);
    await runtime.dispose();
    await storageManager.close();
  });

  function makeFactories() {
    const basePattern = pattern(
      ({ value }: { value: number }) => ({ result: value }),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    const baseModule = lift(
      ({ value }: { value: number }) => ({ result: value + 1 }),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    const baseHandler = handler(
      EVENT_SCHEMA,
      CONTEXT_SCHEMA,
      (_event: number, _context: { prefix?: string }) => undefined,
    );
    setDurableArtifactEntryRef(basePattern, REFS.pattern);
    setDurableArtifactEntryRef(baseModule, REFS.module);
    setDurableArtifactEntryRef(baseHandler, REFS.handler);
    return {
      bases: [basePattern, baseModule, baseHandler] as const,
      carried: [
        basePattern.asScope("user").inSpace("execution-target"),
        baseModule.asScope("session"),
        baseHandler,
      ] as const,
      refs: [REFS.pattern, REFS.module, REFS.handler] as const,
      inputs: [{ value: 1 }, { value: 1 }, { prefix: "x" }] as const,
    };
  }

  it("passes direct trusted factories through only after kind/schema checks", () => {
    const { bases } = makeFactories();
    for (const base of bases) {
      const state = sealFactoryState(base);
      expect(
        materializeFactory(base, {
          runtime,
          artifactSpace,
          expected: contractOf(state),
        }),
      ).toBe(base);
    }

    expect(() =>
      materializeFactory(bases[1], {
        runtime,
        artifactSpace,
        expected: {
          kind: "pattern",
          argumentSchema: ARGUMENT_SCHEMA,
          resultSchema: RESULT_SCHEMA,
        },
      })
    ).toThrow(
      "Factory materialization kind mismatch: expected pattern, got module",
    );
  });

  it("warm-materializes all kinds, reapplies modifiers, and preserves canonical state", () => {
    const { bases, carried, refs, inputs } = makeFactories();
    for (let index = 0; index < carried.length; index++) {
      const state = sealFactoryState(carried[index]);
      warm.set(key(refs[index].identity, refs[index].symbol), bases[index]);
      const shell = createFactoryShell(state);
      const materialized = materializeFactory(shell, {
        runtime,
        artifactSpace,
        expected: contractOf(state),
      });

      expect(typeof materialized).toBe("function");
      expect(sealFactoryState(materialized)).toEqual(state);
      expect(() => materialized(inputs[index] as never)).not.toThrow();
    }
    expect(loads).toEqual([]);
  });

  it("cold-loads all kinds through PatternManager using artifactSpace", async () => {
    const { bases, carried, refs } = makeFactories();
    for (let index = 0; index < carried.length; index++) {
      const state = sealFactoryState(carried[index]);
      cold.set(key(refs[index].identity, refs[index].symbol), bases[index]);
      const materialized = await prepareFactory(createFactoryShell(state), {
        runtime,
        artifactSpace,
        expected: contractOf(state),
      });
      expect(sealFactoryState(materialized)).toEqual(state);
    }
    expect(loads).toEqual(refs.map((ref) => ({ ...ref, artifactSpace })));
    const selectedPatternState = sealFactoryState(
      await prepareFactory(createFactoryShell(sealFactoryState(carried[0])), {
        runtime,
        artifactSpace,
      }),
    );
    if (selectedPatternState.kind !== "pattern") {
      throw new Error("expected a materialized pattern");
    }
    expect(selectedPatternState.spaceSelector).toBe("execution-target");
  });

  it("uses only trusted ModuleRegistry metadata for schema-light byRef modules", () => {
    const base = byRef("trusted-module");
    setDurableArtifactEntryRef(base, REFS.module);
    runtime.moduleRegistry.addModuleByRef(
      "trusted-module",
      lift(
        ({ value }: { value: number }) => ({ result: value + 1 }),
        ARGUMENT_SCHEMA,
        RESULT_SCHEMA,
      ),
    );
    warm.set(key(REFS.module.identity, REFS.module.symbol), base);
    const state = sealFactoryState(base);
    expect(state).not.toHaveProperty("argumentSchema");
    const materialized = materializeFactory(createFactoryShell(state), {
      runtime,
      artifactSpace,
      expected: {
        kind: "module",
        argumentSchema: ARGUMENT_SCHEMA,
        resultSchema: RESULT_SCHEMA,
      },
    });
    expect(materialized).toBe(base);

    const forged = createFactoryShell({
      ...state,
      argumentSchema: { type: "string" },
      resultSchema: RESULT_SCHEMA,
    });
    expect(() => materializeFactory(forged, { runtime, artifactSpace }))
      .toThrow(
        "Factory materialization schema mismatch: module argumentSchema",
      );
  });

  it("rejects expected/carried schema mismatches", () => {
    const { bases } = makeFactories();
    warm.set(key(REFS.module.identity, REFS.module.symbol), bases[1]);
    const state = sealFactoryState(bases[1]);
    const forged = createFactoryShell({
      ...state,
      resultSchema: { type: "string" },
    });
    expect(() => materializeFactory(forged, { runtime, artifactSpace }))
      .toThrow("Factory materialization schema mismatch: module resultSchema");
    expect(() =>
      materializeFactory(bases[1], {
        runtime,
        artifactSpace,
        expected: {
          kind: "module",
          argumentSchema: ARGUMENT_SCHEMA,
          resultSchema: { type: "string" },
        },
      })
    ).toThrow(
      "Factory materialization schema mismatch: expected module resultSchema",
    );
  });

  it("fails closed for nonfactories, missing refs, wrong kinds, missing artifacts, and forged refs", async () => {
    expect(() => materializeFactory({}, { runtime, artifactSpace })).toThrow(
      "Factory materialization requires an admitted FabricFactory",
    );

    const missingRef = registerFabricFactory(
      () => undefined,
      "module",
      { kind: "module", rootToken: {} },
    );
    expect(() => materializeFactory(missingRef, { runtime, artifactSpace }))
      .toThrow("Factory materialization requires a content-addressed ref");

    const { bases } = makeFactories();
    const patternState = sealFactoryState(bases[0]);
    warm.set(key(REFS.pattern.identity, REFS.pattern.symbol), bases[1]);
    expect(() =>
      materializeFactory(createFactoryShell(patternState), {
        runtime,
        artifactSpace,
      })
    ).toThrow(
      "Factory materialization kind mismatch: expected pattern, got module",
    );

    warm.clear();
    await expect(
      prepareFactory(createFactoryShell(patternState), {
        runtime,
        artifactSpace,
      }),
    ).rejects.toThrow(
      `Factory materialization could not resolve ${REFS.pattern.identity}#${REFS.pattern.symbol}`,
    );

    setDurableArtifactEntryRef(bases[1], REFS.other);
    warm.set(key(REFS.pattern.identity, REFS.pattern.symbol), bases[1]);
    expect(() =>
      materializeFactory(
        createFactoryShell({
          ...sealFactoryState(bases[1]),
          ref: REFS.pattern,
        }),
        { runtime, artifactSpace },
      )
    ).toThrow(
      `Factory materialization forged artifact metadata for ${REFS.pattern.identity}#${REFS.pattern.symbol}`,
    );

    warm.set(key(REFS.pattern.identity, REFS.pattern.symbol), () => undefined);
    expect(() =>
      materializeFactory(createFactoryShell(patternState), {
        runtime,
        artifactSpace,
      })
    ).toThrow(
      `Factory materialization resolved an untrusted artifact for ${REFS.pattern.identity}#${REFS.pattern.symbol}`,
    );
  });

  it("rejects decoded pattern params until Stage 3", () => {
    const { bases } = makeFactories();
    const state = sealFactoryState(bases[0]);
    for (
      const shell of [
        createFactoryShell({ ...state, paramsSchema: { type: "object" } }),
        createFactoryShell({
          ...state,
          paramsSchema: { type: "object" },
          params: {},
        }),
      ]
    ) {
      expect(() => materializeFactory(shell, { runtime, artifactSpace }))
        .toThrow("Factory materialization does not support pattern params yet");
    }
  });

  it("rereads and fences a stale cold selection after the load warms cache", async () => {
    const { bases } = makeFactories();
    const stateA = sealFactoryState(bases[0]);
    setDurableArtifactEntryRef(bases[1], REFS.other);
    const stateB = sealFactoryState(bases[1]);
    const shellA = createFactoryShell(stateA);
    const shellB = createFactoryShell(stateB);
    const owner = {};
    let generation = 1;
    let selection: unknown = shellA;
    let entered!: () => void;
    const loadEntered = new Promise<void>((resolve) => entered = resolve);
    let release!: () => void;
    const loadGate = new Promise<void>((resolve) => release = resolve);
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
      sourceSpace,
    ) => {
      loads.push({ identity, symbol, artifactSpace: sourceSpace });
      entered();
      await loadGate;
      warm.set(key(identity, symbol), bases[0]);
      return bases[0];
    };

    const preparing = prepareFactory(shellA, {
      runtime,
      artifactSpace,
      fence: {
        owner,
        generation,
        currentOwner: () => owner,
        currentGeneration: () => generation,
        currentSelection: () => selection,
      },
    });
    await loadEntered;
    generation++;
    selection = shellB;
    release();

    await expect(preparing).rejects.toThrow(
      "Factory materialization was superseded while loading",
    );
    expect(
      runtime.patternManager.artifactFromIdentitySync(
        stateA.ref.identity,
        stateA.ref.symbol,
      ),
    ).toBe(bases[0]);
  });
});
