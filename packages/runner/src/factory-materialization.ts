import type { CellScope, JSONSchema } from "@commonfabric/api";
import {
  factoryStateOf,
  type FactoryStateV1,
  type FactoryStateView,
  isAdmittedFabricFactory,
  sealFactoryState,
  tryFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { factorySchemasEqual } from "@commonfabric/data-model/schema-utils";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import { isTrustedBuilderArtifact } from "./builder/pattern-metadata.ts";
import type {
  HandlerFactory,
  Module,
  ModuleFactory,
  PatternFactory,
} from "./builder/types.ts";
import type { Runtime } from "./runtime.ts";
import type { MemorySpace } from "./storage/interface.ts";
import {
  type FactoryContract,
  factoryContractFromSchema,
} from "./factory-contract.ts";

export type { FactoryContract } from "./factory-contract.ts";

/**
 * The owning consumer's state at the instant an async preparation starts.
 * Every callback is reread after the awaited artifact load.
 */
export interface FactoryMaterializationFence {
  readonly owner: object;
  readonly generation: number;
  readonly currentOwner: () => object | undefined;
  readonly currentGeneration: () => number | undefined;
  readonly currentSelection: () => unknown;
}

export interface FactoryMaterializationContext {
  readonly runtime: Runtime;
  /** Trusted source-space provenance. Never read from Factory@1 state. */
  readonly artifactSpace: MemorySpace;
  readonly expected?: FactoryContract;
  readonly fence?: FactoryMaterializationFence;
}

export type MaterializedFactory =
  | PatternFactory<unknown, unknown>
  | ModuleFactory<unknown, unknown>
  | HandlerFactory<unknown, unknown>;

type FactoryRef = FactoryStateV1["ref"];

/** A well-formed factory whose trusted artifact is not available locally yet. */
export class FactoryArtifactUnavailableError extends Error {
  constructor(readonly ref: FactoryRef) {
    super(`Factory materialization could not resolve ${refLabel(ref)}`);
    this.name = "FactoryArtifactUnavailableError";
  }
}

interface InspectedFactory {
  readonly value: MaterializedFactory;
  readonly state: FactoryStateView;
  readonly trusted: boolean;
}

interface TrustedFactory {
  readonly value: MaterializedFactory;
  readonly state: FactoryStateView;
  readonly contract: FactoryContract;
}

function refLabel(ref: FactoryRef): string {
  return `${ref.identity}#${ref.symbol}`;
}

function inspectFactory(value: unknown): InspectedFactory {
  if (!isAdmittedFabricFactory(value)) {
    throw new TypeError(
      "Factory materialization requires an admitted FabricFactory",
    );
  }
  return {
    value: value as MaterializedFactory,
    state: factoryStateOf(value),
    trusted: isTrustedBuilderArtifact(value),
  };
}

function requireRef(state: FactoryStateView): FactoryRef {
  if (!("ref" in state) || state.ref === undefined) {
    throw new Error(
      "Factory materialization requires a content-addressed ref",
    );
  }
  return state.ref;
}

function schemaLightByRefName(
  factory: MaterializedFactory,
  state: FactoryStateView,
): string | undefined {
  if (state.kind !== "module") return undefined;
  const module = factory as unknown as Module;
  return module.type === "ref" && typeof module.implementation === "string" &&
      (state.argumentSchema === undefined || state.resultSchema === undefined)
    ? module.implementation
    : undefined;
}

function contractForTrustedFactory(
  factory: MaterializedFactory,
  state: FactoryStateView,
  runtime: Runtime,
): FactoryContract {
  switch (state.kind) {
    case "pattern":
      return {
        kind: "pattern",
        argumentSchema: state.argumentSchema,
        resultSchema: state.resultSchema,
      };
    case "handler":
      return {
        kind: "handler",
        contextSchema: state.contextSchema,
        eventSchema: state.eventSchema,
      };
    case "module": {
      const byRefName = schemaLightByRefName(factory, state);
      if (byRefName === undefined) {
        return {
          kind: "module",
          argumentSchema: state.argumentSchema,
          resultSchema: state.resultSchema,
        };
      }
      let registered: Module;
      try {
        registered = runtime.moduleRegistry.getModule(byRefName);
      } catch {
        throw new Error(
          `Factory materialization has no trusted ModuleRegistry metadata for ${byRefName}`,
        );
      }
      return {
        kind: "module",
        argumentSchema: registered.argumentSchema,
        resultSchema: registered.resultSchema,
      };
    }
  }
}

function schemaFields(kind: FactoryContract["kind"]): readonly string[] {
  switch (kind) {
    case "pattern":
    case "module":
      return ["argumentSchema", "resultSchema"];
    case "handler":
      return ["contextSchema", "eventSchema"];
  }
}

function schemaAt(
  value: FactoryContract | FactoryStateView,
  field: string,
): JSONSchema | undefined {
  return (value as unknown as Record<string, JSONSchema | undefined>)[field];
}

function assertExpectedContract(
  actual: FactoryContract,
  expected: FactoryContract | undefined,
): void {
  if (expected === undefined) return;
  if (actual.kind !== expected.kind) {
    throw new Error(
      `Factory materialization kind mismatch: expected ${expected.kind}, got ${actual.kind}`,
    );
  }
  for (const field of schemaFields(actual.kind)) {
    if (
      !factorySchemasEqual(schemaAt(actual, field), schemaAt(expected, field))
    ) {
      throw new Error(
        `Factory materialization schema mismatch: expected ${actual.kind} ${field}`,
      );
    }
  }
}

function assertCarriedSchemas(
  carried: FactoryStateV1,
  trustedState: FactoryStateView,
  trustedContract: FactoryContract,
  schemaLightByRef: boolean,
): void {
  for (const field of schemaFields(carried.kind)) {
    const carriedSchema = schemaAt(carried, field);
    const trustedSchema = schemaAt(
      schemaLightByRef ? trustedContract : trustedState,
      field,
    );
    // A genuine schema-light byRef state omits schemas. If wire state carries a
    // hint, it may only be checked against (never substituted for) registry
    // metadata; final canonical-state equality rejects the forged addition.
    if (
      schemaLightByRef && carriedSchema === undefined ||
      factorySchemasEqual(carriedSchema, trustedSchema)
    ) {
      continue;
    }
    throw new Error(
      `Factory materialization schema mismatch: ${carried.kind} ${field}`,
    );
  }
}

function inspectTrustedFactory(
  value: unknown,
  runtime: Runtime,
  carried?: FactoryStateV1,
): TrustedFactory {
  if (
    typeof value !== "function" || !isAdmittedFabricFactory(value) ||
    !isTrustedBuilderArtifact(value)
  ) {
    const suffix = carried === undefined ? "" : ` for ${refLabel(carried.ref)}`;
    throw new Error(
      `Factory materialization resolved an untrusted artifact${suffix}`,
    );
  }
  const factory = value as MaterializedFactory;
  const state = factoryStateOf(factory);
  if (carried !== undefined && state.kind !== carried.kind) {
    throw new Error(
      `Factory materialization kind mismatch: expected ${carried.kind}, got ${state.kind}`,
    );
  }
  const contract = contractForTrustedFactory(factory, state, runtime);
  if (carried !== undefined) {
    const schemaLight = schemaLightByRefName(factory, state) !== undefined;
    assertCarriedSchemas(carried, state, contract, schemaLight);
    if (
      !("ref" in state) || state.ref === undefined ||
      !deepEqual(state.ref, carried.ref)
    ) {
      throw new Error(
        `Factory materialization forged artifact metadata for ${
          refLabel(carried.ref)
        }`,
      );
    }
  }
  return { value: factory, state, contract };
}

function assertDecodedPatternHasNoParams(state: FactoryStateV1): void {
  if (
    state.kind === "pattern" &&
    (Object.hasOwn(state, "paramsSchema") || Object.hasOwn(state, "params"))
  ) {
    throw new Error(
      "Factory materialization does not support pattern params yet",
    );
  }
}

function applyModifiers(
  base: MaterializedFactory,
  state: FactoryStateV1,
): MaterializedFactory {
  let materialized = base;
  if (state.kind === "pattern") {
    const patternFactory = materialized as PatternFactory<unknown, unknown>;
    if (state.defaultScope !== undefined) {
      materialized = patternFactory.asScope(state.defaultScope);
    }
    if (Object.hasOwn(state, "spaceSelector")) {
      materialized = (materialized as PatternFactory<unknown, unknown>).inSpace(
        state.spaceSelector as never,
      );
    }
  } else if (state.kind === "module" && state.defaultScope !== undefined) {
    materialized = (materialized as ModuleFactory<unknown, unknown>).asScope(
      state.defaultScope as CellScope,
    );
  }
  return materialized;
}

function materializeResolved(
  resolved: unknown,
  carried: FactoryStateV1,
  context: FactoryMaterializationContext,
): MaterializedFactory {
  const trusted = inspectTrustedFactory(resolved, context.runtime, carried);
  assertExpectedContract(trusted.contract, context.expected);
  const materialized = applyModifiers(trusted.value, carried);
  let resultingState: FactoryStateV1;
  try {
    resultingState = sealFactoryState(materialized);
  } catch {
    throw new Error(
      `Factory materialization could not preserve canonical state for ${
        refLabel(carried.ref)
      }`,
    );
  }
  if (!deepEqual(resultingState, carried)) {
    throw new Error(
      `Factory materialization forged artifact metadata for ${
        refLabel(carried.ref)
      }`,
    );
  }
  return materialized;
}

function sameSelection(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    if (
      tryFactoryState(left) === undefined ||
      tryFactoryState(right) === undefined
    ) {
      return false;
    }
    // Compare the sealed wire state. Live builder views also carry an opaque
    // root token, whose object identity is intentionally process-local and is
    // not part of a factory selection's canonical equality.
    return deepEqual(sealFactoryState(left), sealFactoryState(right));
  } catch {
    return false;
  }
}

