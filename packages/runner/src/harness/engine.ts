import { Console } from "./console.ts";
import {
  type CompileResult,
  type Exports,
  Harness,
  HarnessedFunction,
  RuntimeProgram,
  TypeScriptHarnessProcessOptions,
} from "./types.ts";
import {
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  JsScript,
  type MappedPosition,
  Program,
  ProgramResolver,
  Source,
  TypeScriptCompiler,
} from "@commonfabric/js-compiler";
import {
  CommonFabricTransformerPipeline,
  OpaqueRefErrorTransformer,
} from "@commonfabric/ts-transformers";
import { getLogger } from "@commonfabric/utils/logger";
import { Runtime } from "../runtime.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { StaticCache } from "@commonfabric/static";
import { pretransformProgram } from "./pretransform.ts";
import { popFrame, pushFrame } from "../builder/pattern.ts";
import {
  createModuleCompartmentGlobals,
  createSafeConsoleGlobal,
  ensureSESLockdown,
  evaluateCallbackSourceInSES,
  getRuntimeModuleExports,
  getRuntimeModuleTypes,
  isRuntimeModuleIdentifier,
  RuntimeModuleIdentifiers,
  SESIsolate,
  SESRuntime,
} from "../sandbox/mod.ts";
import {
  BundlePreflightError,
  preflightParsedCompiledBundle,
} from "../sandbox/bundle-preflight.ts";
import {
  CompiledJsParseError,
  parseCompiledBundleSource,
} from "../sandbox/compiled-js-parser.ts";
import { verifyParsedCompiledBundleModuleFactoriesWithParser } from "../sandbox/compiled-bundle-verifier.ts";

const INJECTED_SCRIPT = "const console = globalThis.console;";
const logger = getLogger("engine");

// Extends a TypeScript program with 3P module types, if referenced.
export class EngineProgramResolver extends InMemoryProgram {
  private runtimeModuleTypes: Record<string, string> | undefined;
  private cache: StaticCache;
  constructor(program: Program, cache: StaticCache) {
    const modules = program.files.reduce((mod, file) => {
      mod[file.name] = file.contents;
      return mod;
    }, {} as Record<string, string>);
    super(program.main, modules);
    this.cache = cache;
  }

  // Add `.d.ts` files for known supported 3P modules.
  override async resolveSource(
    identifier: string,
  ): Promise<Source | undefined> {
    if (identifier.endsWith(".d.ts")) {
      const origSource = identifier.substring(0, identifier.length - 5);
      if (
        isRuntimeModuleIdentifier(origSource)
      ) {
        if (!this.runtimeModuleTypes) {
          this.runtimeModuleTypes = await Engine.getRuntimeModuleTypes(
            this.cache,
          );
        }
        if (
          origSource in this.runtimeModuleTypes &&
          this.runtimeModuleTypes[origSource]
        ) {
          return {
            name: identifier,
            contents: this.runtimeModuleTypes[origSource],
          };
        }
      }
    }
    return super.resolveSource(identifier);
  }
}

interface Internals {
  compiler: TypeScriptCompiler;
  runtime: SESRuntime;
  isolate: SESIsolate;
  runtimeExports: Record<string, any> | undefined;
  // Callback will be called with a map of exported values to `RuntimeProgram`
  // after compilation and initial eval and before compilation returns, so
  // before any e.g. pattern would be instantiated.
  exportsCallback: (exports: Map<any, RuntimeProgram>) => void;
}

export class Engine extends EventTarget implements Harness {
  private internals: Internals | undefined;
  private ctRuntime: Runtime;
  private verifiedBundleHashes = new Set<string>();
  private readonly loadIds = new WeakMap<JsScript, string>();
  private nextLoadId = 0;
  private readonly verifiedFunctions = new Map<
    string,
    Map<string, HarnessedFunction>
  >();
  private readonly verifiedFunctionIndex = new Map<string, HarnessedFunction>();
  private readonly patternFunctions = new Map<
    string,
    Map<string, HarnessedFunction>
  >();
  private consoleShim = createSafeConsoleGlobal(new Console(this));

  constructor(ctRuntime: Runtime) {
    super();
    this.ctRuntime = ctRuntime;
  }

  async initialize() {
    const environmentTypes = await Engine.getEnvironmentTypes(
      this.ctRuntime.staticCache,
    );
    const compiler = new TypeScriptCompiler(environmentTypes);
    ensureSESLockdown();
    const runtime = new SESRuntime({
      globals: createModuleCompartmentGlobals({
        console: this.consoleShim,
      }),
      lockdown: false,
    });
    const isolate = runtime.getIsolate("");
    const { runtimeExports, exportsCallback } = await getRuntimeModuleExports();
    return { compiler, runtime, isolate, runtimeExports, exportsCallback };
  }

