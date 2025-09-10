import type {
  Handler,
  HandlerFactory,
  JSONSchema,
  Module,
  ModuleFactory,
  NodeRef,
  Opaque,
  OpaqueRef,
  Schema,
  SchemaWithoutCell,
  StripCell,
  toJSON,
} from "./types.ts";
import { isModule } from "./types.ts";
import { opaqueRef } from "./opaque-ref.ts";
import {
  applyArgumentIfcToResult,
  connectInputAndOutputs,
} from "./node-utils.ts";
import { moduleToJSON } from "./json-utils.ts";
import { traverseValue } from "./traverse-utils.ts";
import { getTopFrame } from "./recipe.ts";
import { generateHandlerSchema } from "../schema.ts";

export function createNodeFactory<T = any, R = any>(
  moduleSpec: Module,
): ModuleFactory<T, R> {
  const module: Module & toJSON = {
    ...moduleSpec,
    toJSON: () => moduleToJSON(module),
  };
  // A module with ifc classification on its argument schema should have at least
  // that value on its result schema
  module.resultSchema = applyArgumentIfcToResult(
    module.argumentSchema,
    module.resultSchema,
  );
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
export function lift<
  T extends JSONSchema = JSONSchema,
  R extends JSONSchema = JSONSchema,
>(
  argumentSchema: T,
  resultSchema: R,
  implementation: (input: Schema<T>) => Schema<R>,
): ModuleFactory<SchemaWithoutCell<T>, SchemaWithoutCell<R>>;
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
  argumentSchema?: JSONSchema | ((input: any) => any),
  resultSchema?: JSONSchema,
  implementation?: (input: T) => R,
): ModuleFactory<T, R> {
  if (typeof argumentSchema === "function") {
    implementation = argumentSchema;
    argumentSchema = resultSchema = undefined;
  }

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

export function handler<
  E extends JSONSchema = JSONSchema,
  T extends JSONSchema = JSONSchema,
>(
  eventSchema: E,
  stateSchema: T,
  handler: (event: Schema<E>, props: Schema<T>) => any,
): HandlerFactory<SchemaWithoutCell<T>, SchemaWithoutCell<E>>;
export function handler<E, T>(
  eventSchema: JSONSchema,
  stateSchema: JSONSchema,
  handler: (event: E, props: T) => any,
): HandlerFactory<T, E>;
export function handler<E, T>(
  handler: (Event: E, props: T) => any,
  options: { proxy: true },
): HandlerFactory<T, E>;
export function handler<E, T>(
  handler: (event: E, props: T) => any,
): HandlerFactory<T, E>;
export function handler<E, T>(
  eventSchema:
    | JSONSchema
    | ((event: E, props: T) => any)
    | undefined,
  stateSchema?: JSONSchema | { proxy: true },
  handler?: (event: E, props: T) => any,
): HandlerFactory<T, E> {
  if (typeof eventSchema === "function") {
    if (
      stateSchema && typeof stateSchema === "object" &&
      "proxy" in stateSchema && stateSchema.proxy === true
    ) {
      handler = eventSchema;
      eventSchema = stateSchema = undefined;
    } else {
      throw new Error(
        "invalid handler, no schema provided - did you forget to enable CTS?",
      );
    }
  }

  const schema = generateHandlerSchema(
    eventSchema,
    stateSchema as JSONSchema | undefined,
  );

  const module: Handler<T, E> & toJSON & {
    bind: (inputs: Opaque<StripCell<T>>) => OpaqueRef<E>;
  } = {
    type: "javascript",
    implementation: handler,
    wrapper: "handler",
    with: (inputs: Opaque<StripCell<T>>) => factory(inputs),
    // Overriding the default `bind` method on functions. The wrapper will bind
    // the actual inputs, so they'll be available as `this`
    bind: (inputs: Opaque<StripCell<T>>) => factory(inputs),
    toJSON: () => moduleToJSON(module),
    ...(schema ? { argumentSchema: schema } : {}),
  };

  const factory = Object.assign((props: Opaque<StripCell<T>>): OpaqueRef<E> => {
    const stream = opaqueRef<E>(undefined, eventSchema);

    // Set stream marker (cast to E as stream is typed for the events it accepts)
    stream.set({ $stream: true } as E);
    const node: NodeRef = {
      module,
      inputs: { $ctx: props, $event: stream },
      outputs: {},
      frame: getTopFrame(),
    };

    connectInputAndOutputs(node);
    stream.connect(node);

    return stream;
  }, module);

  return factory;
}

export const derive = <In, Out>(
  input: Opaque<In>,
  f: (input: In) => Out | Promise<Out>,
): OpaqueRef<Out> => lift(f)(input) as OpaqueRef<Out>;

// unsafe closures: like derive, but doesn't need any arguments
export const compute: <T>(fn: () => T) => OpaqueRef<T> = (fn: () => any) =>
  lift(fn)(undefined);

// unsafe closures: like compute, but also convert all functions to handlers
export const render = <T>(fn: () => T): OpaqueRef<T> =>
  compute(() =>
    traverseValue(fn(), (v: (event: unknown, props: unknown) => any) => {
      // Modules are functions, so we need to exclude them
      if (!isModule(v) && typeof v === "function") return handler(v)({});
      else return v;
    })
  );
