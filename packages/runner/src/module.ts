import { createNodeFactory } from "./builder/module.ts";
import {
  type JSONSchema,
  Module,
  type ModuleFactory,
} from "./builder/types.ts";
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
 * - resumeMode "always-run": never rehydrate this action clean on resume.
 *   Declared by builtins whose run STARTS child runs (map/filter/flatMap):
 *   their durable outputs may validate, but the live side effect —
 *   instantiating the per-element children — only re-establishes by running,
 *   so a clean skip would strand the children unregistered. The children
 *   themselves rehydrate per piece doc
 *   (docs/specs/scheduler-v2/per-doc-rehydration.md §3.3).
 */
export interface RawBuiltinResult {
  action: Action;
  isEffect?: boolean;
  dependencies?: ReactivityLog;
  useDeclaredReadsAsDependencies?: boolean;
  debounce?: number;
  noDebounce?: boolean;
  throttle?: number;
  resumeMode?: "always-run";
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
  /**
   * Optional argument schema for the raw module's inputs. Threaded into input
   * binding resolution so the emitted links carry per-key schema annotations
   * (e.g. an `asCell: ["opaque"]` marker on a forwarded reference), which the
   * scheduler uses to decide whether an input is a declared read.
   */
  argumentSchema?: JSONSchema;
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
    // Whether this node is resuming from synced storage and should defer its
    // initial run until sync completes. Passed out-of-band (like `outputBinding`
    // above) rather than folded into `cause`: it is transient (present only on
    // resume), so hashing it into the result-cell id would diverge a fresh
    // runtime from a resumed one for the same logical node. Container-minting
    // builtins (map/filter/flatMap) read it to defer their per-element
    // sub-pattern runs until sync completes too.
    awaitSync?: boolean,
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
    ...(options?.argumentSchema !== undefined
      ? { argumentSchema: options.argumentSchema }
      : {}),
  });
}
