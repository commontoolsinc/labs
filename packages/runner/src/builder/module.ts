import type {
  Handler,
  HandlerFactory,
  JSONSchema,
  Module,
  ModuleFactory,
  NodeRef,
  Opaque,
  OpaqueCell,
  OpaqueRef,
  Schema,
  SchemaWithoutCell,
  StripCell,
  toJSON,
} from "./types.ts";
import { opaqueRef, stream } from "./opaque-ref.ts";
import {
  applyArgumentIfcToResult,
  connectInputAndOutputs,
} from "./node-utils.ts";
import { moduleToJSON } from "./json-utils.ts";
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
    (outputs as OpaqueCell<R>).connect(node);

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
    ...(argumentSchema !== undefined ? { argumentSchema } : {}),
    ...(resultSchema !== undefined ? { resultSchema } : {}),
  });
}

export function byRef<T, R>(ref: string): ModuleFactory<T, R> {
  return createNodeFactory({
    type: "ref",
    implementation: ref,
  });
}

function handlerInternal<E, T>(
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
    ...(schema !== undefined ? { argumentSchema: schema } : {}),
  };

  const factory = Object.assign((props: Opaque<StripCell<T>>): OpaqueRef<E> => {
    const eventStream = stream<E>(eventSchema);

    // Set stream marker (cast to E as stream is typed for the events it accepts)
    const node: NodeRef = {
      module,
      inputs: { $ctx: props, $event: eventStream },
      outputs: {},
      frame: getTopFrame(),
    };

    connectInputAndOutputs(node);

    return eventStream;
  }, module);

  return factory;
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
  return handlerInternal(eventSchema, stateSchema, handler);
}

export function derive<
  InputSchema extends JSONSchema = JSONSchema,
  ResultSchema extends JSONSchema = JSONSchema,
>(
  argumentSchema: InputSchema,
  resultSchema: ResultSchema,
  input: Opaque<SchemaWithoutCell<InputSchema>>,
  f: (
    input: Schema<InputSchema>,
  ) => Schema<ResultSchema>,
): OpaqueRef<SchemaWithoutCell<ResultSchema>>;
export function derive<In, Out>(
  input: Opaque<In>,
  f: (input: In) => Out,
): OpaqueRef<Out>;
export function derive<In, Out>(...args: any[]): OpaqueRef<any> {
  if (args.length === 4) {
    const [argumentSchema, resultSchema, input, f] = args as [
      JSONSchema,
      JSONSchema,
      Opaque<SchemaWithoutCell<any>>,
      (input: Schema<any>) => Schema<any>,
    ];
    return lift(
      argumentSchema,
      resultSchema,
      f as (input: Schema<any>) => Schema<any>,
    )(input);
  }

  const [input, f] = args as [
    Opaque<In>,
    (input: In) => Out,
  ];
  return lift(f)(input);
}

// unsafe closures: like derive, but doesn't need any arguments
export const computed: <T>(fn: () => T) => OpaqueRef<T> = <T>(fn: () => T) =>
  lift<any, T>(fn)(undefined);

/**
 * Reactive reduce over an array.
 *
 * Unlike derive(), reduce() takes a reducer function that aggregates array
 * elements. The reducer receives UNWRAPPED values - not Cell proxies.
 *
 * Re-runs whenever any item in the list changes (streaming behavior).
 *
 * @example
 * ```typescript
 * const items = cell([1, 2, 3, 4, 5]);
 * const sum = reduce(items, 0, (acc, item) => acc + item);
 * // sum is now OpaqueRef<number> with value 15
 *
 * // With external state (closures captured by ts-transformers):
 * const multiplier = cell(2);
 * const doubled = reduce(items, 0, (acc, item) => acc + item * multiplier);
 * ```
 *
 * @param list - The array to reduce over (as Opaque)
 * @param initial - Initial accumulator value
 * @param reducer - Function that takes (accumulator, item, index) and returns new accumulator
 * @returns OpaqueRef containing the reduced result
 */
export function reduce<
  ListSchema extends JSONSchema = JSONSchema,
  ResultSchema extends JSONSchema = JSONSchema,
>(
  argumentSchema: ListSchema,
  resultSchema: ResultSchema,
  list: Opaque<SchemaWithoutCell<ListSchema>>,
  initial: Schema<ResultSchema>,
  reducer: (
    acc: Schema<ResultSchema>,
    item: Schema<ListSchema> extends (infer U)[] ? U : never,
    index: number,
  ) => Schema<ResultSchema>,
): OpaqueRef<SchemaWithoutCell<ResultSchema>>;
export function reduce<T, R>(
  list: Opaque<T[]>,
  initial: R,
  reducer: (acc: R, item: T, index: number) => R,
): OpaqueRef<R>;
export function reduce<T, R>(...args: any[]): OpaqueRef<any> {
  // Schema-based overload (5 args)
  if (args.length === 5) {
    const [argumentSchema, resultSchema, list, initial, reducer] = args as [
      JSONSchema,
      JSONSchema,
      Opaque<SchemaWithoutCell<any>>,
      any,
      (acc: any, item: any, index: number) => any,
    ];
    return lift(
      { type: "object", properties: { list: argumentSchema, initial: resultSchema } } as JSONSchema,
      resultSchema,
      (inputs: { list: any[]; initial: any }) => {
        if (!inputs.list || !Array.isArray(inputs.list)) return inputs.initial;
        return inputs.list.reduce(reducer, inputs.initial);
      },
    )({ list, initial });
  }

  // Simple overload (3 args)
  const [list, initial, reducer] = args as [
    Opaque<T[]>,
    R,
    (acc: R, item: T, index: number) => R,
  ];

  return lift((inputs: { list: T[]; initial: R }) => {
    if (!inputs.list || !Array.isArray(inputs.list)) return inputs.initial;
    return inputs.list.reduce(reducer, inputs.initial);
  })({ list, initial });
}
