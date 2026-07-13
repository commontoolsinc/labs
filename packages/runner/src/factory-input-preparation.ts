import type { JSONSchema } from "@commonfabric/api";
import { isAdmittedFabricFactory } from "@commonfabric/data-model/fabric-factory";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";

import type { Cell } from "./builder/types.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { factoryContractFromSchema } from "./factory-contract.ts";
import {
  FactoryArtifactUnavailableError,
  type FactoryMaterializationContext,
  materializeFactory,
  prepareFactory,
} from "./factory-materialization.ts";
import { resolveLink } from "./link-resolution.ts";
import { isSigilLink } from "./link-utils.ts";
import type { Runtime } from "./runtime.ts";
import { RetryWhenReady } from "./scheduler/retry-when-ready.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import { canBranchMatch } from "./traverse.ts";

export interface FactoryInputPreparationContext {
  readonly runtime: Runtime;
  readonly tx: IExtendedStorageTransaction;
  /** The exact cell whose schema read produced `value`. */
  readonly inputsCell: Cell<unknown>;
}

const MAX_FACTORY_READINESS_ATTEMPTS = 3;
const FACTORY_READINESS_BACKOFF_MS = [5, 20] as const;

function inputLinkAtPath(root: Cell<unknown>, path: readonly string[]) {
  const rootLink = root.getAsNormalizedFullLink();
  return { ...rootLink, path: [...rootLink.path, ...path] };
}

function retryReadinessOf(
  error: unknown,
): (() => Promise<unknown>) | undefined {
  const readyToRetry = (error as { readyToRetry?: unknown } | null)
    ?.readyToRetry;
  return typeof readyToRetry === "function"
    ? () => Promise.resolve(readyToRetry.call(error))
    : undefined;
}

async function waitForFactoryReadiness(
  value: unknown,
  context: FactoryMaterializationContext,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_FACTORY_READINESS_ATTEMPTS; attempt++) {
    try {
      await prepareFactory(value, context);
      return;
    } catch (error) {
      const readyToRetry = retryReadinessOf(error);
      if (
        readyToRetry === undefined ||
        attempt + 1 >= MAX_FACTORY_READINESS_ATTEMPTS
      ) {
        throw error;
      }
      // Readiness retry is runner-owned and independent from authored action
      // or event retry settings. Await the source's explicit retry gate, then
      // apply a small capped backoff so a repeatedly unavailable artifact
      // cannot busy-loop the scheduler.
      await readyToRetry();
      await new Promise<void>((resolve) =>
        setTimeout(
          resolve,
          FACTORY_READINESS_BACKOFF_MS[
            Math.min(attempt, FACTORY_READINESS_BACKOFF_MS.length - 1)
          ],
        )
      );
    }
  }
}

/**
 * Clone one argument container without evaluating unrelated property values.
 * Only schema-selected children are subsequently read/replaced.
 */
function shallowDescriptorClone<T extends object>(value: T): T {
  const clone = Array.isArray(value)
    ? new Array(value.length)
    : Object.create(Object.getPrototypeOf(value));
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    Object.defineProperty(clone, key, {
      ...descriptor,
      ...(Object.hasOwn(descriptor, "value") ? { writable: true } : {}),
      configurable: true,
    });
  }
  return clone as T;
}

function replaceChild(
  original: Record<string, unknown> | unknown[],
  currentResult: Record<string, unknown> | unknown[],
  key: string,
  value: unknown,
): Record<string, unknown> | unknown[] {
  const result = currentResult === original
    ? shallowDescriptorClone(original)
    : currentResult;
  const descriptor = Object.getOwnPropertyDescriptor(result, key);
  Object.defineProperty(result, key, {
    value,
    enumerable: descriptor?.enumerable ?? true,
    writable: true,
    configurable: true,
  });
  return result;
}

/**
 * Resolve only local refs that belong to the scheduled input's own schema.
 * Factory discovery is auxiliary and must not ask the CFC resolver to interpret
 * unrelated embedded schemas against the wrong outer `$defs` root.
 */
function resolveFactoryDiscoverySchema(
  candidate: JSONSchema | undefined,
  root: JSONSchema | undefined,
): JSONSchema | undefined {
  let current = candidate;
  const seen = new Set<string>();
  while (
    isRecord(current) && typeof current.$ref === "string" &&
    !("asFactory" in current) && root !== undefined
  ) {
    const ref = current.$ref;
    if (seen.has(ref)) return current;
    seen.add(ref);
    const target = resolveFactoryDiscoveryRef(ref, root);
    if (target === undefined) return current;
    const { $ref: _, ...siblings } = current;
    if (target === false) return false;
    if (target === true) {
      current = Object.keys(siblings).length === 0 ? true : siblings;
      continue;
    }
    current = {
      ...target,
      ...siblings,
      ...(isRecord(root) && target.$defs === undefined &&
          root.$defs !== undefined
        ? { $defs: root.$defs }
        : {}),
      ...(isRecord(root) && target.definitions === undefined &&
          root.definitions !== undefined
        ? { definitions: root.definitions }
        : {}),
    };
  }
  return current;
}

