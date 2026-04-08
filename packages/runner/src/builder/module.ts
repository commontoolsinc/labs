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
import { getLogger } from "@commonfabric/utils/logger";
import { createRef } from "../create-ref.ts";
import {
  hardenVerifiedFunction,
  registerVerifiedFunctionImplementation,
} from "../sandbox/function-hardening.ts";

const sourceLocationLogger = getLogger("builder.source-location", {
  enabled: false,
  level: "warn",
  logCountEvery: 0,
});
const MAX_SOURCE_LOCATION_FLAGS = 40;
const sourceLocationFlagIds: string[] = [];

function recordSourceLocationSample(metadata: Record<string, unknown>): void {
  const id = `sample-${Date.now()}-${sourceLocationFlagIds.length + 1}`;
  sourceLocationLogger.flag("sample", id, true, metadata);
  sourceLocationFlagIds.push(id);
  while (sourceLocationFlagIds.length > MAX_SOURCE_LOCATION_FLAGS) {
    const oldest = sourceLocationFlagIds.shift();
    if (oldest) {
      sourceLocationLogger.flag("sample", oldest, false);
    }
  }
}

interface SourceLocationResult {
  location: string | null;
  sample?: Record<string, unknown>;
}

type PositionMapper = (
  file: string,
  line: number,
  col: number,
) =>
  | {
    source?: string;
    line?: number;
    column?: number;
    name?: string;
  }
  | null
  | undefined;

const INTERNAL_SOURCE_LOCATION_FRAME_PATTERNS = [
  /\bgetExternalSourceLocation\b/,
  /\bannotateFunctionDebugMetadata\b/,
  /\bcreateNodeFactory\b/,
  /\bhandlerInternal\b/,
  /\blift\b/,
  /\bhandler\b/,
  /\bderive\b/,
  /\btrusted(?:Pattern|Lift|Handler|Computed|Derive|Str|PatternTool)\b/,
  /\/packages\/runner\/src\/builder\/factory\.ts:\d+:\d+/,
];
const SYNTHETIC_MAPPED_LINE = 1;
const SYNTHETIC_MAPPED_COLUMN = 23;

