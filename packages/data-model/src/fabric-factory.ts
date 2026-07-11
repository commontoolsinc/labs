import type { CellScope, JSONSchema } from "@commonfabric/api";

import type {
  FabricFactory,
  FabricPlainObject,
  FabricValue,
} from "./interface.ts";

/** Content-addressed reference to a builder factory artifact. */
export interface FactoryArtifactRef {
  readonly identity: string;
  readonly symbol: string;
}

interface FactoryStateBaseV1 {
  readonly ref: FactoryArtifactRef;
}

/** Canonical serialized state for a pattern factory. */
export interface PatternFactoryStateV1 extends FactoryStateBaseV1 {
  readonly kind: "pattern";
  readonly argumentSchema: JSONSchema;
  readonly resultSchema: JSONSchema;
  readonly paramsSchema?: JSONSchema;
  readonly params?: FabricPlainObject;
  readonly defaultScope?: CellScope;
  readonly spaceSelector?: FabricValue;
}

/** Canonical serialized state for a module or lift factory. */
export interface ModuleFactoryStateV1 extends FactoryStateBaseV1 {
  readonly kind: "module";
  readonly argumentSchema?: JSONSchema;
  readonly resultSchema?: JSONSchema;
  readonly defaultScope?: CellScope;
}

/** Canonical serialized state for a handler factory. */
export interface HandlerFactoryStateV1 extends FactoryStateBaseV1 {
  readonly kind: "handler";
  readonly contextSchema?: JSONSchema;
  readonly eventSchema?: JSONSchema;
}

/** Complete canonical `Factory@1` state. */
export type FactoryStateV1 =
  | PatternFactoryStateV1
  | ModuleFactoryStateV1
  | HandlerFactoryStateV1;

interface LiveFactoryStateBase {
  readonly rootToken: object;
  readonly ref?: FactoryArtifactRef;
}

/**
 * Unsealed pattern state held while builder inputs may still contain runner
 * values such as Cells and Reactives.
 */
export interface LivePatternFactoryState extends LiveFactoryStateBase {
  readonly kind: "pattern";
  readonly argumentSchema: JSONSchema;
  readonly resultSchema: JSONSchema;
  readonly paramsSchema?: JSONSchema;
  readonly params?: unknown;
  readonly defaultScope?: CellScope;
  readonly spaceSelector?: unknown;
}

/** Unsealed module state whose complete artifact ref may still be pending. */
export interface LiveModuleFactoryState extends LiveFactoryStateBase {
  readonly kind: "module";
  readonly argumentSchema?: JSONSchema;
  readonly resultSchema?: JSONSchema;
  readonly defaultScope?: CellScope;
}

/** Unsealed handler state whose complete artifact ref may still be pending. */
export interface LiveHandlerFactoryState extends LiveFactoryStateBase {
  readonly kind: "handler";
  readonly contextSchema?: JSONSchema;
  readonly eventSchema?: JSONSchema;
}

/** Internal, not-yet-canonical state for a live builder factory. */
export type LiveFactoryState =
  | LivePatternFactoryState
  | LiveModuleFactoryState
  | LiveHandlerFactoryState;

/** State visible to the runner and codec protocol. */
export type FactoryStateView = LiveFactoryState | FactoryStateV1;

type Callable = (...args: never[]) => unknown;
type FactoryStateAccessor = () => FactoryStateView;

const FABRIC_FACTORY = Symbol.for("common.fabricFactory");
const FACTORY_STATE = Symbol.for("common.factoryState");

// This table, rather than the copyable symbol properties, is the admission
// authority. It deliberately carries no runner execution-trust information.
const factoryStates = new WeakMap<Callable, FactoryStateAccessor>();

/**
 * Admit a callable created by a trusted builder constructor or the factory
 * codec. This protocol admission does not make a decoded shell executable.
 *
 * @internal
 */
export function registerFabricFactory<T extends Callable>(
  value: T,
  state: FactoryStateView | FactoryStateAccessor,
): T & FabricFactory {
  if (factoryStates.has(value)) {
    throw new TypeError("Callable is already an admitted FabricFactory");
  }
  if (!Object.isExtensible(value)) {
    throw new TypeError("FabricFactory must be admitted before hardening");
  }
  if (
    Object.hasOwn(value, FABRIC_FACTORY) || Object.hasOwn(value, FACTORY_STATE)
  ) {
    throw new TypeError(
      "Callable already has FabricFactory protocol properties",
    );
  }

  const stateAccessor = typeof state === "function" ? state : () => state;
  Object.defineProperties(value, {
    [FABRIC_FACTORY]: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    },
    [FACTORY_STATE]: {
      configurable: false,
      enumerable: false,
      value: stateAccessor,
      writable: false,
    },
  });
  factoryStates.set(value, stateAccessor);
  return value as T & FabricFactory;
}

/** Return admitted factory state, or `undefined` for every other value. */
export function tryFactoryState(value: unknown): FactoryStateView | undefined {
  if (typeof value !== "function") return undefined;
  return factoryStates.get(value as Callable)?.();
}

/** Return admitted factory state, failing closed for arbitrary callables. */
export function factoryStateOf(value: unknown): FactoryStateView {
  const state = tryFactoryState(value);
  if (state === undefined) {
    throw new TypeError("Value is not an admitted FabricFactory");
  }
  return state;
}
