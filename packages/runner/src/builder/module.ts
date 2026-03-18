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
  Stream,
  StripCell,
  toJSON,
} from "./types.ts";
import { opaqueRef, stream } from "./opaque-ref.ts";
import {
  applyArgumentIfcToResult,
  connectInputAndOutputs,
} from "./node-utils.ts";
import { moduleToJSON } from "./json-utils.ts";
import { getTopFrame } from "./pattern.ts";
import { generateHandlerSchema } from "../schema.ts";
import { createRef } from "../create-ref.ts";
import {
  CT_CAPTURE_IDS,
  CT_IMPLEMENTATION_REF,
  CT_ITEM_ID,
  CT_WRAPPER_KIND,
  type VerifiedCallable,
  type VerifiedMetadataCarrier,
  type VerifiedWrapperKind,
} from "../sandbox/types.ts";

export function createNodeFactory<T = any, R = any>(
  moduleSpec: Module,
): ModuleFactory<T, R> {
  // Attach source location and preview to function implementations for debugging
  if (typeof moduleSpec.implementation === "function") {
    const verifiedImplementation = !!(moduleSpec.implementation as
      & VerifiedCallable
      & VerifiedMetadataCarrier)[
        CT_IMPLEMENTATION_REF
      ];
    if (!verifiedImplementation) {
      annotateImplementation(moduleSpec.implementation);
    }
    moduleSpec.implementationRef ??= ensureImplementationRef(
      moduleSpec.implementation,
      "fn",
    );
  }

  const factory = Object.assign((inputs: Opaque<T>): OpaqueRef<R> => {
    const outputs = opaqueRef<R>();
    const node: NodeRef = {
      module: factory as unknown as Module & toJSON,
      inputs,
      outputs,
      frame: getTopFrame(),
    };

    connectInputAndOutputs(node);
    (outputs as OpaqueCell<R>).connect(node);

    return outputs;
  }, moduleSpec) as ModuleFactory<T, R> & Module & toJSON;
  factory.toJSON = () => moduleToJSON(factory);
  // A module with ifc classification on its argument schema should have at least
  // that value on its result schema
  factory.resultSchema = applyArgumentIfcToResult(
    factory.argumentSchema,
    factory.resultSchema,
  );
  return factory;
}

/** Extract file path and location from a stack frame line
 * Handles formats like:
 *   "    at functionName (file:///path/to/file.ts:42:15)"
 *   "    at file:///path/to/file.ts:42:15"
 *   "    at functionName (http://localhost:8000/scripts/index.js:250239:17)"
 *   "    at Object.eval [as factory] (somehash.js:52:52)"
 * @internal Exported for testing
 */