export function createNodeFactory<T = any, R = any>(
  moduleSpec: Module,
): ModuleFactory<T, R> {
  // Attach source location and preview to function implementations for debugging
  if (typeof moduleSpec.implementation === "function") {
    const implementation = prepareInspectableImplementation(
      moduleSpec.implementation,
    );
    annotateFunctionDebugMetadata(implementation);
    moduleSpec.implementationRef = ensureImplementationRef(
      implementation,
      "fn",
    );
    hardenVerifiedFunction(implementation);
    moduleSpec.implementation = implementation;
  }

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
  const normalizedFilePath = filePath
    .replace(/^file:\/\//, "")
    .replace(/, <anonymous>$/, "");
  return {
    file: normalizedFilePath,
    line: parseInt(lineNum, 10),
    col: parseInt(col, 10),
  };
}

/** Extract the first source location from a stack trace that isn't from this file.
 * If a source map is available, maps the position back to the original source.
 */
function getExternalSourceLocation(): SourceLocationResult {
  const topFrame = getTopFrame();
  const mapPosition = (file: string, line: number, col: number) =>
    topFrame?.runtime?.harness?.mapPosition(file, line, col);
  const stackResult = resolveSourceLocationFromStack(
    new Error().stack,
    mapPosition,
  );
  if (stackResult.location) {
    return stackResult;
  }
  return { location: null };
}

export function resolveSourceLocationFromStack(
  stack: string | undefined,
  mapPosition?: PositionMapper,
): SourceLocationResult {
  if (!stack) return { location: null };

  const parsedFrames = stack
    .split("\n")
    .map((line, index) => ({
      index,
      raw: line.trim(),
      frame: parseStackFrame(line),
    }))
    .filter((entry) => !!entry.frame);

  const thisFile = parsedFrames[0]?.frame?.file ?? null;
  sourceLocationLogger.debug("sample-stack", () => [{
    thisFile,
    parsedFrames: parsedFrames.slice(0, 8).map((entry) => ({
      index: entry.index,
      raw: entry.raw,
      frame: entry.frame,
    })),
  }]);

  for (const entry of parsedFrames) {
    const frame = entry.frame;
    if (!frame) {
      continue;
    }
    if (
      INTERNAL_SOURCE_LOCATION_FRAME_PATTERNS.some((pattern) =>
        pattern.test(entry.raw)
      )
    ) {
      continue;
    }

    const mapped = mapPosition?.(frame.file, frame.line, frame.col) ?? null;
    const metadata = {
      raw: entry.raw,
      frame,
      mapped: mapped
        ? {
          source: mapped.source,
          line: mapped.line,
          column: mapped.column,
          name: mapped.name,
        }
        : null,
      parsedFrames: parsedFrames.slice(0, 8).map((entry) => ({
        index: entry.index,
        raw: entry.raw,
        frame: entry.frame,
      })),
    };

    sourceLocationLogger.debug("sample-candidate", () => [{
      raw: entry.raw,
      frame,
      mapped: mapped
        ? {
          source: mapped.source,
          line: mapped.line,
          column: mapped.column,
          name: mapped.name,
        }
        : null,
    }]);

    if (mapped?.source && mapped?.line != null) {
      if (
        mapped.line === SYNTHETIC_MAPPED_LINE &&
        (mapped.column ?? 0) === SYNTHETIC_MAPPED_COLUMN
      ) {
        continue;
      }
      const resolved = `${mapped.source}:${mapped.line}:${mapped.column ?? 0}`;
      recordSourceLocationSample(metadata);
      sourceLocationLogger.debug("sample-resolved", () => [{
        resolution: "mapped",
        resolved,
      }]);
      return { location: resolved, sample: metadata };
    }

    if (frame.file === thisFile) {
      continue;
    }

    const resolved = `${frame.file}:${frame.line}:${frame.col}`;
    recordSourceLocationSample(metadata);
    sourceLocationLogger.debug("sample-resolved", () => [{
      resolution: "raw",
      resolved,
    }]);
    return { location: resolved, sample: metadata };
  }

  sourceLocationLogger.debug("sample-miss", () => [{
    reason: "no-external-frame",
    thisFile,
  }]);
  return { location: null };
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
          "help: CTS transforms are enabled by default; remove /// <cf-disable-transform /> for automatic schema inference, or provide explicit schemas",
      );
    }
  }

  // Attach source location and preview to handler function for debugging
  let implementationRef: string | undefined;
  if (typeof handler === "function") {
    handler = prepareInspectableImplementation(handler);
    annotateFunctionDebugMetadata(handler);
    implementationRef = ensureImplementationRef(handler, "handler");
    hardenVerifiedFunction(handler);
  }

  const schema = generateHandlerSchema(
    eventSchema,
    stateSchema as JSONSchema | undefined,
  );

  const module: Handler<T, E> & toJSON & {
    bind: (inputs: Opaque<StripCell<T>>) => Stream<E>;
  } = {
    type: "javascript",
    implementation: handler,
    ...(implementationRef ? { implementationRef } : {}),
    wrapper: "handler",
    with: (inputs: Opaque<StripCell<T>>) => factory(inputs),
    // Overriding the default `bind` method on functions. The wrapper will bind
    // the actual inputs, so they'll be available as `this`
    bind: (inputs: Opaque<StripCell<T>>) => factory(inputs),
    toJSON: () => moduleToJSON(module),
    ...(schema !== undefined && { argumentSchema: schema }),
    ...(writableProxy && { writableProxy: true }),
  };

  const factory = Object.assign((props: Opaque<StripCell<T>>): Stream<E> => {
    // If the event schema is false, we actually set it to true here, since
    // otherwise we won't think it needs to be handled. Ditto for state.
    // TODO(@ubik2): I should be able to remove this workaround, but the stream
    // handler wasn't being triggered. This is a temporary workaround.
    const flexibleEventSchema = eventSchema ? eventSchema : true as JSONSchema;
    const eventStream = stream<E>(flexibleEventSchema);

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
    "action() must be used with CTS transforms enabled - remove /// <cf-disable-transform /> from your file",
  );
}