  // Resolve a `ProgramResolver` into a `Program`.
  async resolve(program: ProgramResolver): Promise<RuntimeProgram> {
    const { compiler } = await this.getInternals();
    logger.timeStart("resolve");
    try {
      return await compiler.resolveProgram(program, {
        runtimeModules: Engine.runtimeModuleNames(),
      });
    } finally {
      logger.timeEnd("resolve");
    }
  }

  // Compile source to JS without evaluation.
  async compile(
    program: RuntimeProgram,
    options: TypeScriptHarnessProcessOptions = {},
  ): Promise<CompileResult> {
    logger.timeStart("compile");
    try {
      const id = options.identifier ?? computeId(program);
      const filename = options.filename ?? `${id}.js`;
      const mappedProgram = pretransformProgram(program, id);
      const resolver = new EngineProgramResolver(
        mappedProgram,
        this.ctRuntime.staticCache,
      );

      const { compiler } = await this.getInternals();
      const resolvedProgram = await this.resolve(resolver);

      const diagnosticMessageTransformer = new OpaqueRefErrorTransformer({
        verbose: options.verboseErrors,
      });

      logger.timeStart("compile", "typescript");
      let jsScript: JsScript;
      try {
        jsScript = await compiler.compile(resolvedProgram, {
          filename,
          noCheck: options.noCheck,
          injectedScript: INJECTED_SCRIPT,
          runtimeModules: Engine.runtimeModuleNames(),
          bundleExportAll: true,
          getTransformedProgram: (nextProgram) => {
            options.getTransformedProgram?.(nextProgram);
          },
          diagnosticMessageTransformer,
          beforeTransformers: (program) => {
            const pipeline = new CommonFabricTransformerPipeline();
            return {
              factories: pipeline.toFactories(program),
              getDiagnostics: () => pipeline.getDiagnostics(),
            };
          },
        });
      } finally {
        logger.timeEnd("compile", "typescript");
      }

      this.verifyCompiledBundle(jsScript, filename);

      return { id, jsScript };
    } finally {
      logger.timeEnd("compile");
    }
  }

  // Evaluate pre-compiled JS, returning exports.
  // `id` is the content-derived prefix from compile(); `files` are the
  // original source files for the export map.
  async evaluate(
    id: string,
    jsScript: JsScript,
    files: Source[],
  ): Promise<{ main?: Exports; exportMap?: Record<string, Exports> }> {
    logger.timeStart("evaluate");
    try {
      this.verifyCompiledBundle(jsScript, `${id}.js`);
      const { isolate, runtimeExports, exportsCallback } = await this
        .getInternals();
      const loadId = this.getLoadId(id, jsScript);
      const runtimeDeps = this.createRuntimeDeps(runtimeExports ?? {});
      const sourceLocationFrame = pushFrame({
        runtime: this.ctRuntime,
        sourceLocationContext: {
          script: jsScript.js,
          filename: jsScript.filename ?? `${loadId}.js`,
          nextSearchOffset: 0,
        },
      });
      let result;
      try {
        result = isolate.execute(jsScript).invoke(runtimeDeps).inner();
      } finally {
        popFrame(sourceLocationFrame);
      }
      if (
        result && typeof result === "object" && "main" in result &&
        "exportMap" in result
      ) {
        const main = result.main as Exports;
        const exportMap = result.exportMap as Record<string, Exports>;
        this.resetVerifiedFunctions(loadId);
        this.recordVerifiedFunctions(loadId, main);
        this.recordVerifiedFunctions(loadId, exportMap);

        // Create a map from exported values to `RuntimeProgram` that can
        // generate them and pass to the callback from the exports.
        const exportsByValue = new Map<any, RuntimeProgram>();
        const prefix = `/${id}`;
        for (let [fileName, exports] of Object.entries(exportMap)) {
          if (fileName.startsWith(prefix)) {
            fileName = fileName.substring(prefix.length);
          }
          for (const [exportName, exportValue] of Object.entries(exports)) {
            exportsByValue.set(exportValue, {
              main: fileName,
              mainExport: exportName,
              // TODO(seefeld): Sending all `files` is sub-optimal, as
              // it is the super set of files actually needed by main. We should
              // only send the files actually needed by main.
              files,
            });
          }
        }
        exportsCallback(exportsByValue);

        return { main, exportMap };
      }
      return {};
    } finally {
      logger.timeEnd("evaluate");
    }
  }

