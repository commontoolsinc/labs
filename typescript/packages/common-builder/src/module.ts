import {
  Module,
  NodeFactory,
  Value,
  CellProxy,
  isCellProxy,
  NodeProxy,
  toJSON,
} from "./types.js";
import { cell } from "./cell-proxy.js";
import { traverseValue, moduleToJSON } from "./utils.js";
import type {
  JavaScriptModuleDefinition,
  JavaScriptValueMap,
  JavaScriptShapeMap,
} from "@commontools/common-runtime";

export function createNodeFactory<T = any, R = any>(
  moduleSpec: Module
): NodeFactory<T, R> {
  const module: Module & toJSON = {
    ...moduleSpec,
    toJSON: () => moduleToJSON(module),
  };

  return Object.assign((inputs: Value<T>): CellProxy<R> => {
    const outputs = cell<R>();
    const node: NodeProxy = { module, inputs, outputs };

    traverseValue(inputs, (value) => isCellProxy(value) && value.connect(node));
    outputs.connect(node);

    return outputs;
  }, module);
}

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
  return createNodeFactory({
    type: "javascript",
    implementation,
  });
}

export function handler<E, T>(
  handler: (event: E, props: T) => any
): NodeFactory<T, E> {
  const module: Module & toJSON = {
    type: "javascript",
    implementation: handler,
    wrapper: "handler",
    toJSON: () => moduleToJSON(module),
  };

  return Object.assign((props: Value<T>): CellProxy<E> => {
    const stream = cell();
    stream.set({ $stream: true });
    const node: NodeProxy = {
      module,
      inputs: { ...(props as object), $event: stream },
      outputs: {},
    };

    traverseValue(props, (value) => isCellProxy(value) && value.connect(node));
    stream.connect(node);

    return stream as unknown as CellProxy<E>;
  }, module);
}

export function isolated<T, R>(
  inputs: JavaScriptValueMap,
  outputs: JavaScriptShapeMap,
  implementation: (input: T) => R
): NodeFactory<T, R>;
export function isolated<T>(
  inputs: JavaScriptValueMap,
  outputs: JavaScriptShapeMap,
  implementation: (input: T) => any
): NodeFactory<T, ReturnType<typeof implementation>>;
export function isolated<T extends (...args: any[]) => any>(
  inputs: JavaScriptValueMap,
  outputs: JavaScriptShapeMap,
  implementation: T
): NodeFactory<Parameters<T>[0], ReturnType<T>>;
export function isolated<T, R>(
  inputs: JavaScriptValueMap,
  outputs: JavaScriptShapeMap,
  implementation: (input: T) => R
): NodeFactory<T, R> {
  const body = `import { read, write } from "common:io/state@0.0.1";

  export const run = () => {
    let inputs = {};
    ${Object.keys(inputs)
      .map((key) => `inputs["${key}"] = read("${key}")?.deref()?.val;`)
      .join("\n")}
    let fn = ${implementation.toString()};
    let result = fn(inputs);
    ${Object.keys(outputs)
      .map(
        (key) =>
          `write("${key}", { tag: typeof result["${key}"], val: result["${key}"] })`
      )
      .join("\n")}
  };
  `;

  return createNodeFactory({
    type: "isolated",
    implementation: {
      inputs,
      outputs,
      body,
    } satisfies JavaScriptModuleDefinition,
  });
}