export function parseStackFrame(
  line: string,
): { file: string; line: number; col: number } | null {
  // Try to match file path inside parentheses first (most common format)
  // Handles: "at functionName (file:///path:42:15)" or "(http://url:42:15)"
  let match = line.match(/\((.+):(\d+):(\d+)\)\s*$/);

  // If no match, try to match after "at " without parentheses
  // Handles: "at file:///path:42:15" or "at http://url:42:15"
  if (!match) {
    match = line.match(/at\s+(.+):(\d+):(\d+)\s*$/);
  }

  if (!match) return null;
  const [, filePath, lineNum, col] = match;
  return {
    file: filePath.replace(/^file:\/\//, ""),
    line: parseInt(lineNum, 10),
    col: parseInt(col, 10),
  };
}

/** Extract the first source location from a stack trace that isn't from this file.
 * If a source map is available, maps the position back to the original source.
 */
function getExternalSourceLocation(): string | null {
  const stack = new Error().stack;
  if (!stack) return null;

  const lines = stack.split("\n");

  // Find this file from the first real stack frame
  let thisFile: string | null = null;
  for (const line of lines) {
    const frame = parseStackFrame(line);
    if (frame) {
      thisFile = frame.file;
      break;
    }
  }
  if (!thisFile) return null;

  // Find first frame not from this file
  for (const line of lines) {
    const frame = parseStackFrame(line);
    if (frame && frame.file !== thisFile) {
      // Try to map via source maps if available
      const harness = getTopFrame()?.runtime?.harness;
      const mapped = harness?.mapPosition(frame.file, frame.line, frame.col);
      if (mapped?.source && mapped?.line != null) {
        return `${mapped.source}:${mapped.line}:${mapped.column ?? 0}`;
      }
      return `${frame.file}:${frame.line}:${frame.col}`;
    }
  }
  return null;
}

function annotateImplementation(implementation: VerifiedCallable): void {
  const location = getExternalSourceLocation();
  if (location) {
    defineDebugProperty(implementation, "name", location);
    defineDebugProperty(implementation, "src", location);
  }
  const fnStr = implementation.toString();
  defineDebugProperty(implementation, "preview", fnStr.slice(0, 200));
}

function defineDebugProperty(
  target: VerifiedCallable,
  key: "name" | "src" | "preview",
  value: string,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor && !descriptor.configurable && !descriptor.writable) {
    return;
  }

  try {
    Object.defineProperty(target, key, {
      value,
      configurable: true,
      writable: true,
    });
  } catch {
    // Verified wrappers may already be frozen/hardened when they are reused by
    // higher-level builders. Debug metadata is best-effort and must not break
    // module construction.
  }
}

function ensureImplementationRef(
  implementation: VerifiedCallable,
  kind: VerifiedWrapperKind,
): string {
  const metadata = implementation as
    & VerifiedCallable
    & VerifiedMetadataCarrier;
  const existing = metadata[CT_IMPLEMENTATION_REF];
  if (existing) {
    return existing;
  }

  const src = (implementation as { src?: string }).src ?? implementation.name;
  const implementationRef = createRef({
    kind,
    source: src,
    preview: implementation.toString(),
  }, "verified implementation").toString();

  tryDefineMetadata(implementation, CT_IMPLEMENTATION_REF, implementationRef);
  tryDefineMetadata(implementation, CT_ITEM_ID, implementationRef);
  tryDefineMetadata(implementation, CT_WRAPPER_KIND, kind);
  tryDefineMetadata(implementation, CT_CAPTURE_IDS, Object.freeze([]));
  return implementationRef;
}

