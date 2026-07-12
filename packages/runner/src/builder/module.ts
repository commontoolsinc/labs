import type {
  AssertPart,
  AssertRecord,
  CellScope,
  FactoryInput,
  Frame,
  Handler,
  HandlerFactory,
  JSONSchema,
  Module,
  ModuleFactory,
  NodeRef,
  OpaqueCell,
  Reactive,
  Schema,
  SchemaWithoutCell,
  Stream,
  StripCell,
  toJSON,
} from "./types.ts";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { reactive, stream } from "./reactive.ts";
import {
  applyArgumentIfcToResult,
  connectInputAndOutputs,
} from "./node-utils.ts";
import { assertNotInActionExecution } from "./action-context.ts";
import { moduleToJSON } from "./json-utils.ts";
import {
  bindFactoryRootToken,
  brandTrustedBuilderArtifact,
  type FrameworkProvidedPath,
  getArtifactEntryRef,
  getDurableArtifactRefForRootToken,
  noteDerivedCopy,
  setFrameworkProvidedPaths,
} from "./pattern-metadata.ts";
import { getVerifiedProvenance } from "../harness/verified-provenance.ts";
import { getTopFrame, readFrameworkProvidedPaths } from "./pattern.ts";
import { generateHandlerSchema } from "../schema.ts";
import { getLogger } from "@commonfabric/utils/logger";
import { hardenVerifiedFunction } from "../sandbox/function-hardening.ts";
import { registerFabricFactory } from "@commonfabric/data-model/fabric-factory";

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

/**
 * Wrap a harness into a {@link PositionMapper} that rewrites the mapped
 * `source` into its reload-stable canonical form (`cf:module/<hash>/<path>`)
 * when the harness can resolve it. This is what makes every `fn.src` (and thus
 * scheduler action ids, fingerprints, CFC verified-source) stable across reloads
 * irrespective of which bundle/entry-point compiled the module. Built-in or
 * unmapped sources are left untouched.
 */
function canonicalizingMapPosition(
  harness: {
    mapPosition(
      file: string,
      line: number,
      col: number,
    ): ReturnType<PositionMapper>;
    canonicalModuleSource?(source: string): string | undefined;
  } | undefined,
): PositionMapper {
  return (file, line, col) => {
    const mapped = harness?.mapPosition(file, line, col) ?? null;
    if (!mapped?.source) return mapped;
    const canonical = harness?.canonicalModuleSource?.(mapped.source);
    return canonical ? { ...mapped, source: canonical } : mapped;
  };
}

const INTERNAL_SOURCE_LOCATION_FRAME_PATTERNS = [
  /\bgetExternalSourceLocation\b/,
  /\bannotateFunctionDebugMetadata\b/,
  /\bcreateNodeFactory\b/,
  /\bcreateNodeFactoryForRoot\b/,
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
  return createNodeFactoryForRoot(
    moduleSpec,
    {},
    readFrameworkProvidedPaths(moduleSpec.implementation),
  );
}

