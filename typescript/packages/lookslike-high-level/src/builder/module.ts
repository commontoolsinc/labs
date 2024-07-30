import {
  Module,
  NodeFactory,
  Value,
  CellProxy,
  isCell,
  NodeProxy,
  toJSON,
} from "./types.js";
import { cell } from "./cell-proxy.js";
import { traverseValue, moduleToJSON } from "./utils.js";

/** Declare a module
 *
 * @param implementation A function that takes an input and returns a result
 *
 * @returns A module node factory that also serializes as module.
 */
export function lift<T, R>(implementation: (input: T) => R): NodeFactory<T, R>;
export function lift<T>(
  implementation: (input: T) => any
): NodeFactory<T, ReturnType<typeof implementation>>;
export function lift<T extends (...args: any[]) => any>(
  implementation: T
): NodeFactory<Parameters<T>[0], ReturnType<T>>;
export function lift<T, R>(implementation: (input: T) => R): NodeFactory<T, R> {
  const module: Module & toJSON = {
    type: "javascript",
    implementation,
    toJSON: () => moduleToJSON(module),
  };

  return Object.assign((inputs: Value<T>): CellProxy<R> => {
    const outputs = cell<R>();
    const node: NodeProxy = { module, inputs, outputs };

    traverseValue(inputs, (value) => isCell(value) && value.connect(node));
    outputs.connect(node);

    return outputs;
  }, module);
}