function defineMetadata<T>(
  target: object,
  key: symbol,
  value: T,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function tryDefineMetadata<T>(
  target: object,
  key: symbol,
  value: T,
): void {
  try {
    defineMetadata(target, key, value);
  } catch {
    // Verified/frozen callbacks may already be non-extensible. The enclosing
    // module factory still carries the generated implementationRef.
  }
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
  let writableProxy = false;
  if (typeof eventSchema === "function") {
    if (
      stateSchema && typeof stateSchema === "object" &&
      "proxy" in stateSchema && stateSchema.proxy === true
    ) {
      handler = eventSchema;
      eventSchema = stateSchema = undefined;
      writableProxy = true;
    } else {
      throw new Error(
        "Handler requires schemas or CTS transformer\n" +
          "help: enable CTS with /// <cts-enable /> for automatic schema inference, or provide explicit schemas",
      );
    }
  }

  const schema = generateHandlerSchema(
    eventSchema,
    stateSchema as JSONSchema | undefined,
  );

  annotateImplementation(handler!);
  const factory = Object.assign((props: Opaque<StripCell<T>>): Stream<E> => {
    // If the event schema is false, we actually set it to true here, since
    // otherwise we won't think it needs to be handled. Ditto for state.
    // TODO(@ubik2): I should be able to remove this workaround, but the stream
    // handler wasn't being triggered. This is a temporary workaround.
    const flexibleEventSchema = eventSchema ? eventSchema : true as JSONSchema;
    const eventStream = stream<E>(flexibleEventSchema);

    // Set stream marker (cast to E as stream is typed for the events it accepts)
    const node: NodeRef = {
      module: factory as unknown as Handler<T, E> & toJSON,
      inputs: { $ctx: props, $event: eventStream },
      outputs: {},
      frame: getTopFrame(),
    };

    connectInputAndOutputs(node);

    return eventStream;
  }, {
    type: "javascript",
    implementation: handler,
    implementationRef: ensureImplementationRef(handler!, "handler"),
    wrapper: "handler",
    ...(schema !== undefined && { argumentSchema: schema }),
    ...(writableProxy && { writableProxy: true }),
  }) as HandlerFactory<T, E> & Handler<T, E> & toJSON & {
    bind: (inputs: Opaque<StripCell<T>>) => Stream<E>;
  };
  factory.with = (inputs: Opaque<StripCell<T>>) => factory(inputs);
  // Overriding the default `bind` method on functions. The wrapper will bind
  // the actual inputs, so they'll be available as `this`
  factory.bind = (inputs: Opaque<StripCell<T>>) => factory(inputs);
  factory.toJSON = () => moduleToJSON(factory);

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

export function createVerifiedHandlerFactory<E, T>(
  implementation: (event: E, props: T) => any,
): HandlerFactory<T, E> {
  const factory = Object.assign((props: Opaque<StripCell<T>>): Stream<E> => {
    const eventStream = stream<E>(true as JSONSchema);
    const node: NodeRef = {
      module: factory as unknown as Handler<T, E> & toJSON,
      inputs: { $ctx: props, $event: eventStream },
      outputs: {},
      frame: getTopFrame(),
    };

    connectInputAndOutputs(node);

    return eventStream;
  }, {
    type: "javascript",
    implementation,
    implementationRef: ensureImplementationRef(implementation, "handler"),
    wrapper: "handler",
    writableProxy: true,
  }) as HandlerFactory<T, E> & Handler<T, E> & toJSON & {
    bind: (inputs: Opaque<StripCell<T>>) => Stream<E>;
  };
  factory.with = (inputs: Opaque<StripCell<T>>) => factory(inputs);
  factory.bind = (inputs: Opaque<StripCell<T>>) => factory(inputs);
  factory.toJSON = () => moduleToJSON(factory);

  return factory;
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

// unsafe closures: like derive, but doesn't need any arguments.
// Uses argumentSchema: false to signal "takes no input" so the action
// validation doesn't skip it due to undefined arguments.
export const computed: <T>(fn: () => T) => OpaqueRef<T> = <T>(fn: () => T) =>
  createNodeFactory<any, T>({
    type: "javascript",
    implementation: fn,
    argumentSchema: false,
  })(undefined);

/**
 * action: Creates a handler that doesn't use the state parameter.
 *
 * This is to handler as computed is to lift/derive:
 * - User writes: action((e) => count.set(e.data))
 * - Transformer rewrites to: handler((e, { count }) => count.set(e.data))({ count })
 *
 * The transformer extracts closures and makes them explicit, just like how
 * computed(() => expr) becomes derive({}, () => expr) with closure extraction.
 *
 * NOTE: This function should never be called directly at runtime because the
 * CTS transformer rewrites action() calls to handler() calls. If this function
 * is reached, it means CTS is not enabled.
 *
 * @example Zero-parameter action (most common)
 * ```ts
 * const increment = action(() => count.set(count.get() + 1));
 * // Returns Stream<void>
 * ```
 *
 * @example Action with event data
 * ```ts
 * const selectItem = action((id: string) => selected.set(id));
 * // Returns Stream<string>
 * ```
 *
 * @param _event - A function that receives an event and performs side effects
 * @throws Error if called directly (CTS must be enabled for action() to work)
 */
// Overload 1: Zero-parameter callback returns Stream<void>
export function action(_event: () => void): Stream<void>;
// Overload 2: Parameterized callback returns Stream<T>
export function action<T>(_event: (event: T) => void): Stream<T>;
export function action<T>(_event: (event?: T) => void): Stream<T> {
  throw new Error(
    "action() must be used with CTS enabled - add /// <cts-enable /> to your file",
  );
}
