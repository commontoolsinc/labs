import {
  createFactoryShell,
  factoryStateOf,
  type FactoryStateValueField,
  isAdmittedFabricFactory,
  mapFactoryStateValues,
} from "@commonfabric/data-model/fabric-factory";

import {
  deriveFactoryStateCopy,
  isTrustedBuilderArtifact,
} from "./pattern-metadata.ts";

export interface FactoryTraversalContext {
  readonly memo: WeakMap<object, unknown>;
  readonly active: WeakSet<object>;
}

export function createFactoryTraversalContext(): FactoryTraversalContext {
  return {
    memo: new WeakMap<object, unknown>(),
    active: new WeakSet<object>(),
  };
}

function factoryKey(value: unknown): object {
  if (typeof value !== "function") {
    throw new TypeError("Factory traversal requires a callable");
  }
  return value;
}

/**
 * Traverse the hidden value-bearing portion of an admitted factory and rebuild
 * the callable when any nested value changes.
 *
 * Repeated factory identities are ordinary DAG reuse and return the same mapped
 * callable. Only encountering a factory while its own hidden state is active is
 * a cycle.
 */
export function mapFactoryForTraversal<T>(
  factory: T,
  mapValue: (value: unknown, field: FactoryStateValueField) => unknown,
  context: FactoryTraversalContext,
): T {
  if (!isAdmittedFabricFactory(factory)) {
    throw new TypeError(
      "Factory traversal requires an admitted Factory@1 value",
    );
  }

  const key = factoryKey(factory);
  if (context.memo.has(key)) return context.memo.get(key) as T;
  if (context.active.has(key)) {
    throw new TypeError("Circular reference detected in factory state");
  }

  context.active.add(key);
  try {
    const state = factoryStateOf(factory);
    const mappedState = mapFactoryStateValues(state, mapValue);
    let mapped: unknown;
    if (mappedState === state) {
      mapped = factory;
    } else if (isTrustedBuilderArtifact(factory)) {
      mapped = deriveFactoryStateCopy(factory, mappedState);
    } else if ("rootToken" in state) {
      throw new Error("Untrusted live factory state cannot be reconstructed");
    } else {
      mapped = createFactoryShell(mappedState);
    }

    if (!isAdmittedFabricFactory(mapped)) {
      throw new Error("Factory state deriver returned an unadmitted callable");
    }
    const derivedState = factoryStateOf(mapped);
    if (derivedState.kind !== state.kind) {
      throw new Error("Factory state deriver changed the factory kind");
    }
    if (
      "rootToken" in state && "rootToken" in derivedState &&
      state.rootToken !== derivedState.rootToken
    ) {
      throw new Error("Factory state deriver changed the root token");
    }
    if (
      state.ref !== undefined &&
      (derivedState.ref?.identity !== state.ref.identity ||
        derivedState.ref.symbol !== state.ref.symbol)
    ) {
      throw new Error("Factory state deriver changed the artifact ref");
    }

    context.memo.set(key, mapped);
    return mapped as T;
  } finally {
    context.active.delete(key);
  }
}