function annotateFunctionDebugMetadata(
  fn: (...args: any[]) => unknown,
): void {
  if (!Object.isExtensible(fn)) {
    return;
  }

  const { location, sample } = getExternalSourceLocation();
  const fallbackLocation = location ?? resolveLocationFromFunctionSource(fn);
  const finalLocation = fallbackLocation;
  if (finalLocation) {
    if (location) {
      Object.defineProperty(fn, "name", {
        value: finalLocation,
        configurable: true,
      });
    }
    // Also set .src as backup (name can be finicky)
    (fn as {
      src?: string;
      sourceLocationSample?: Record<string, unknown>;
    }).src = finalLocation;
    if (sample) {
      (fn as {
        sourceLocationSample?: Record<string, unknown>;
      }).sourceLocationSample = sample;
    }
  }

  // Store function body preview for hover tooltips
  const fnStr = fn.toString();
  (fn as { preview?: string }).preview = fnStr.slice(0, 200);
}

function prepareInspectableImplementation<
  T extends (...args: any[]) => unknown,
>(
  implementation: T,
): T {
  if (Object.isExtensible(implementation)) {
    return implementation;
  }

  const source = implementation.toString();
  const wrapped = function (this: unknown, ...args: Parameters<T>) {
    return implementation.apply(this, args);
  } as (...args: Parameters<T>) => ReturnType<T>;

  Object.defineProperty(wrapped, "toString", {
    value: () => source,
    configurable: true,
  });

  return wrapped as T;
}

function resolveLocationFromFunctionSource(
  fn: (...args: any[]) => unknown,
): string | null {
  const frame = getTopFrame();
  const context = frame?.sourceLocationContext;
  const harness = frame?.runtime?.harness;
  if (!context || !harness) {
    return null;
  }

  const source = fn.toString();
  if (!source) {
    return null;
  }

  let index = context.script.indexOf(source, context.nextSearchOffset);
  if (index === -1 && context.nextSearchOffset > 0) {
    index = context.script.indexOf(source);
  }
  if (index === -1) {
    return null;
  }

  context.nextSearchOffset = index + source.length;
  const mapped = findMappedLocationInSourceRange(
    context.filename,
    context.script,
    index,
    index + source.length,
    harness.mapPosition.bind(harness),
  );
  if (mapped) {
    return mapped;
  }
  const { line, col } = getLineAndColumnAtOffset(context.script, index);
  return `${context.filename}:${line}:${col}`;
}

function getLineAndColumnAtOffset(
  source: string,
  offset: number,
): { line: number; col: number } {
  const clampedOffset = Math.max(0, Math.min(offset, source.length));
  const prefix = source.slice(0, clampedOffset);
  const lines = prefix.split("\n");
  const line = lines.length;
  const col = lines.at(-1)?.length ?? 0;
  return { line, col };
}

function findMappedLocationInSourceRange(
  filename: string,
  script: string,
  startOffset: number,
  endOffset: number,
  mapPosition: PositionMapper,
): string | null {
  let { line, col } = getLineAndColumnAtOffset(script, startOffset);
  const limit = Math.min(endOffset, script.length);

  for (let offset = startOffset; offset < limit; offset++) {
    const mapped = mapPosition(filename, line, col);
    if (mapped?.source && mapped?.line != null) {
      return `${mapped.source}:${mapped.line}:${mapped.column ?? 0}`;
    }

    const char = script[offset];
    if (char === "\n") {
      line += 1;
      col = 0;
    } else {
      col += 1;
    }
  }

  return null;
}

function ensureImplementationRef(
  implementation: (...args: any[]) => unknown,
  kind: "fn" | "handler",
): string {
  const frame = getTopFrame();
  const existing = (implementation as { implementationRef?: string })
    .implementationRef;
  const implementationRef = existing ?? (() => {
    const source = (implementation as { src?: string }).src ??
      implementation.name;
    const minted = createRef({
      kind,
      source,
      preview: implementation.toString(),
      ...(frame ? { ordinal: frame.generatedIdCounter++ } : {}),
    }, "verified implementation").toString();

    if (Object.isExtensible(implementation)) {
      Object.defineProperty(implementation, "implementationRef", {
        value: minted,
        configurable: true,
        writable: true,
      });
    }

    return minted;
  })();

  registerVerifiedFunctionImplementation(implementationRef, implementation);
  return implementationRef;
}