  // Invokes a function that should've came from this isolate (unverifiable).
  // We use this to hook into the isolate's source mapping functionality.
  invoke(fn: () => any): any {
    // Scheduler dictates this is a synchronous function,
    // and if we have functions from this source, this should already
    // be set up.
    // Some tests invoke values outside of this isolate, so just
    // execute and return if internals have not been initialized.
    if (!this.internals) {
      return fn();
    }
    return this.internals.isolate.value(fn).invoke().inner();
  }

  getInvocation(source: string): HarnessedFunction {
    return evaluateCallbackSourceInSES(source) as HarnessedFunction;
  }

  getVerifiedFunction(
    implementationRef: string,
    patternId?: string,
  ): HarnessedFunction | undefined {
    if (patternId) {
      const registry = this.patternFunctions.get(patternId);
      if (registry?.has(implementationRef)) {
        return registry.get(implementationRef);
      }
    }
    return this.verifiedFunctionIndex.get(implementationRef);
  }

  associatePattern(patternId: string, value: unknown): void {
    const registry = new Map<string, HarnessedFunction>();
    this.collectAssociatedFunctions(value, registry, new Set());
    this.patternFunctions.set(patternId, registry);
  }

  // Map a single position to its original source location.
  // Returns null if no source map is loaded for the filename.
  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    if (!this.internals) return null;
    return this.internals.isolate.mapPosition(filename, line, column);
  }

  // Parse an error stack trace, mapping all positions back to original sources.
  // Returns the original stack if internals haven't been initialized.
  parseStack(stack: string): string {
    if (!this.internals) {
      return stack;
    }
    return this.internals.isolate.parseStack(stack);
  }

  // Returns a map of runtime module types.
  static getRuntimeModuleTypes(cache: StaticCache) {
    return getRuntimeModuleTypes(cache);
  }

  static getEnvironmentTypes(cache: StaticCache) {
    return getTypeScriptEnvironmentTypes(cache);
  }

  static runtimeModuleNames() {
    return [...RuntimeModuleIdentifiers];
  }

  private async getInternals(): Promise<Internals> {
    if (!this.internals) {
      this.internals = await this.initialize();
    }
    return this.internals;
  }

  /**
   * Clean up resources held by the engine.
   * Clears accumulated source maps and other state to prevent memory leaks.
   */
  dispose(): void {
    if (this.internals) {
      // Clear the SES runtime state which holds accumulated source maps
      this.internals.runtime.clear();

      // Clear references to allow GC
      this.internals = undefined;
    }
    this.verifiedFunctions.clear();
    this.verifiedFunctionIndex.clear();
    this.patternFunctions.clear();
    this.verifiedBundleHashes.clear();
  }

  private verifyCompiledBundle(jsScript: JsScript, fallbackFilename: string) {
    const bundleHash = hashOf(jsScript.js).toString();
    if (this.verifiedBundleHashes.has(bundleHash)) {
      return;
    }

    const filename = jsScript.filename ?? fallbackFilename;
    logger.timeStart("verifyCompiledBundle");
    try {
      logger.timeStart("verifyCompiledBundle", "parseBundle");
      const parsedBundle = (() => {
        try {
          return parseCompiledBundleSource(jsScript.js);
        } catch (error) {
          if (error instanceof CompiledJsParseError) {
            throw new BundlePreflightError(`${filename}: ${error.message}`);
          }
          throw error;
        } finally {
          logger.timeEnd("verifyCompiledBundle", "parseBundle");
        }
      })();

      logger.timeStart("verifyCompiledBundle", "preflight");
      try {
        preflightParsedCompiledBundle(parsedBundle, filename);
      } finally {
        logger.timeEnd("verifyCompiledBundle", "preflight");
      }

      logger.timeStart("verifyCompiledBundle", "moduleFactories");
      try {
        verifyParsedCompiledBundleModuleFactoriesWithParser(
          jsScript.js,
          parsedBundle,
          filename,
        );
      } finally {
        logger.timeEnd("verifyCompiledBundle", "moduleFactories");
      }

      this.verifiedBundleHashes.add(bundleHash);
    } finally {
      logger.timeEnd("verifyCompiledBundle");
    }
  }

  private getLoadId(compileId: string, jsScript: JsScript): string {
    const existing = this.loadIds.get(jsScript);
    if (existing) {
      return existing;
    }

    const loadId = `${compileId}:load:${this.nextLoadId++}`;
    this.loadIds.set(jsScript, loadId);
    return loadId;
  }

  private createRuntimeDeps(
    runtimeExports: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.freeze({
      ...runtimeExports,
      __ctAmdHooks: Object.freeze({
        define: (moduleId: string) => {
          if (typeof moduleId !== "string" || moduleId.length === 0) {
            throw new Error("AMD define() requires a non-empty string id");
          }
        },
        require: (dependency: string[] | string) => {
          if (Array.isArray(dependency)) {
            throw new Error("AMD async require() is not allowed in SES mode");
          }
        },
      }),
    });
  }

  private recordVerifiedFunctions(
    loadId: string,
    value: unknown,
    seen = new Set<unknown>(),
  ): void {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (
      typeof value === "object" &&
      value !== null &&
      "implementationRef" in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>).implementationRef ===
        "string" &&
      "implementation" in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>).implementation === "function"
    ) {
      let registry = this.verifiedFunctions.get(loadId);
      if (!registry) {
        registry = new Map();
        this.verifiedFunctions.set(loadId, registry);
      }
      const implementationRef = (value as Record<string, unknown>)
        .implementationRef as string;
      const implementation = (value as Record<string, unknown>)
        .implementation as HarnessedFunction;
      registry.set(implementationRef, implementation);
      this.verifiedFunctionIndex.set(implementationRef, implementation);
    }

    if (typeof value === "function") {
      const implementationRef = (value as { implementationRef?: string })
        .implementationRef;
      if (implementationRef) {
        let registry = this.verifiedFunctions.get(loadId);
        if (!registry) {
          registry = new Map();
          this.verifiedFunctions.set(loadId, registry);
        }
        registry.set(implementationRef, value as HarnessedFunction);
        this.verifiedFunctionIndex.set(
          implementationRef,
          value as HarnessedFunction,
        );
      }
    }

    for (const key of Reflect.ownKeys(value as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
      if (!descriptor || !("value" in descriptor)) {
        continue;
      }
      this.recordVerifiedFunctions(loadId, descriptor.value, seen);
    }
  }

  private resetVerifiedFunctions(loadId: string): void {
    const existing = this.verifiedFunctions.get(loadId);
    if (existing) {
      for (const implementationRef of existing.keys()) {
        const replacement = this.findVerifiedFunctionInOtherLoads(
          loadId,
          implementationRef,
        );
        if (replacement) {
          this.verifiedFunctionIndex.set(implementationRef, replacement);
        } else {
          this.verifiedFunctionIndex.delete(implementationRef);
        }
      }
    }
    this.verifiedFunctions.set(loadId, new Map());
  }

  private findVerifiedFunctionInOtherLoads(
    loadId: string,
    implementationRef: string,
  ): HarnessedFunction | undefined {
    let replacement: HarnessedFunction | undefined;
    for (const [otherLoadId, registry] of this.verifiedFunctions) {
      if (otherLoadId === loadId) {
        continue;
      }
      const candidate = registry.get(implementationRef);
      if (candidate) {
        replacement = candidate;
      }
    }
    return replacement;
  }

  private collectAssociatedFunctions(
    value: unknown,
    registry: Map<string, HarnessedFunction>,
    seen: Set<unknown>,
  ): void {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    const associated = this.extractAssociatedFunction(value);
    if (associated) {
      registry.set(associated.implementationRef, associated.implementation);
    }

    for (const key of Reflect.ownKeys(value as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
      if (!descriptor || !("value" in descriptor)) {
        continue;
      }
      this.collectAssociatedFunctions(descriptor.value, registry, seen);
    }
  }

  private extractAssociatedFunction(
    value: unknown,
  ): { implementationRef: string; implementation: HarnessedFunction } | null {
    if (typeof value === "function") {
      const implementationRef = (value as { implementationRef?: string })
        .implementationRef;
      return implementationRef
        ? {
          implementationRef,
          implementation: value as HarnessedFunction,
        }
        : null;
    }

    const record = value as {
      implementationRef?: string;
      implementation?: unknown;
    };
    if (typeof record.implementationRef !== "string") {
      return null;
    }
    if (typeof record.implementation === "function") {
      return {
        implementationRef: record.implementationRef,
        implementation: record.implementation as HarnessedFunction,
      };
    }

    const rebound = this.verifiedFunctionIndex.get(record.implementationRef);
    return rebound
      ? { implementationRef: record.implementationRef, implementation: rebound }
      : null;
  }
}

function computeId(program: Program): string {
  const source = [
    program.main,
    ...program.files.filter(({ name }) => !name.endsWith(".d.ts")),
  ];
  return hashOf(source).toString();
}
