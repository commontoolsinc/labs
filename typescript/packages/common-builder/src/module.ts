import type {
  Module,
  ModuleFactory,
  Opaque,
  OpaqueRef,
  NodeRef,
  toJSON,
  JSON,
} from "./types.js";
import { opaqueRef } from "./opaque-ref.js";
import { moduleToJSON, connectInputAndOutputs } from "./utils.js";
import { getTopFrame } from "./recipe.js";
import type {
  JavaScriptModuleDefinition,
  JavaScriptValueMap,
  JavaScriptShapeMap,
} from "@commontools/common-runtime";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export function createNodeFactory<T = any, R = any>(
  moduleSpec: Module,
): ModuleFactory<T, R> {
  const module: Module & toJSON = {
    ...moduleSpec,
    toJSON: () => moduleToJSON(module),
  };

  return Object.assign((inputs: Opaque<T>): OpaqueRef<R> => {
    const outputs = opaqueRef<R>();
    const node: NodeRef = { module, inputs, outputs, frame: getTopFrame() };

    connectInputAndOutputs(node);
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
export function lift<T, R>(
  argumentSchema: JSON,
  resultSchema: JSON,
  implementation: (input: T) => R,
): ModuleFactory<T, R>;
export function lift<T extends z.ZodTypeAny, R extends z.ZodTypeAny>(
  argumentSchema: T,
  resultSchema: R,
  implementation: (input: z.infer<T>) => z.infer<R>,
): ModuleFactory<T, R>;
export function lift<T, R>(
  implementation: (input: T) => R,
): ModuleFactory<T, R>;
export function lift<T>(
  implementation: (input: T) => any,
): ModuleFactory<T, ReturnType<typeof implementation>>;
export function lift<T extends (...args: any[]) => any>(
  implementation: T,
): ModuleFactory<Parameters<T>[0], ReturnType<T>>;
export function lift<T, R>(
  argumentSchema?: z.ZodTypeAny | JSON | ((input: any) => any),
  resultSchema?: z.ZodTypeAny | JSON,
  implementation?: (input: T) => R,
): ModuleFactory<T, R> {
  if (typeof argumentSchema === "function") {
    implementation = argumentSchema;
    argumentSchema = resultSchema = undefined;
  }
  if (argumentSchema instanceof z.ZodType)
    argumentSchema = zodToJsonSchema(argumentSchema) as JSON;
  if (resultSchema instanceof z.ZodType)
    resultSchema = zodToJsonSchema(resultSchema) as JSON;

  return createNodeFactory({
    type: "javascript",
    implementation,
    ...(argumentSchema ? { argumentSchema } : {}),
    ...(resultSchema ? { resultSchema } : {}),
  });
}

export function byRef<T, R>(ref: string): ModuleFactory<T, R> {
  return createNodeFactory({
    type: "ref",
    implementation: ref,
  });
}

export const derive = <In, Out>(
  input: Opaque<In>,
  f: (input: In) => Out,
): OpaqueRef<Out> => lift(f)(input);

export function handler<E, T>(
  handler: (event: E, props: T) => any,
): ModuleFactory<T, E> {
  const module: Module & toJSON = {
    type: "javascript",
    implementation: handler,
    wrapper: "handler",
    toJSON: () => moduleToJSON(module),
  };

  return Object.assign((props: Opaque<T>): OpaqueRef<E> => {
    const stream = opaqueRef();
    stream.set({ $stream: true });
    const node: NodeRef = {
      module,
      inputs: { ...(props as object), $event: stream },
      outputs: {},
      frame: getTopFrame(),
    };

    connectInputAndOutputs(node);
    stream.connect(node);

    return stream as unknown as OpaqueRef<E>;
  }, module);
}

export function isolated<T, R>(
  inputs: JavaScriptValueMap,
  outputs: JavaScriptShapeMap,
  implementation: (input: T) => R,
): ModuleFactory<T, R>;
export function isolated<T>(
  inputs: JavaScriptValueMap,
  outputs: JavaScriptShapeMap,
  implementation: (input: T) => any,
): ModuleFactory<T, ReturnType<typeof implementation>>;
export function isolated<T extends (...args: any[]) => any>(
  inputs: JavaScriptValueMap,
  outputs: JavaScriptShapeMap,
  implementation: T,
): ModuleFactory<Parameters<T>[0], ReturnType<T>>;
export function isolated<T, R>(
  inputs: JavaScriptValueMap,
  outputs: JavaScriptShapeMap,
  implementation: (input: T) => R,
): ModuleFactory<T, R> {
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
          `write("${key}", { tag: typeof result["${key}"], val: result["${key}"] })`,
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