function assertCurrentAfterAwait(
  originalSelection: unknown,
  fence: FactoryMaterializationFence | undefined,
): void {
  if (fence === undefined) return;
  // Read all three after the await even when the first fact is stale. In
  // particular, currentSelection is a required post-await reactive reread.
  const owner = fence.currentOwner();
  const generation = fence.currentGeneration();
  const selection = fence.currentSelection();
  if (
    owner !== fence.owner || generation !== fence.generation ||
    !sameSelection(selection, originalSelection)
  ) {
    throw new Error("Factory materialization was superseded while loading");
  }
}

/**
 * Materialize a direct trusted factory or a decoded shell whose artifact is
 * already warm. This function never performs I/O.
 */
export function materializeFactory(
  value: unknown,
  context: FactoryMaterializationContext,
): MaterializedFactory {
  const inspected = inspectFactory(value);
  if (inspected.trusted) {
    const trusted = inspectTrustedFactory(value, context.runtime);
    assertExpectedContract(trusted.contract, context.expected);
    return trusted.value;
  }

  const ref = requireRef(inspected.state);
  const carried = inspected.state as FactoryStateV1;
  assertDecodedPatternHasNoParams(carried);
  const resolved = context.runtime.patternManager.isArtifactAvailableInSpace(
      ref.identity,
      context.artifactSpace,
    )
    ? context.runtime.patternManager.artifactFromIdentitySync(
      ref.identity,
      ref.symbol,
    )
    : undefined;
  if (resolved === undefined) {
    throw new FactoryArtifactUnavailableError(ref);
  }
  return materializeResolved(resolved, carried, context);
}