function resolveFactoryDiscoveryRef(
  ref: string,
  root: JSONSchema,
): JSONSchema | undefined {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;

  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(2));
  } catch {
    return undefined;
  }

  let target: unknown = root;
  for (const encoded of pointer.split("/")) {
    if (/~(?:[^01]|$)/.test(encoded)) return undefined;
    if (!isRecord(target)) return undefined;
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.hasOwn(target, key)) return undefined;
    target = target[key];
  }
  return typeof target === "boolean" || isRecord(target)
    ? target as JSONSchema
    : undefined;
}

/**
 * Strengthen the shared conservative branch precheck only for discriminator
 * values that are already concrete. The general traverser deliberately ignores
 * const/enum because a link may resolve later; scheduled callback inputs have
 * already been read, so a non-link discriminator can safely exclude a branch
 * before its factory contract is enforced.
 */
function canFactoryBranchMatch(
  branch: JSONSchema,
  value: unknown,
): boolean {
  if (!canBranchMatch(branch, value)) return false;
  if (!isRecord(branch) || isSigilLink(value)) return true;

  if ("const" in branch && !deepEqual(branch.const, value)) return false;
  if (
    Array.isArray(branch.enum) &&
    !branch.enum.some((candidate) => deepEqual(candidate, value))
  ) {
    return false;
  }

  if (isRecord(value) && isRecord(branch.properties)) {
    for (const [key, childSchema] of Object.entries(branch.properties)) {
      if (
        key in value &&
        !canFactoryBranchMatch(childSchema, value[key])
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Replace only schema-declared `asFactory` leaves with warm executable
 * factories immediately before a lift/handler callback runs.
 *
 * The ordinary schema read remains authoritative for validation, reactivity,
 * and CFC provenance. This pass uses the same input cell and transaction only
 * to resolve each selected leaf's trusted source space. It deliberately does
 * not inspect opaque or undeclared values. A cold leaf becomes a
 * `RetryWhenReady` scheduler signal; the callback is retried only after the
 * runner has warmed the trusted artifact source.
 */
export function materializeScheduledFactoryInputs(
  value: unknown,
  schema: JSONSchema | undefined,
  context: FactoryInputPreparationContext,
): unknown {
  // Defer starting cold loads until the entire schema walk has completed.
  // A later leaf may fail terminally (wrong kind/schema); in that case no
  // earlier load should escape unobserved or do needless work.
  const readiness: Array<() => Promise<void>> = [];
  const fullSchema = schema;
  const resolvedSchemaMemo = new WeakMap<object, JSONSchema | undefined>();
  const resolvedSchemaFor = (
    candidate: JSONSchema | undefined,
  ): JSONSchema | undefined => {
    if (!isRecord(candidate)) {
      return resolveFactoryDiscoverySchema(candidate, fullSchema);
    }
    if (resolvedSchemaMemo.has(candidate)) {
      return resolvedSchemaMemo.get(candidate);
    }
    const resolved = resolveFactoryDiscoverySchema(candidate, fullSchema);
    resolvedSchemaMemo.set(candidate, resolved);
    return resolved;
  };
  const factorySchemaMemo = new WeakMap<object, boolean>();
  const schemaContainsFactory = (
    candidate: JSONSchema | undefined,
  ): boolean => {
    const resolved = resolvedSchemaFor(candidate);
    if (!isRecord(resolved)) return false;
    const cached = factorySchemaMemo.get(resolved);
    if (cached !== undefined) return cached;
    // Break recursive `$ref` cycles conservatively. Direct factory markers are
    // checked before descending, and every non-recursive branch is still seen.
    factorySchemaMemo.set(resolved, false);
    if ("asFactory" in resolved) {
      factorySchemaMemo.set(resolved, true);
      return true;
    }
    const contains = (isRecord(resolved.properties) &&
      Object.values(resolved.properties).some(schemaContainsFactory)) ||
      schemaContainsFactory(resolved.items) ||
      (Array.isArray(resolved.prefixItems) &&
        resolved.prefixItems.some(schemaContainsFactory)) ||
      schemaContainsFactory(resolved.additionalProperties) ||
      (["allOf", "anyOf", "oneOf"] as const).some((compound) =>
        Array.isArray(resolved[compound]) &&
        resolved[compound].some(schemaContainsFactory)
      );
    factorySchemaMemo.set(resolved, contains);
    return contains;
  };

  const visit = (
    currentValue: unknown,
    currentSchema: JSONSchema | undefined,
    path: readonly string[],
  ): unknown => {
    const resolvedSchema = resolvedSchemaFor(currentSchema);
    if (!isRecord(resolvedSchema)) return currentValue;

    // An explicit Cell<Factory> remains a Cell. Its contents are read under
    // ordinary Cell semantics by authored code; this preparation pass only
    // replaces by-value factory leaves delivered to the callback.
    if (ContextualFlowControl.getAsCellValues(resolvedSchema).length > 0) {
      return currentValue;
    }

    const expected = factoryContractFromSchema(resolvedSchema);
    if (expected !== undefined) {
      if (currentValue === undefined) return currentValue;
      const resolvedInput = resolveLink(
        context.runtime,
        context.tx,
        inputLinkAtPath(context.inputsCell, path),
      );
      const materializationContext = {
        runtime: context.runtime,
        artifactSpace: resolvedInput.space,
        expected,
      } satisfies FactoryMaterializationContext;
      try {
        return materializeFactory(currentValue, materializationContext);
      } catch (error) {
        if (!(error instanceof FactoryArtifactUnavailableError)) throw error;
        readiness.push(() =>
          waitForFactoryReadiness(currentValue, materializationContext)
        );
        return currentValue;
      }
    }

    let result = currentValue;
    if (isRecord(currentValue) && isRecord(resolvedSchema.properties)) {
      const container = currentValue as Record<string, unknown>;
      for (
        const [key, childSchema] of Object.entries(
          resolvedSchema.properties,
        )
      ) {
        if (!schemaContainsFactory(childSchema)) continue;
        const child = container[key];
        const prepared = visit(
          child,
          childSchema as JSONSchema,
          [...path, key],
        );
        if (!Object.is(prepared, child)) {
          result = replaceChild(
            currentValue as Record<string, unknown>,
            result as Record<string, unknown>,
            key,
            prepared,
          );
        }
      }
    }

    if (Array.isArray(currentValue)) {
      const prefixItems = Array.isArray(resolvedSchema.prefixItems)
        ? resolvedSchema.prefixItems
        : [];
      for (let index = 0; index < currentValue.length; index++) {
        if (!(index in currentValue)) continue;
        const itemSchema = prefixItems[index] ?? resolvedSchema.items;
        if (!schemaContainsFactory(itemSchema)) continue;
        const child = currentValue[index];
        const prepared = visit(
          child,
          itemSchema,
          [...path, String(index)],
        );
        if (!Object.is(prepared, child)) {
          result = replaceChild(
            currentValue,
            result as unknown[],
            String(index),
            prepared,
          );
        }
      }
    }

    if (
      isRecord(currentValue) &&
      schemaContainsFactory(resolvedSchema.additionalProperties)
    ) {
      const declared = isRecord(resolvedSchema.properties)
        ? new Set(Object.keys(resolvedSchema.properties))
        : undefined;
      for (const key of Object.keys(currentValue)) {
        if (declared?.has(key)) continue;
        const child = currentValue[key];
        const prepared = visit(
          child,
          resolvedSchema.additionalProperties,
          [...path, key],
        );
        if (!Object.is(prepared, child)) {
          result = replaceChild(
            currentValue,
            result as Record<string, unknown>,
            key,
            prepared,
          );
        }
      }
    }

    for (const compound of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = resolvedSchema[compound];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (!schemaContainsFactory(branch)) continue;
        const resolvedBranch = resolvedSchemaFor(branch);
        if (
          compound !== "allOf" && resolvedBranch !== undefined &&
          !canFactoryBranchMatch(resolvedBranch, result)
        ) {
          continue;
        }
        if (
          compound !== "allOf" && isRecord(resolvedBranch) &&
          "asFactory" in resolvedBranch &&
          !isAdmittedFabricFactory(result)
        ) {
          // `asFactory` is a leaf alternative, not permission to inspect or
          // reject the ordinary value selected by a sibling union branch.
          continue;
        }
        result = visit(result, branch, path);
      }
    }
    return result;
  };

  const prepared = visit(value, schema, []);
  if (readiness.length > 0) {
    throw new RetryWhenReady(
      Promise.all(readiness.map((start) => start())),
      "Factory inputs are waiting for artifact readiness",
    );
  }
  return prepared;
}
