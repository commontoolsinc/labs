import {
  createNodeFactory,
  type Module,
  type ModuleFactory,
} from "@commontools/builder";
import type { Action } from "./scheduler.ts";
import type { DocImpl } from "./doc.ts";
import type { AddCancel } from "./cancel.ts";
const moduleMap = new Map<string, Module>();

export function addModuleByRef(ref: string, module: Module) {
  moduleMap.set(ref, module);
}

export function getModuleByRef(ref: string): Module {
  if (typeof ref !== "string") throw new Error(`Unknown module ref: ${ref}`);
  const module = moduleMap.get(ref);
  if (!module) throw new Error(`Unknown module ref: ${ref}`);
  return module;
}

// This corresponds to the node factory factories in common-builder:module.ts.
// But it's here, because the signature depends on implementation details of the
// runner, and won't work with any other runners.
export function raw<T, R>(
  implementation: (
    inputsCell: DocImpl<T>,
    sendResult: (result: R) => void,
    addCancel: AddCancel,
    cause: any,
    parentCell: DocImpl<any>,
  ) => Action,
): ModuleFactory<T, R> {
  return createNodeFactory({
    type: "raw",
    implementation,
  });
}
