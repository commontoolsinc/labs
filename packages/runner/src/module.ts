import { createNodeFactory } from "./builder/module.ts";
import { Module, type ModuleFactory } from "./builder/types.ts";
import type { Cell } from "./cell.ts";
import type { Action, ReactivityLog } from "./scheduler.ts";
import type { AddCancel } from "./cancel.ts";
import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import type { NormalizedFullLink } from "./link-types.ts";

/**
 * Result returned by a raw builtin implementation.
 *
 * - action: The action to be scheduled
 * - isEffect: If true, this action is side-effectful (optional, can also be passed via RawModuleOptions)
 * - dependencies: Optional static scheduler dependencies for first-run demand/ordering.
 * - useDeclaredReadsAsDependencies: Register binding links as static read evidence.
 * - debounce/throttle/noDebounce: Optional scheduler timing controls.
 */
export interface RawBuiltinResult {
  action: Action;
  isEffect?: boolean;
  dependencies?: ReactivityLog;
  useDeclaredReadsAsDependencies?: boolean;
  debounce?: number;
  noDebounce?: boolean;
  throttle?: number;
}

/**
 * A raw builtin implementation can return either:
 * - Just an Action (legacy format, for backwards compatibility)
 * - A RawBuiltinResult object with action, optional isEffect, and scheduler timing options
 */
export type RawBuiltinReturnType = Action | RawBuiltinResult;

/**
 * Type guard to check if a builtin result is the new object format
 */
export function isRawBuiltinResult(
  result: RawBuiltinReturnType,
): result is RawBuiltinResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "action" in result &&
    typeof result.action === "function"
  );
}

export class ModuleRegistry {
  private moduleMap = new Map<string, Module>();
  readonly runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  addModuleByRef(ref: string, module: Module): void {
    const target = Object.isExtensible(module)
      ? module
      : cloneModuleRecord(module);
    Object.defineProperty(target, "debugName", {
      value: ref,
      configurable: true,
    });
    this.moduleMap.set(ref, target);
  }

  getModule(ref: string): Module {
    if (typeof ref !== "string") throw new Error(`Unknown module ref: ${ref}`);
    const module = this.moduleMap.get(ref);
    if (!module) throw new Error(`Unknown module ref: ${ref}`);
    return module;
  }

  clear(): void {
    this.moduleMap.clear();
  }
}

function cloneModuleRecord(module: Module): Module {
  const clone: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(module as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(module as object, key);
    if (!descriptor) {
      continue;
    }
    Object.defineProperty(clone, key, descriptor);
  }
  return clone as unknown as Module;
}

export interface RawModuleOptions {
  /** If true, this module is an effect (side-effectful) rather than a computation */
  isEffect?: boolean;
  /** Optional scheduler debounce delay in milliseconds */
  debounce?: number;
  /** Opt out of scheduler auto-debounce */
  noDebounce?: boolean;
  /** Optional scheduler throttle period in milliseconds */
  throttle?: number;
}

// This corresponds to the node factory factories in common-builder:module.ts.
// But it's here, because the signature depends on implementation details of the
// runner, and won't work with any other runners.
export function raw<T, R>(
  implementation: (
    inputsCell: Cell<T>,
    sendResult: (tx: IExtendedStorageTransaction, result: R) => void,
    addCancel: AddCancel,
    cause: any,
    parentCell: Cell<any>,
    runtime: Runtime,
    // Fully-resolved normalized link of the output spot this node writes
    // through (a write redirect at the top, always present for a real node).
    // Carries the binding's declared `scope` (folded from the result schema /
    // `.asScope()` default) and `schema`, so a builtin can mint its result
    // container at the author-declared scope. Replaces the scope-less
    // `cause.outputSpot` for scope-aware builtins; `cause.outputSpot` stays for
    // identity (it is hashed into result-cell causes and must not churn).
    outputBinding?: NormalizedFullLink,
  ) => RawBuiltinReturnType,
  options?: RawModuleOptions,
): ModuleFactory<T, R> {
  return createNodeFactory({
    type: "raw",
    implementation,
    isEffect: options?.isEffect,
    debounce: options?.debounce,
    noDebounce: options?.noDebounce,
    throttle: options?.throttle,
  });
}
