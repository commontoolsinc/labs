import { Console } from "./console.ts";
import {
  type CompileResult,
  type Exports,
  type Harness,
  type HarnessedFunction,
  type RuntimeProgram,
  type TypeScriptHarnessProcessOptions,
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
  ensureSESLockdown,
  getRuntimeModuleExports,
  getRuntimeModuleTypes,
  isRuntimeModuleIdentifier,
  RuntimeModuleIdentifiers,
  SESRuntime,
} from "../sandbox/mod.ts";
import {
  createModuleCompartmentGlobals,
  createSafeConsoleGlobal,
} from "../sandbox/compartment-globals.ts";
import { setVerifiedFunctionRegistrar } from "../sandbox/function-hardening.ts";
import type { UnsafeHostTrustOptions } from "../unsafe-host-trust.ts";
import { ExecutableRegistry } from "./executable-registry.ts";
import { CompiledBundleValidator } from "../sandbox/compiled-bundle-validation.ts";

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
  runtimeExports: Record<string, any> | undefined;
  // Callback will be called with a map of exported values to `RuntimeProgram`
  // after compilation and initial eval and before compilation returns, so
  // before any e.g. pattern would be instantiated.
  exportsCallback: (exports: Map<any, RuntimeProgram>) => void;
}

export interface EngineOptions {
  hideInternalStackFrames?: boolean;
}

export class Engine extends EventTarget implements Harness {
  private internals: Internals | undefined;
  private ctRuntime: Runtime;
  private sesRuntime: SESRuntime | undefined;
  private loadIds = new WeakMap<JsScript, string>();
  private nextLoadId = 0;
  private readonly bundleValidator = new CompiledBundleValidator();
  private readonly executableRegistry = new ExecutableRegistry();
  private readonly consoleShim = createSafeConsoleGlobal(new Console(this));

  constructor(
    ctRuntime: Runtime,
    private readonly options: EngineOptions = {},
  ) {
    super();
    this.ctRuntime = ctRuntime;
  }

  async initialize() {
    const environmentTypes = await Engine.getEnvironmentTypes(
      this.ctRuntime.staticCache,
    );
    const compiler = new TypeScriptCompiler(environmentTypes);
    const runtime = this.getSESRuntime();
    const { runtimeExports, exportsCallback } = await getRuntimeModuleExports();
    return { compiler, runtime, runtimeExports, exportsCallback };
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

      this.bundleValidator.verify(jsScript, filename);

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
  ): Promise<
    { main?: Exports; exportMap?: Record<string, Exports>; loadId?: string }
  > {
    logger.timeStart("evaluate");
    try {
      this.bundleValidator.verify(jsScript, `${id}.js`);
      const { runtime, runtimeExports, exportsCallback } = await this
        .getInternals();
      const loadId = this.getLoadId(id, jsScript);
      this.executableRegistry.beginVerifiedLoad(loadId);
      const isolate = runtime.getIsolate(loadId);
      const runtimeDeps = this.createRuntimeDeps(runtimeExports ?? {});
      const restoreVerifiedFunctionRegistrar = setVerifiedFunctionRegistrar(
        this.executableRegistry.createVerifiedFunctionRegistrar(loadId),
      );
      const sourceLocationFrame = pushFrame({
        runtime: this.ctRuntime,
        verifiedLoadId: loadId,
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
        restoreVerifiedFunctionRegistrar();
      }
      if (
        result && typeof result === "object" && "main" in result &&
        "exportMap" in result
      ) {
        const main = result.main as Exports;
        const exportMap = result.exportMap as Record<string, Exports>;
        this.executableRegistry.captureVerifiedValue(loadId, main);
        this.executableRegistry.captureVerifiedValue(loadId, exportMap);

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

        return { main, exportMap, loadId };
      }
      return { loadId };
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
    if (!this.internals && !this.sesRuntime) {
      return fn();
    }
    return this.getSESRuntime().getIsolate("__engine-invoke__").value(fn)
      .invoke().inner();
  }

  getInvocation(source: string): HarnessedFunction {
    return this.getSESRuntime().evaluateCallback(source) as HarnessedFunction;
  }

  registerVerifiedFunction(
    loadId: string,
    implementationRef: string,
    implementation: HarnessedFunction,
  ): void {
    this.executableRegistry.registerVerifiedFunction(
      loadId,
      implementationRef,
      implementation,
    );
  }

  getVerifiedFunction(
    implementationRef: string,
    patternId?: string,
  ): HarnessedFunction | undefined {
    return this.executableRegistry.getVerifiedFunction(
      implementationRef,
      patternId,
    );
  }

  getVerifiedFunctionInLoad(
    loadId: string,
    implementationRef: string,
  ): HarnessedFunction | undefined {
    return this.executableRegistry.getVerifiedFunctionInLoad(
      loadId,
      implementationRef,
    );
  }

  getVerifiedLoadId(
    implementationRef: string,
    patternId?: string,
  ): string | undefined {
    return this.executableRegistry.getVerifiedLoadId(
      implementationRef,
      patternId,
    );
  }

  getExecutableFunction(
    implementationRef: string,
    patternId?: string,
  ): HarnessedFunction | undefined {
    return this.executableRegistry.getExecutableFunction(
      implementationRef,
      patternId,
    );
  }

  associatePattern(patternId: string, value: unknown, loadId?: string): void {
    this.executableRegistry.associatePattern(patternId, value, loadId);
  }

  unsafeTrustHostValue(
    value: unknown,
    options: UnsafeHostTrustOptions,
  ): void {
    this.executableRegistry.trustHostValue(value, options);
  }

  // Map a single position to its original source location.
  // Returns null if no source map is loaded for the filename.
  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    if (!this.internals) return null;
    return this.internals.runtime.mapPosition(filename, line, column);
  }

  // Parse an error stack trace, mapping all positions back to original sources.
  // Returns the original stack if internals haven't been initialized.
  parseStack(stack: string): string {
    if (!this.internals) {
      return stack;
    }
    return this.internals.runtime.parseStack(stack);
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
    if (this.sesRuntime) {
      this.sesRuntime.clear();
    }
    this.sesRuntime = undefined;
    this.internals = undefined;
    this.loadIds = new WeakMap();
    this.nextLoadId = 0;
    this.executableRegistry.clear();
    this.bundleValidator.clear();
  }

  private getSESRuntime(): SESRuntime {
    if (!this.sesRuntime) {
      ensureSESLockdown();
      this.sesRuntime = new SESRuntime({
        globals: createModuleCompartmentGlobals({
          console: this.consoleShim,
        }),
        hideInternalStackFrames: this.options.hideInternalStackFrames,
        lockdown: false,
      });
    }
    return this.sesRuntime;
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
      __cfAmdHooks: Object.freeze({
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
}

function computeId(program: Program): string {
  const source = [
    program.main,
    ...program.files.filter(({ name }) => !name.endsWith(".d.ts")),
  ];
  return hashOf(source).toString();
}
