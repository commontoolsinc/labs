import type {
  Module,
  Handler,
  ModuleFactory,
  HandlerFactory,
  Opaque,
  OpaqueRef,
  NodeRef,
  toJSON,
  JSONSchema,
} from "./types.js";
import { isModule } from "./types.js";
import { opaqueRef } from "./opaque-ref.js";
import {
  moduleToJSON,
  connectInputAndOutputs,
  traverseValue,
} from "./utils.js";
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
  argumentSchema: JSONSchema,
  resultSchema: JSONSchema,
  implementation: (input: T) => R,
): ModuleFactory<T, R>;
export function lift<T extends z.ZodTypeAny, R extends z.ZodTypeAny>(
  argumentSchema: T,
  resultSchema: R,
  implementation: (
    input: z.infer<typeof argumentSchema>,
  ) => z.infer<typeof resultSchema>,
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
  argumentSchema?: z.ZodTypeAny | JSONSchema | ((input: any) => any),
  resultSchema?: z.ZodTypeAny | JSONSchema,
  implementation?: (input: T) => R,
): ModuleFactory<T, R> {
  if (typeof argumentSchema === "function") {
    implementation = argumentSchema;
    argumentSchema = resultSchema = undefined;
  }
  if (argumentSchema instanceof z.ZodType)
    argumentSchema = zodToJsonSchema(argumentSchema) as JSONSchema;
  if (resultSchema instanceof z.ZodType)
    resultSchema = zodToJsonSchema(resultSchema) as JSONSchema;

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

export function handler<E, T>(
  eventSchema: JSONSchema,
  stateSchema: JSONSchema,
  handler: (event: E, props: T) => any,
): HandlerFactory<T, E>;
export function handler<E extends z.ZodTypeAny, T extends z.ZodTypeAny>(
  eventSchema: E,
  stateSchema: T,
  handler: (
    event: z.infer<typeof eventSchema>,
    props: z.infer<typeof stateSchema>,
  ) => any,
): HandlerFactory<T, E>;
export function handler<E, T>(
  handler: (event: E, props: T) => any,
): HandlerFactory<T, E>;
export function handler<E, T>(
  eventSchema:
    | JSONSchema
    | z.ZodTypeAny
    | ((event: E, props: T) => any)
    | undefined,
  stateSchema?: JSONSchema | z.ZodTypeAny,
  handler?: (event: E, props: T) => any,
): HandlerFactory<T, E> {
  if (typeof eventSchema === "function") {
    handler = eventSchema;
    eventSchema = stateSchema = undefined;
  }

  if (eventSchema instanceof z.ZodType)
    eventSchema = zodToJsonSchema(eventSchema) as JSONSchema;
  if (stateSchema instanceof z.ZodType)
    stateSchema = zodToJsonSchema(stateSchema) as JSONSchema;

  const schema: JSONSchema | undefined =
    eventSchema || stateSchema
      ? {
          type: "object",
          properties: {
            $event: eventSchema ?? {},
            ...(stateSchema?.properties ?? {}),
          },
        }
      : undefined;

  const module: Handler &
    toJSON & { bind: (inputs: Opaque<T>) => OpaqueRef<E> } = {
    type: "javascript",
    implementation: handler,
    wrapper: "handler",
    with: (inputs: Opaque<T>) => factory(inputs),
    // Overriding the default `bind` method on functions. The wrapper will bind
    // the actual inputs, so they'll be available as `this`
    bind: (inputs: Opaque<T>) => factory(inputs),
    toJSON: () => moduleToJSON(module),
    ...(schema ? { argumentSchema: schema } : {}),
  };

  const factory = Object.assign((props: Opaque<T>): OpaqueRef<E> => {
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

  return factory;
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
      .map(key => `inputs["${key}"] = read("${key}")?.deref()?.val;`)
      .join("\n")}
    let fn = ${implementation.toString()};
    let result = fn(inputs);
    ${Object.keys(outputs)
      .map(
        key =>
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

// Lift a function and directly apply inputs
export const derive = <In, Out>(
  input: Opaque<In>,
  f: (input: In) => Out,
): OpaqueRef<Out> => lift(f)(input);

// Like `derive`, but for event handlers
// export const event = <T = any>(
//   input: Opaque<T>,
//   f: (event: T, self: any) => any,
// ): OpaqueRef<T> => handler(f)(input);

// unsafe closures: like derive, but doesn't need any arguments
export const compute: <T>(fn: () => T) => OpaqueRef<T> = (fn: () => any) =>
  lift(fn)(undefined);

// unsafe closures: like compute, but also convert all functions to handlers
export const render = <T>(fn: () => T): OpaqueRef<T> =>
  compute(() =>
    traverseValue(fn(), v => {
      // Modules are functions, so we need to exclude them
      if (!isModule(v) && typeof v === "function") return handler(v)({});
      else return v;
    }),
  );
