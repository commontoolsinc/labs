import {
  type Module,
  type ModuleFactory,
  createNodeFactory,
} from "@commontools/common-builder";
import { type Action } from "./scheduler.js";
import { type CellImpl } from "./cell.js";
import { type AddCancel } from "./cancel.js";
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
    inputsCell: CellImpl<T>,
    sendResult: (result: R) => void,
    addCancel: AddCancel
  ) => Action
): ModuleFactory<T, R> {
  return createNodeFactory({
    type: "raw",
    implementation,
  });
}