function createNodeFactoryForRoot<T = any, R = any>(
  moduleSpec: Module,
  factoryRootToken: object,
  frameworkProvidedPaths: readonly FrameworkProvidedPath[] = [],
): ModuleFactory<T, R> {
  // Attach source location and preview to function implementations for debugging
  if (typeof moduleSpec.implementation === "function") {
    assertNotInActionExecution("lift");
    const implementation = prepareInspectableImplementation(
      moduleSpec.implementation,
    );
    annotateFunctionDebugMetadata(implementation);
    hardenVerifiedFunction(implementation);
    moduleSpec.implementation = implementation;
  }

  const module: Module & toJSON = {
    ...moduleSpec,
    toJSON: () => moduleToJSON(module),
  };
  // A module with ifc confidentiality on its argument schema should have at least
  // that value on its result schema
  module.resultSchema = applyArgumentIfcToResult(
    module.argumentSchema,
    module.resultSchema,
  );
  const factory = Object.assign((inputs: FactoryInput<T>): Reactive<R> => {
    const outputs = reactive<R>(undefined, module.resultSchema);
    const node: NodeRef = { module, inputs, outputs, frame: getTopFrame() };

    connectInputAndOutputs(node);
    (outputs as OpaqueCell<R>).connect(node);

    return outputs;
  }, module) as ModuleFactory<T, R>;
  factory.asScope = (scope: CellScope) => {
    const derived = createNodeFactoryForRoot<T, R>(
      { ...module, defaultScope: scope },
      factoryRootToken,
      frameworkProvidedPaths,
    );
    noteDerivedCopy(derived, factory);
    return derived;
  };
  // Provenance brand: every node factory (lift / handler / byRef / the list-op
  // factories) is a trusted builder artifact, so a hoisted one registered via
  // `__cfReg` may receive a content-addressed `{ identity, symbol }` reference.
  // Only the trusted builders call `createNodeFactory`, so a `__cf_data`-forged
  // look-alike never acquires the brand. (Patterns brand separately in
  // builder/pattern.ts.)
  brandTrustedBuilderArtifact(factory);
  setFrameworkProvidedPaths(factory, frameworkProvidedPaths);
  bindFactoryRootToken(factory, factoryRootToken);
  registerFabricFactory(factory, "module", () => {
    const ref = getDurableArtifactRefForRootToken(factoryRootToken);
    return {
      kind: "module",
      rootToken: factoryRootToken,
      ...(ref === undefined ? {} : { ref }),
      ...(module.argumentSchema === undefined
        ? {}
        : { argumentSchema: module.argumentSchema }),
      ...(module.resultSchema === undefined
        ? {}
        : { resultSchema: module.resultSchema }),
      ...(module.defaultScope === undefined
        ? {}
        : { defaultScope: module.defaultScope }),
    };
  });
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
  const mapPosition = canonicalizingMapPosition(topFrame?.runtime?.harness);
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
// Function-first form, matching pattern()/handler() convention: the callback
// leads, schemas trail and are optional. The argument/result schemas are plain
// JSONSchema values that are NOT materialized into the callback input type — the
// callback's own (or transformer-inferred) type stands. The no-input form is
// `lift(fn, false)`: argumentSchema:false makes the no-arg application valid
// (the runner's isValidArgument check passes on `argumentSchema === false`),
// which is how computed-origin (zero-capture) lifts lower.
export function lift<T, R>(
  implementation: (input: T) => R,
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
  options?: DeriveSchedulerOptions,
): ModuleFactory<StripCell<T>, R>;
export function lift<T>(
  implementation: (input: T) => any,
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
  options?: DeriveSchedulerOptions,
): ModuleFactory<StripCell<T>, ReturnType<typeof implementation>>;
export function lift<T extends (...args: any[]) => any>(
  implementation: T,
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
  options?: DeriveSchedulerOptions,
): ModuleFactory<StripCell<Parameters<T>[0]>, ReturnType<T>>;
export function lift<T, R>(
  implementation?: ((input: T) => R) | DeriveSchedulerOptions,
  argumentSchema?: JSONSchema | DeriveSchedulerOptions,
  resultSchema?: JSONSchema | DeriveSchedulerOptions,
  options?: DeriveSchedulerOptions,
): ModuleFactory<T, R> {
  const resolvedImplementation =
    (typeof implementation === "function" ? implementation : undefined) as
      | ((input: T) => R)
      | undefined;
  const resolvedArgumentSchema = argumentSchema as JSONSchema | undefined;
  const resolvedResultSchema = resultSchema as JSONSchema | undefined;
  const frameworkProvidedPaths = readFrameworkProvidedPaths(
    resolvedImplementation,
  );

  const factory = createNodeFactory({
    type: "javascript",
    implementation: resolvedImplementation,
    ...(resolvedArgumentSchema !== undefined
      ? { argumentSchema: resolvedArgumentSchema }
      : {}),
    ...(resolvedResultSchema !== undefined
      ? { resultSchema: resolvedResultSchema }
      : {}),
    ...(options?.materializerWriteInputPaths
      ? { materializerWriteInputPaths: options.materializerWriteInputPaths }
      : {}),
    ...(options?.completeSchedulerScopeSummary
      ? { completeSchedulerScopeSummary: true as const }
      : {}),
  });
  setFrameworkProvidedPaths(factory, frameworkProvidedPaths);
  return factory;
}

interface DeriveSchedulerOptions {
  materializerWriteInputPaths?: readonly (readonly string[])[];
  completeSchedulerScopeSummary?: true;
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

  const factoryEventSchema = eventSchema as JSONSchema | undefined;
  const factoryContextSchema = stateSchema as JSONSchema | undefined;
  const frameworkProvidedPaths = readFrameworkProvidedPaths(handler);
  const factoryRootToken = {};

  // Attach source location and preview to handler function for debugging
  if (typeof handler === "function") {
    assertNotInActionExecution("handler");
    handler = prepareInspectableImplementation(handler);
    annotateFunctionDebugMetadata(handler);
    hardenVerifiedFunction(handler);
  }

  const schema = generateHandlerSchema(
    eventSchema,
    stateSchema as JSONSchema | undefined,
  );

  const module: Handler<T, E> & toJSON & {
    bind: (inputs: FactoryInput<StripCell<T>>) => Stream<E>;
  } = {
    type: "javascript",
    implementation: handler,
    wrapper: "handler",
    with: (inputs: FactoryInput<StripCell<T>>) => factory(inputs),
    // Overriding the default `bind` method on functions. The wrapper will bind
    // the actual inputs, so they'll be available as `this`
    bind: (inputs: FactoryInput<StripCell<T>>) => factory(inputs),
    toJSON: () => moduleToJSON(module),
    ...(schema !== undefined && { argumentSchema: schema }),
    ...(writableProxy && { writableProxy: true }),
  };

  const factory = Object.assign(
    (props: FactoryInput<StripCell<T>>): Stream<E> => {
      // If the event schema is false, we actually set it to true here, since
      // otherwise we won't think it needs to be handled. Ditto for state.
      // TODO(@ubik2): I should be able to remove this workaround, but the stream
      // handler wasn't being triggered. This is a temporary workaround.
      const flexibleEventSchema = eventSchema
        ? eventSchema
        : true as JSONSchema;
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
    },
    module,
  );

  // Provenance brand, like every factory from `createNodeFactory` (whose
  // comment always claimed handler coverage — handler factories are built
  // here and bypassed it): only a branded artifact may acquire a
  // content-addressed `{ identity, symbol }` reference via `__cfReg`
  // indexing, and a non-exported handler's `$implRef`/CFC provenance depends
  // on exactly that registration.
  brandTrustedBuilderArtifact(factory);
  setFrameworkProvidedPaths(factory, frameworkProvidedPaths);
  bindFactoryRootToken(factory, factoryRootToken);

  return registerFabricFactory(factory, "handler", () => {
    const ref = getDurableArtifactRefForRootToken(factoryRootToken);
    return {
      kind: "handler",
      rootToken: factoryRootToken,
      ...(ref === undefined ? {} : { ref }),
      ...(factoryContextSchema === undefined
        ? {}
        : { contextSchema: factoryContextSchema }),
      ...(factoryEventSchema === undefined
        ? {}
        : { eventSchema: factoryEventSchema }),
    };
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
  return handlerInternal(eventSchema, stateSchema, handler);
}

// unsafe closures: doesn't need any arguments.
// Uses argumentSchema: false to signal "takes no input" so the action
// validation doesn't skip it due to undefined arguments.
export const computed: <T>(fn: () => T) => Reactive<T> = <T>(fn: () => T) =>
  createNodeFactory<any, T>({
    type: "javascript",
    implementation: fn,
    argumentSchema: false,
  })(undefined);

/**
 * Records one operand of an `assert` body and returns it unchanged.
 *
 * The value is rendered here, while it is still the resolved value the body
 * computed. The array is local to a single evaluation of the body and is
 * discarded unless the assertion fails.
 */
export const assertCapture = <T>(
  parts: AssertPart[],
  src: string,
  value: T,
): T => {
  parts.push({ src, rendered: toCompactDebugString(value) });
  return value;
};

/**
 * assert: a `computed` for pattern-test assertions that reports its operands.
 *
 * The assert-diagnostics transformer rewrites the body to record each operand
 * and to return an `AssertRecord`, so this implementation is reached only when
 * a source opts out of the transform. It produces the same record shape with
 * no operands recorded, so the declared type holds either way.
 */
export const assert: (fn: () => boolean) => Reactive<AssertRecord> = (
  fn: () => boolean,
) =>
  createNodeFactory<any, AssertRecord>({
    type: "javascript",
    implementation: () => ({ ok: fn(), source: "", parts: [] }),
    argumentSchema: false,
  })(undefined);

/**
 * action: Creates a handler that doesn't use the state parameter.
 *
 * This is to handler as computed is to lift:
 * - User writes: action((e) => count.set(e.data))
 * - Transformer rewrites to: handler((e, { count }) => count.set(e.data))({ count })
 *
 * The transformer extracts closures and makes them explicit, just like how
 * computed(() => expr) becomes a lift-applied computation with closure
 * extraction.
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

/**
 * TEST-ONLY seam. When set, the registered transform replaces the location
 * string that {@link annotateFunctionDebugMetadata} writes to the debug
 * `.src`/`name` annotation. It lets a test deliberately *garble* `.src` to
 * prove that scheduler action ids and the durable implementation fingerprint
 * are independent of `.src` (re-rooted onto content-addressed
 * `{ identity, symbol }` provenance — see
 * docs/specs/content-addressed-action-identity.md and
 * test/src-garble-identity-invariant.test.ts). It is also the natural gate for
 * deferring annotation entirely (the lazy/debug-only `.src` follow-up). Never
 * set in production.
 */
let srcAnnotationTransformForTest: ((location: string) => string) | undefined;

export function __setSrcAnnotationTransformForTest(
  transform: ((location: string) => string) | undefined,
): void {
  srcAnnotationTransformForTest = transform;
}

/**
 * Gate for the eager per-primitive source-location resolution. Default OFF.
 *
 * Resolving `.src` for every lift/handler/computed at module-eval —
 * `getExternalSourceLocation` (a `new Error().stack` capture per primitive) plus
 * the source-map walk in `resolveLocationFromFunctionSource` — is the boot
 * floor's #1 cost (~83ms across the full system-app module graph). `.src` /
 * `.name` / `.sourceLocationSample` are now DEBUG-ONLY: scheduler identity and
 * CFC verified-identity were re-rooted off `.src` (content-addressed
 * `{ identity, symbol }` provenance — see cfc/implementation-identity.ts and the
 * `src-garble-identity-invariant` harness), so nothing load-bearing reads them.
 * With this OFF the resolution is skipped and that cost is not paid; `.preview`
 * (a cheap `fn.toString` slice) is always kept.
 *
 * Enablement: shell DEVELOPMENT builds turn this on by default (so `.src`
 * debugging keeps working locally — `ENVIRONMENT === "development"` in
 * shell/src/lib/env.ts), production builds leave it off; either is overridable
 * via the `EXPERIMENTAL_EAGER_SOURCE_ANNOTATION` define/env everywhere the
 * experimental flags flow (shell, toolshed, background-piece-service, cf CLI —
 * `ExperimentalOptions.eagerSourceAnnotation`). Tests toggle the ambient flag
 * directly via {@link setEagerSourceAnnotation}; the Runtime constructor only
 * propagates an EXPLICIT option so it never stomps that seam.
 */
let eagerSourceAnnotationEnabled = false;

export function setEagerSourceAnnotation(enabled: boolean): void {
  eagerSourceAnnotationEnabled = enabled;
}

export function isEagerSourceAnnotationEnabled(): boolean {
  return eagerSourceAnnotationEnabled;
}

function annotateFunctionDebugMetadata(
  fn: (...args: any[]) => unknown,
): void {
  if (!Object.isExtensible(fn)) {
    return;
  }

  // Skip the expensive source-location resolution unless debugging is on (the
  // ~83ms boot lever). `.src` is debug-only; identity does not read it.
  if (eagerSourceAnnotationEnabled) {
    const { location, sample } = getExternalSourceLocation();
    const fallbackLocation = location ?? resolveLocationFromFunctionSource(fn);
    // The test-only seam garbles the annotated location (both `.src` and the
    // `name` mirror below); identity must not move as a result.
    const finalLocation = fallbackLocation && srcAnnotationTransformForTest
      ? srcAnnotationTransformForTest(fallbackLocation)
      : fallbackLocation;
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

  // A hardened implementation that already carries verified identity must be
  // returned as-is. Provenance and artifact entry refs are keyed on the
  // function OBJECT (WeakMaps, the anti-spoof design), so the wrapper below is
  // a fresh identity-less function: it serializes body-only with no `$implRef`
  // and re-evaluates bare-SES — module scope gone — on reload (the silent
  // "helper is not a function" unlink; see the helper-unlink investigation
  // record). A registered implementation already passed through a factory
  // once — that is how it was registered — so it already carries its
  // inspectable metadata and loses nothing by skipping the wrap.
  if (
    getVerifiedProvenance(implementation) !== undefined ||
    getArtifactEntryRef(implementation) !== undefined
  ) {
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

export function resolveLocationFromFunctionSource(
  fn: (...args: any[]) => unknown,
  frame: Frame | undefined = getTopFrame(),
): string | null {
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
    canonicalizingMapPosition(harness),
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
