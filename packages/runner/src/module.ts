import { createNodeFactory } from "./builder/module.ts";
import { Module, type ModuleFactory } from "./builder/types.ts";
import type { Cell } from "./cell.ts";
import type {
  Action,
  PopulateDependencies,
  ReactivityLog,
} from "./scheduler.ts";
import type { AddCancel } from "./cancel.ts";
import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

/**
 * Result returned by a raw builtin implementation.
 *
 * - action: The action to be scheduled
 * - isEffect: If true, this action is side-effectful (optional, can also be passed via RawModuleOptions)
 * - populateDependencies: Customizes what cells this action depends on for its initial run.
 *   If not provided, dependencies are automatically discovered from input bindings.
 *   Can be a ReactivityLog (static) or a PopulateDependencies function (dynamic).
 */
export interface RawBuiltinResult {
  action: Action;
  isEffect?: boolean;
  populateDependencies?: PopulateDependencies | ReactivityLog;
}

/**
 * A raw builtin implementation can return either:
 * - Just an Action (legacy format, for backwards compatibility)
 * - A RawBuiltinResult object with action, optional isEffect, and optional populateDependencies
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
    this.moduleMap.set(ref, module);
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

export interface RawModuleOptions {
  /** If true, this module is an effect (side-effectful) rather than a computation */
  isEffect?: boolean;
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
  ) => RawBuiltinReturnType,
  options?: RawModuleOptions,
): ModuleFactory<T, R> {
  return createNodeFactory({
    type: "raw",
    implementation,
    isEffect: options?.isEffect,
  });
}