/**
 * Warm-only runner exposure for one schema-declared factory leaf.
 *
 * This is used by synchronous Cell/query delivery. It returns ordinary values
 * unchanged, returns a live callable when the trusted artifact is warm, and
 * throws {@link FactoryArtifactUnavailableError} rather than leaking an inert
 * shell when the artifact is cold.
 */
export function materializeFactoryForSchema(
  value: unknown,
  schema: JSONSchema | undefined,
  context: Omit<FactoryMaterializationContext, "expected">,
): unknown {
  const expected = factoryContractFromSchema(schema);
  if (expected === undefined || value === undefined) return value;
  return materializeFactory(value, { ...context, expected });
}

/**
 * Async-ready materialization. A cold load may warm PatternManager's cache,
 * but owner/generation/selection are reread before any live factory is built.
 */
export async function prepareFactory(
  value: unknown,
  context: FactoryMaterializationContext,
): Promise<MaterializedFactory> {
  const inspected = inspectFactory(value);
  if (inspected.trusted) {
    const trusted = inspectTrustedFactory(value, context.runtime);
    assertExpectedContract(trusted.contract, context.expected);
    return trusted.value;
  }

  const ref = requireRef(inspected.state);
  const carried = inspected.state as FactoryStateV1;
  assertDecodedPatternHasNoParams(carried);
  const warm = context.runtime.patternManager.isArtifactAvailableInSpace(
      ref.identity,
      context.artifactSpace,
    )
    ? context.runtime.patternManager.artifactFromIdentitySync(
      ref.identity,
      ref.symbol,
    )
    : undefined;
  if (warm !== undefined) return materializeResolved(warm, carried, context);

  const loaded = await context.runtime.patternManager.loadArtifactByIdentity(
    ref.identity,
    ref.symbol,
    context.artifactSpace,
  );
  assertCurrentAfterAwait(value, context.fence);
  if (loaded === undefined) {
    throw new FactoryArtifactUnavailableError(ref);
  }
  return materializeResolved(loaded, carried, context);
}
