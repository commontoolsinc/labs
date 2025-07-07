import { createNodeFactory } from "./builder/module.ts";
import {
  Module,
  type ModuleFactory,
} from "./builder/types.ts";
import type { Cell } from "./cell.ts";
import type { Action } from "./scheduler.ts";
import type { AddCancel } from "./cancel.ts";
import type { IModuleRegistry, IRuntime } from "./runtime.ts";

export class ModuleRegistry implements IModuleRegistry {
  private moduleMap = new Map<string, Module>();
  readonly runtime: IRuntime;

  constructor(runtime: IRuntime) {
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

// This corresponds to the node factory factories in common-builder:module.ts.
// But it's here, because the signature depends on implementation details of the
// runner, and won't work with any other runners.
export function raw<T, R>(
  implementation: (
    inputsCell: Cell<T>,
    sendResult: (result: R) => void,
    addCancel: AddCancel,
    cause: any,
    parentCell: Cell<any>,
    runtime: IRuntime,
  ) => Action,
): ModuleFactory<T, R> {
  return createNodeFactory({
    type: "raw",
    implementation,
  });
}
