import { Console } from "./console.ts";
import {
  type CacheableModule,
  type CompileResult,
  type EvaluateOptions,
  type EvaluateResult,
  type Exports,
  type Harness,
  type HarnessedFunction,
  type RuntimeProgram,
  type TypeScriptHarnessProcessOptions,
} from "./types.ts";
import {
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  type JsScript,
  type MappedPosition,
  type Program,
  type ProgramResolver,
  type Source,
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
import {
  pretransformProgram,
  pretransformProgramForModules,
} from "./pretransform.ts";
import {
  computeModuleHashes,
  resolveModuleImports,
} from "./module-identity.ts";
import {
  buildRecordsFromCompiled,
  type CachedCompiledModule,
  type CompiledModuleGraph,
  compileSourcesToRecords,
  computeModuleIdentities,
} from "../sandbox/module-record-compiler.ts";
import {
  composeBundleSourceMap,
  type SourceMap,
} from "@commonfabric/js-compiler";
import {
  loadModuleGraph,
  runtimeModuleRecords,
  type VirtualModuleRecord,
} from "../sandbox/esm-module-loader.ts";
import {
  verifyCompiledModuleBody,
  verifyModuleGraph,
} from "../sandbox/module-record-verifier.ts";
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
    if (!this.runtimeModuleTypes) {
      this.runtimeModuleTypes = await Engine.getRuntimeModuleTypes(
        this.cache,
      );
    }
    if (
      !isRuntimeModuleIdentifier(identifier) &&
      identifier in this.runtimeModuleTypes &&
      this.runtimeModuleTypes[identifier]
    ) {
      return {
        name: identifier,
        contents: this.runtimeModuleTypes[identifier],
      };
    }
    if (identifier.endsWith(".d.ts")) {
      const origSource = identifier.substring(0, identifier.length - 5);
      if (
        isRuntimeModuleIdentifier(origSource)
      ) {
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

interface RuntimeInternals {
  runtime: SESRuntime;
  runtimeExports: Record<string, any> | undefined;
  // Callback will be called with a map of exported values to `RuntimeProgram`
  // after compilation and initial eval and before compilation returns, so
  // before any e.g. pattern would be instantiated.
  exportsCallback: (exports: Map<any, RuntimeProgram>) => void;
}

interface CompilerInternals {
  compiler: TypeScriptCompiler;
}

export interface EngineOptions {
  hideInternalStackFrames?: boolean;
}

export class Engine extends EventTarget implements Harness {
  private runtimeInternals: RuntimeInternals | undefined;
  private compilerInternals: CompilerInternals | undefined;
  private ctRuntime: Runtime;
  private sesRuntime: SESRuntime | undefined;
  private loadIds = new WeakMap<JsScript, string>();
  private nextLoadId = 0;
  // Content-addressed module hash per prefixed source path (`/<id>/file.tsx`),
  // populated at evaluate() time. Used to translate an action's bundle-relative
  // source location into a stable implementation identity.
  private moduleHashByPrefixedSource = new Map<string, string>();
  // Canonical content-addressed source per prefixed source path, i.e.
  // `/<programHash>/<authoredPath>` -> `cf:module/<moduleHash>/<authoredPath>`.
  // Used to rewrite a function's `src` into a reload-stable identity that does
  // not depend on which bundle/entry-point compiled the module.
  private canonicalSourceByPrefixed = new Map<string, string>();
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

  async initializeRuntime(): Promise<RuntimeInternals> {
    const runtime = this.getSESRuntime();
    const { runtimeExports, exportsCallback } = await getRuntimeModuleExports();
    return { runtime, runtimeExports, exportsCallback };
  }

  async initializeCompiler(): Promise<CompilerInternals> {
    const environmentTypes = await Engine.getEnvironmentTypes(
      this.ctRuntime.staticCache,
    );
    const compiler = new TypeScriptCompiler(environmentTypes);
    return { compiler };
  }

  async initialize(): Promise<RuntimeInternals & CompilerInternals> {
    const [runtimeInternals, compilerInternals] = await Promise.all([
      this.getRuntimeInternals(),
      this.getCompilerInternals(),
    ]);
    return { ...runtimeInternals, ...compilerInternals };
  }

  // Resolve a `ProgramResolver` into a `Program`.
  async resolve(program: ProgramResolver): Promise<RuntimeProgram> {
    const { compiler } = await this.getCompilerInternals();
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

      const { compiler } = await this.getCompilerInternals();
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

      return { id, jsScript, sesValidated: true };
    } finally {
      logger.timeEnd("compile");
    }
  }

  /**
   * Compile a program to a verified ESM module-record graph (the
   * `esmModuleLoader` compile path). Runs the same resolution + CF transformer
   * pipeline as {@link compile}, emits per-module CommonJS via
   * `compileToModules`, assembles content-addressed records (plus runtime-
   * module records), and security-verifies every authored module body with
   * the ESM verifier. Returns the graph and the entry specifier for evaluation.
   */
  async compileToRecordGraph(
    program: RuntimeProgram,
    options: TypeScriptHarnessProcessOptions = {},
  ): Promise<
    {
      id: string;
      graph: CompiledModuleGraph;
      mainSpecifier: string;
      entryIdentity: string;
      modules: CacheableModule[];
    }
  > {
    logger.timeStart("compileToRecordGraph");
    try {
      const id = options.identifier ?? computeId(program);
      const mappedProgram = pretransformProgramForModules(program, id);
      const resolver = new EngineProgramResolver(
        mappedProgram,
        this.ctRuntime.staticCache,
      );
      const resolvedProgram = await this.resolve(resolver);

      // Authored (non-.d.ts) sources are the modules that must have a body.
      const moduleFiles = resolvedProgram.files.filter((f) =>
        !f.name.endsWith(".d.ts")
      );

      // Prefix-free content identity per resolved module path. Computed here
      // (cheap, no TS compile) so the cache-hit check and the write-back
      // descriptors agree with the graph's `cf:module/<hash>` specifiers.
      const identityByPath = computeModuleIdentities(moduleFiles, {
        idPrefix: `/${id}`,
      });
      const entryIdentity = identityByPath.get(mappedProgram.main)!;

      // Cache hit: every emitted module already has a cached compiled body
      // (keyed by identity), so skip the TypeScript compile entirely and build
      // the record graph from the cached bodies. Per-module identities are
      // transitively sensitive, so a partial set cannot be trusted — fall back
      // to a full recompile. The cache is queried by identity (directly, or
      // lazily once identities are known) without leaking the engine's prefix.
      const cached = options.precompiledModules ??
        (options.precompiledModulesFor
          ? await options.precompiledModulesFor({
            entryIdentity,
            identities: [...new Set(identityByPath.values())],
          })
          : undefined);
      const fullHit = cached !== undefined &&
        moduleFiles.every((f) => cached.has(identityByPath.get(f.name)!));

      const precompiledBodies = new Map<string, string>();
      // Carry per-module source maps so the ESM loader can compose a per-load
      // bundle map (CFC verified-source / fn.src coordinate resolution).
      const precompiledSourceMaps = new Map<string, SourceMap>();

      if (fullHit) {
        logger.info("compile-cache-hit", () => ["compileToRecordGraph", id]);
        for (const file of moduleFiles) {
          const artifact = cached!.get(identityByPath.get(file.name)!)!;
          precompiledBodies.set(file.name, artifact.js);
          if (artifact.sourceMap !== undefined) {
            precompiledSourceMaps.set(
              file.name,
              artifact.sourceMap as SourceMap,
            );
          }
        }
      } else {
        const { compiler } = await this.getCompilerInternals();
        const modules = compiler.compileToModules(resolvedProgram, {
          noCheck: options.noCheck,
          runtimeModules: Engine.runtimeModuleNames(),
          beforeTransformers: (program) => {
            const pipeline = new CommonFabricTransformerPipeline();
            return {
              factories: pipeline.toFactories(program),
              getDiagnostics: () => pipeline.getDiagnostics(),
            };
          },
        });

        // Every authored source must have an emitted body; a missing one would
        // otherwise be silently dropped and only fail later at import.
        for (const file of moduleFiles) {
          if (!modules.has(file.name)) {
            throw new Error(
              `ESM compile produced no module body for '${file.name}'`,
            );
          }
        }
        for (const [name, out] of modules) {
          precompiledBodies.set(name, out.js);
          if (out.sourceMap) precompiledSourceMaps.set(name, out.sourceMap);
        }
      }
      const { runtimeExports } = await this.getRuntimeInternals();
      const runtimeNames = Engine.runtimeModuleNames().filter((name) =>
        runtimeExports?.[name]
      );
      const runtimeModulesOption = Object.fromEntries(
        runtimeNames.map((name) => [
          name,
          Object.keys(runtimeExports?.[name] ?? {}),
        ]),
      );
      const graph = compileSourcesToRecords(moduleFiles, {
        precompiledBodies,
        precompiledSourceMaps,
        runtimeModules: runtimeModulesOption,
        // Strip the whole-program `/<id>` prefix from per-module identities so
        // `cf:module/<hash>` is entry-point independent and dedupes across
        // programs (the content-addressed cache keys off these identities).
        idPrefix: `/${id}`,
        // Reuse the identities already computed above (cache-hit check); avoids
        // a second hashing/import-resolution pass over the module set.
        identityByPath,
      });

      // Register runtime-module records so cf:runtime/* imports resolve.
      const runtimeRecordExports: Record<string, Record<string, unknown>> = {};
      for (const name of runtimeNames) {
        runtimeRecordExports[name] = runtimeExports?.[name] as Record<
          string,
          unknown
        >;
      }
      for (
        const [spec, record] of runtimeModuleRecords(runtimeRecordExports)
      ) {
        graph.records.set(spec, record as VirtualModuleRecord);
      }

      // Security-verify every authored module body before it can execute.
      for (const [specifier, body] of graph.compiledBodies) {
        verifyCompiledModuleBody(body, specifier);
      }

      const mainSpecifier = graph.specifierByPath.get(mappedProgram.main);
      if (mainSpecifier === undefined) {
        throw new Error(
          "ESM compile produced no record for the program entry",
        );
      }

      // Structurally verify the whole record graph (content-addressed
      // specifiers, well-formed records, and that every import edge resolves to
      // a content-addressed target). This must run here because the loader is
      // invoked with `verify: false` in evaluateRecordGraph — graph
      // verification happens once, at compile time, before any module executes.
      verifyModuleGraph(graph.records, mainSpecifier);

      // Serializable per-module descriptors for write-back to the cache, in
      // identity space (the engine's `/<id>` path prefix never leaks out). Each
      // carries the resolved TS source (for the source set), the compiled JS
      // (for the compiled set), and the internal import edges as
      // specifier → dependency-identity links. On a cache hit these mirror the
      // artifacts just loaded.
      const importEdges = resolveModuleImports({
        main: "",
        files: moduleFiles,
      });
      const modules: CacheableModule[] = moduleFiles.map((file) => {
        const identity = identityByPath.get(file.name)!;
        const sourceMap = precompiledSourceMaps.get(file.name);
        const imports = (importEdges.get(file.name)?.internalDeps ?? []).map((
          dep,
        ) => ({
          specifier: dep.specifier,
          targetIdentity: identityByPath.get(dep.target)!,
        }));
        return {
          identity,
          filename: stripModuleIdPrefix(file.name, id),
          source: file.contents,
          js: precompiledBodies.get(file.name)!,
          ...(sourceMap === undefined ? {} : { sourceMap }),
          imports,
        };
      });

      return { id, graph, mainSpecifier, entryIdentity, modules };
    } finally {
      logger.timeEnd("compileToRecordGraph");
    }
  }

  /**
   * Cold-recovery path: recompile cacheable modules from the
   * inject-helper-transformed module set already stored in the content-addressed
   * **source set** (`pattern:<identity>` cells), loaded by identity — i.e.
   * recreate the pattern from its stored TypeScript alone. Skips **pretransform**
   * (the source already carries the helper import and prefix-free normalized
   * paths, so re-injecting/re-prefixing would corrupt it and shift identities)
   * but still **resolves** to supply the runtime `.d.ts` type environment the CF
   * transformer needs for schema generation (those types are TCB, from the
   * static cache, not stored per pattern). Used when the compiled set misses
   * (e.g. a runtimeVersion bump invalidates `compileCache:<rtver>/...`).
   *
   * Per-module identities recompute to the same content-addressed values (the
   * module bodies + names are unchanged), so the rebuilt compiled set is
   * addressable — and writable-back — under the new runtimeVersion. Returns the
   * `CacheableModule[]` (feed to {@link evaluateCachedModules}) + entry identity.
   * `entryFilename` is the entry module's normalized path.
   */
  async compileResolvedToRecordGraph(
    resolvedFiles: Source[],
    entryFilename: string,
  ): Promise<{ modules: CacheableModule[]; entryIdentity: string }> {
    const { compiler } = await this.getCompilerInternals();
    // Resolve to add the runtime `.d.ts` type environment, WITHOUT pretransform
    // (no re-inject/re-prefix — the stored source is already transformed).
    const resolver = new EngineProgramResolver(
      { main: entryFilename, files: resolvedFiles },
      this.ctRuntime.staticCache,
    );
    const resolvedProgram = await this.resolve(resolver);
    const moduleFiles = resolvedProgram.files.filter((f) =>
      !f.name.endsWith(".d.ts")
    );
    // Identities recompute prefix-free over the (already-normalized) closure —
    // they match the stored identities the source docs were keyed by.
    const identityByPath = computeModuleIdentities(moduleFiles);

    const emitted = compiler.compileToModules(resolvedProgram, {
      runtimeModules: Engine.runtimeModuleNames(),
      beforeTransformers: (program) => {
        const pipeline = new CommonFabricTransformerPipeline();
        return {
          factories: pipeline.toFactories(program),
          getDiagnostics: () => pipeline.getDiagnostics(),
        };
      },
    });
    for (const file of moduleFiles) {
      if (!emitted.has(file.name)) {
        throw new Error(
          `Recompile from source produced no body for '${file.name}'`,
        );
      }
    }

    const importEdges = resolveModuleImports({ main: "", files: moduleFiles });
    const modules: CacheableModule[] = moduleFiles.map((file) => {
      const out = emitted.get(file.name)!;
      const imports = (importEdges.get(file.name)?.internalDeps ?? []).map((
        dep,
      ) => ({
        specifier: dep.specifier,
        targetIdentity: identityByPath.get(dep.target)!,
      }));
      return {
        identity: identityByPath.get(file.name)!,
        filename: file.name,
        source: file.contents,
        js: out.js,
        ...(out.sourceMap === undefined ? {} : { sourceMap: out.sourceMap }),
        imports,
      };
    });
    const entryIdentity = identityByPath.get(entryFilename)!;
    return { modules, entryIdentity };
  }

  /**
   * Compile + evaluate a program through the ESM module-record path (the
   * `esmModuleLoader` route). Returns the same `{ main, exportMap, loadId }`
   * shape as {@link evaluate}, so callers can branch on the flag and treat the
   * result identically.
   */
  async compileAndEvaluateModules(
    program: RuntimeProgram,
    options: TypeScriptHarnessProcessOptions = {},
  ): Promise<EvaluateResult> {
    // Ensure runtime exports + exportsCallback are initialized.
    await this.getRuntimeInternals();
    const { id, graph, mainSpecifier } = await this.compileToRecordGraph(
      program,
      options,
    );
    return this.evaluateRecordGraph(id, graph, mainSpecifier, program.files);
  }

  /**
   * Evaluate a verified ESM record graph: load it synchronously via `importNow`
   * in a locked-down compartment whose globals are the hardened runtime globals
   * (runtime-module records, already in the graph, supply the trusted host
   * APIs), and return the entry namespace as `main` plus the per-module export
   * map. The graph was security-verified at compile time, so verification is
   * not repeated.
   */
  /**
   * Evaluate a verified ESM record graph (public so the PatternManager can run
   * compile → cache write-back → evaluate as discrete steps). Thin wrapper over
   * {@link evaluateGraph} with the source-compile registration strategy: module
   * identities are recomputed from `files`, paths carry the `/<id>` prefix, and
   * `files` flow into the export map for sub-pattern re-instantiation.
   */
  evaluateRecordGraph(
    id: string,
    graph: CompiledModuleGraph,
    mainSpecifier: string,
    files: Source[],
  ): EvaluateResult {
    const prefix = `/${id}`;
    // Register module hashes up front so the canonical `cf:module/<hash>/<path>`
    // sources are available for the verified set below. Derive them from the
    // graph's RESOLVED per-module identities (the same content-addressed
    // `cf:module/<identity>` the cache + source-free reload use), NOT by
    // re-hashing the raw `files` — those disagree (the resolved set folds the
    // injected modules into each module's Merkle hash), which would make a
    // function's `fn.src` (hence its implementationRef) differ between this
    // source-based compile and a source-free by-identity reload, breaking
    // `getExecutableFunction` for resumed callables (CT-1623).
    this.registerModuleHashesFromGraph(id, graph);
    const verifiedSources = new Set<string>();
    const addVerifiedSource = (value: string | undefined) => {
      if (typeof value !== "string" || value.length === 0) return;
      verifiedSources.add(normalizeVerifiedSource(value));
      if (value.startsWith(`${prefix}/`)) {
        verifiedSources.add(
          normalizeVerifiedSource(value.slice(id.length + 1)),
        );
      }
    };
    for (const file of files) addVerifiedSource(file.name);
    for (const path of graph.specifierByPath.keys()) addVerifiedSource(path);
    // Canonical `cf:module/<hash>/<path>` forms — functions carry these as their
    // `fn.src`, so CFC's isVerifiedSourceInLoad must recognize them too.
    for (const canonical of this.canonicalVerifiedSources(id, files)) {
      addVerifiedSource(canonical);
    }

    return this.evaluateGraph(graph, mainSpecifier, {
      loadIdPrefix: id,
      // Already registered above (idempotent); keep as a no-op so evaluateGraph
      // doesn't recompute the hashes a second time.
      registerHashes: () => {},
      verifiedSources,
      fileNameForPath: (path) =>
        path.startsWith(prefix) ? path.slice(prefix.length) : path,
      filesForExports: files,
    });
  }

  /**
   * Evaluate a record graph. Shared core for both the source-compile path
   * ({@link evaluateRecordGraph}) and the resolve-free cached-load path
   * ({@link evaluateCachedModules}); `ctx` supplies the path/identity handling
   * that differs between them (prefixed authored paths vs prefix-free cached
   * identities). The graph is assumed already security-verified.
   */
  private evaluateGraph(
    graph: CompiledModuleGraph,
    mainSpecifier: string,
    ctx: {
      loadIdPrefix: string;
      registerHashes(): void;
      verifiedSources: Set<string>;
      fileNameForPath(path: string): string;
      filesForExports: Source[];
    },
  ): EvaluateResult {
    logger.timeStart("evaluateRecordGraph");
    try {
      const loadId = `${ctx.loadIdPrefix}:esm:${this.nextLoadId++}`;
      this.executableRegistry.beginVerifiedLoad(loadId);
      // Register per-module content hashes for parity with the AMD evaluate
      // path. This wires the scheduler's content-addressed implementation hash;
      // it becomes effective once source-location resolution under the ESM
      // loader is wired (see the sourceURL note in module-record-compiler.ts).
      ctx.registerHashes();

      const globals = createModuleCompartmentGlobals({
        console: this.consoleShim,
      });
      // Concatenated module bodies give the source-location frame a `script`
      // for fn.src `indexOf` resolution. (Insertion order need not match the
      // import-execution order; resolveLocationFromFunctionSource falls back to
      // a from-zero scan, and any mis-attribution degrades fail-closed at the
      // CFC identity layer — see the fn.src note in the design doc.)
      const script = [...graph.compiledBodies.values()].join("\n");
      this.executableRegistry.setVerifiedLoadBundleId(
        loadId,
        hashOf(script).toString(),
      );
      // Register a composed bundle source map for `${loadId}.js` so that
      // `fn.src` / CFC verified-source coordinates (resolved against `script`)
      // map back to the original authored sources — without this the ESM loader
      // yields raw bundle coordinates and CFC verified-source fails closed.
      // Full module path per specifier (the verified-source set is keyed by
      // these, not the basename the compiler records in the map's `sources`).
      const sourceNameBySpecifier = new Map<string, string>();
      for (const [name, specifier] of graph.specifierByPath) {
        sourceNameBySpecifier.set(specifier, name);
      }
      const bundleSourceMap = composeBundleSourceMap(
        [...graph.compiledBodies].map(([specifier, body]) => ({
          body,
          map: graph.moduleSourceMaps.get(specifier),
          source: sourceNameBySpecifier.get(specifier),
        })),
        `${loadId}.js`,
      );
      if (bundleSourceMap) {
        this.getSESRuntime().loadSourceMap(`${loadId}.js`, bundleSourceMap);
      }
      // ALSO register each module's map under its eval `//# sourceURL` (its
      // sanitized source name). The browser surfaces the per-module eval frame
      // in `new Error().stack`, and `annotateFunctionDebugMetadata` resolves
      // `fn.src` from that frame FIRST (the indexOf-into-`script` fallback that
      // `${loadId}.js` covers only wins when the stack frame is absent, e.g.
      // under Deno's tamed SES stacks). The frame is keyed on the per-module
      // sourceURL with eval-relative line numbers, so register the per-module
      // map shifted by the factory-wrapper line (`(function (...) {\n` = +1).
      for (const [name, specifier] of graph.specifierByPath) {
        const map = graph.moduleSourceMaps.get(specifier);
        if (!map) continue;
        const sourceUrl = name.replace(/[\r\n\u2028\u2029]/g, "_");
        const moduleMap = composeBundleSourceMap(
          [{ body: "", map, source: name }],
          sourceUrl,
          1, // the `(function (exports, require, module) {` wrapper line
        );
        if (moduleMap) this.getSESRuntime().loadSourceMap(sourceUrl, moduleMap);
      }
      // Verified-load sources (the function source locations CFC's
      // isVerifiedSourceInLoad recognizes) are computed by the caller, since the
      // path/prefix convention — and the canonical `cf:module/<hash>/<path>`
      // form — differs between the source-compile and cached load paths.
      this.executableRegistry.setVerifiedLoadSources(
        loadId,
        ctx.verifiedSources,
      );

      // Register functions defined during this load as verified, mirroring the
      // AMD path's verified-execution model.
      const restoreVerifiedFunctionRegistrar = setVerifiedFunctionRegistrar(
        this.executableRegistry.createVerifiedFunctionRegistrar(loadId),
      );
      const frame = pushFrame({
        runtime: this.ctRuntime,
        verifiedLoadId: loadId,
        sourceLocationContext: {
          script,
          filename: `${loadId}.js`,
          nextSearchOffset: 0,
        },
      });

      let loaded: ReturnType<typeof loadModuleGraph>;
      try {
        loaded = loadModuleGraph(mainSpecifier, {
          records: graph.records,
          globals,
          verify: false, // already verified at compile time
        });
      } finally {
        popFrame(frame);
        restoreVerifiedFunctionRegistrar();
      }

      const main = loaded.namespace as Exports;
      this.executableRegistry.captureVerifiedValue(loadId, main);

      // Build the per-module export map (keyed by normalized source path) from
      // the SAME load, and map each exported value back to its RuntimeProgram
      // for sub-pattern resolution.
      const exportMap: Record<string, Exports> = {};
      const exportsByValue = new Map<unknown, RuntimeProgram>();
      for (const [path, specifier] of graph.specifierByPath) {
        const namespace = loaded.importNow(specifier) as Exports;
        const fileName = ctx.fileNameForPath(path);
        exportMap[fileName] = namespace;
        for (const [exportName, value] of Object.entries(namespace)) {
          // Only object/function exports are sub-pattern candidates. Skip the
          // `__esModule` flag and primitives, which would otherwise collide in
          // this value-keyed map (e.g. every module's `true`).
          if (exportName === "__esModule") continue;
          if (typeof value !== "object" && typeof value !== "function") {
            continue;
          }
          if (value === null) continue;
          exportsByValue.set(value, {
            main: fileName,
            mainExport: exportName,
            files: ctx.filesForExports,
          });
        }
      }
      // Capture the export map too, so verified values from non-entry modules
      // are indexed by the registry exactly as on the AMD path.
      this.executableRegistry.captureVerifiedValue(loadId, exportMap);
      this.runtimeInternals?.exportsCallback(exportsByValue);

      return { main, exportMap, loadId };
    } finally {
      logger.timeEnd("evaluateRecordGraph");
    }
  }

  /**
   * Warm load path: build a record graph **directly from cached compiled
   * modules** (no TS source, no `resolve`, no recompile — see
   * {@link buildRecordsFromCompiled}), register runtime records, security-verify
   * (still re-verified while the integrity label is client-asserted), and
   * evaluate. `entryIdentity` is the content identity of the entry module
   * (`cf:module/<entryIdentity>`). Optional `sourceFiles` (the cached source
   * closure) flow into the export map so sub-pattern re-instantiation keeps a
   * program to recompile from; omit them and sub-patterns fall back to identity.
   */
  async evaluateCachedModules(
    modules: readonly CachedCompiledModule[],
    entryIdentity: string,
    options: { sourceFiles?: Source[] } = {},
  ): Promise<EvaluateResult> {
    await this.getRuntimeInternals();
    const { runtimeExports } = await this.getRuntimeInternals();
    const runtimeNames = Engine.runtimeModuleNames().filter((name) =>
      runtimeExports?.[name]
    );
    const runtimeModulesOption = Object.fromEntries(
      runtimeNames.map((name) => [
        name,
        Object.keys(runtimeExports?.[name] ?? {}),
      ]),
    );

    const graph = buildRecordsFromCompiled(modules, {
      runtimeModules: runtimeModulesOption,
    });

    // Register runtime-module records so cf:runtime/* imports resolve.
    const runtimeRecordExports: Record<string, Record<string, unknown>> = {};
    for (const name of runtimeNames) {
      runtimeRecordExports[name] = runtimeExports?.[name] as Record<
        string,
        unknown
      >;
    }
    for (const [spec, record] of runtimeModuleRecords(runtimeRecordExports)) {
      graph.records.set(spec, record as VirtualModuleRecord);
    }

    // Security-verify every cached body + the whole graph before executing —
    // the cache's integrity label is still only client-asserted, so cached
    // bytes are not trusted unverified (mirrors the compile path).
    for (const [specifier, body] of graph.compiledBodies) {
      verifyCompiledModuleBody(body, specifier);
    }
    const mainSpecifier = `cf:module/${entryIdentity}`;
    if (!graph.records.has(mainSpecifier)) {
      throw new Error(
        `Cached closure is missing the entry module ${mainSpecifier}`,
      );
    }
    verifyModuleGraph(graph.records, mainSpecifier);

    // Verified-load sources: normalized module paths (no `/<id>` prefix — the
    // cached records use prefix-free filenames as their sourceURLs) plus the
    // canonical `cf:module/<identity><filename>` forms that functions carry as
    // their `fn.src` (so CFC's isVerifiedSourceInLoad recognizes them).
    const verifiedSources = new Set<string>();
    for (const m of modules) {
      verifiedSources.add(normalizeVerifiedSource(m.filename));
      verifiedSources.add(
        normalizeVerifiedSource(`cf:module/${m.identity}${m.filename}`),
      );
    }
    for (const path of graph.specifierByPath.keys()) {
      verifiedSources.add(normalizeVerifiedSource(path));
    }

    return this.evaluateGraph(graph, mainSpecifier, {
      loadIdPrefix: entryIdentity,
      // Register the KNOWN identities (keyed by normalized filename = the record
      // sourceURL) instead of recomputing from source — we have no source here,
      // and the identities are authoritative. Also populate the canonical
      // source map so `fn.src` resolves to `cf:module/<identity>/<path>`.
      registerHashes: () => {
        for (const m of modules) {
          this.moduleHashByPrefixedSource.set(m.filename, m.identity);
          this.canonicalSourceByPrefixed.set(
            m.filename,
            `cf:module/${m.identity}${m.filename}`,
          );
        }
      },
      verifiedSources,
      fileNameForPath: (path) => path, // already normalized
      filesForExports: options.sourceFiles ?? [],
    });
  }

  // Evaluate pre-compiled JS, returning exports.
  // `id` is the content-derived prefix from compile(); `files` are the
  // original source files for the export map.
  async evaluate(
    id: string,
    jsScript: JsScript,
    files: Source[],
    options: EvaluateOptions = {},
  ): Promise<
    { main?: Exports; exportMap?: Record<string, Exports>; loadId?: string }
  > {
    logger.timeStart("evaluate");
    try {
      if (!options.skipBundleValidation) {
        this.bundleValidator.verify(jsScript, `${id}.js`);
      }
      this.registerModuleHashes(id, files);
      const { runtime, runtimeExports, exportsCallback } = await this
        .getRuntimeInternals();
      const loadId = this.getLoadId(id, jsScript);
      this.executableRegistry.beginVerifiedLoad(loadId);
      this.executableRegistry.setVerifiedLoadBundleId(
        loadId,
        hashOf(jsScript.js).toString(),
      );
      this.executableRegistry.setVerifiedLoadSources(
        loadId,
        // Include canonical `cf:module/<hash>/<path>` forms so CFC recognizes the
        // reload-stable source locations functions now carry (lockstep).
        [
          ...collectVerifiedLoadSources(id, jsScript, files),
          ...this.canonicalVerifiedSources(id, files).map(
            normalizeVerifiedSource,
          ),
        ],
      );
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
    // execute and return if runtime internals have not been initialized.
    if (!this.runtimeInternals && !this.sesRuntime) {
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

  isVerifiedSourceInLoad(loadId: string, source: string): boolean {
    return this.executableRegistry.isVerifiedSourceInLoad(loadId, source);
  }

  getVerifiedBundleId(loadId: string): string | undefined {
    return this.executableRegistry.getVerifiedBundleId(loadId);
  }

  getVerifiedBindingMetadata(
    implementationRef: string,
  ): { sourceFile?: string; bindingPath?: string[] } | undefined {
    return this.executableRegistry.getVerifiedBindingMetadata(
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

  // Record the content-addressed hash of every module in a load, keyed by its
  // prefixed source path (`/<id>/file.tsx`) so it can be matched against the
  // source-map `source` that appears in an action's source location.
  private registerModuleHashes(id: string, files: Source[]): void {
    // No `runtimeFingerprint` is passed: the scheduler tracks runtime/TCB
    // changes on its own `runtimeFingerprint` axis, so the implementation
    // identity is intentionally pure code identity (runtime-module import
    // leaves hash with the empty fingerprint).
    const hashes = computeModuleHashes({ main: "", files });
    for (const [path, hash] of hashes) {
      // `path` is the authored file path (e.g. `/api/.../notebook.tsx`); the
      // per-module hash already incorporates it, so the canonical source is a
      // 1:1, reload-stable identity that keeps the path for debuggability.
      this.moduleHashByPrefixedSource.set(`/${id}${path}`, hash);
      this.canonicalSourceByPrefixed.set(
        `/${id}${path}`,
        `cf:module/${hash}${path}`,
      );
    }
  }

  /**
   * Like {@link registerModuleHashes}, but takes the RESOLVED per-module
   * identities straight from the compiled graph (`cf:module/<identity>` in
   * `graph.specifierByPath`) instead of re-hashing the raw program files.
   *
   * The two must agree: the cache key, the record-graph specifiers, and the
   * source-free by-identity reload (`evaluateCachedModules`) all use the
   * resolved identity (which folds the injected/resolved modules into each
   * module's Merkle hash). Re-hashing the raw `program.files` here would yield a
   * DIFFERENT hash for the same module, so a function's `fn.src` — and thus its
   * minted `implementationRef` — would differ between this source-based compile
   * and a source-free reload, and `getExecutableFunction` would miss when a
   * resumed piece invokes a callable (CT-1623). Keying matches the source map's
   * bundle paths (`/<id>/<authoredPath>`, plus injected modules under their own
   * specifier path), and the canonical value matches the source-free form.
   */
  private registerModuleHashesFromGraph(
    id: string,
    graph: CompiledModuleGraph,
  ): void {
    const prefix = `/${id}`;
    for (const [name, specifier] of graph.specifierByPath) {
      if (!specifier.startsWith("cf:module/")) continue;
      const identity = specifier.slice("cf:module/".length);
      const authoredPath = name.startsWith(`${prefix}/`)
        ? name.slice(prefix.length)
        : name;
      this.moduleHashByPrefixedSource.set(name, identity);
      this.canonicalSourceByPrefixed.set(
        name,
        `cf:module/${identity}${authoredPath}`,
      );
    }
  }

  // Translate a bundle-prefixed source path (`/<programHash>/<authoredPath>`,
  // as returned by the source map) into the reload-stable canonical source
  // `cf:module/<moduleHash>/<authoredPath>`. Returns undefined for unmapped
  // (built-in / non-program) sources so callers can fall back to the raw value.
  canonicalModuleSource(source: string): string | undefined {
    return this.canonicalSourceByPrefixed.get(source) ??
      (source.startsWith("/")
        ? undefined
        : this.canonicalSourceByPrefixed.get(`/${source}`));
  }

  // Canonical verified-source forms for a load, so CFC's isVerifiedSourceInLoad
  // recognizes the `cf:module/<hash>/<path>` locations that functions now carry.
  private canonicalVerifiedSources(id: string, files: Source[]): string[] {
    const out: string[] = [];
    for (const file of files) {
      const canonical = this.canonicalSourceByPrefixed.get(
        `/${id}${file.name}`,
      );
      if (canonical) out.push(canonical);
    }
    return out;
  }

  // Translate a source-location string into a stable content-addressed
  // implementation identity. See the Harness interface for the contract.
  implementationHashForSource(sourceLocation: string): string | undefined {
    const match = sourceLocation.match(/^(.*):(\d+):(\d+)$/);
    const sourcePath = match ? match[1] : sourceLocation;
    const suffix = match ? `:${match[2]}:${match[3]}` : "";
    // `fn.src` is already canonical (`cf:module/<hash>/<path>`); reduce it to the
    // pure per-module code identity `cf:module/<hash>` for the fingerprint.
    const canonical = sourcePath.match(/^cf:module\/([^/]+)/);
    if (canonical) {
      return `cf:module/${canonical[1]}${suffix}`;
    }
    const hash = this.moduleHashByPrefixedSource.get(sourcePath);
    return hash === undefined ? undefined : `cf:module/${hash}${suffix}`;
  }

  // Map a single position to its original source location.
  // Returns null if no source map is loaded for the filename.
  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    if (!this.runtimeInternals) return null;
    return this.runtimeInternals.runtime.mapPosition(filename, line, column);
  }

  // Parse an error stack trace, mapping all positions back to original sources.
  // Returns the original stack if runtime internals haven't been initialized.
  parseStack(stack: string): string {
    if (!this.runtimeInternals) {
      return stack;
    }
    return this.runtimeInternals.runtime.parseStack(stack);
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

  private async getRuntimeInternals(): Promise<RuntimeInternals> {
    if (!this.runtimeInternals) {
      this.runtimeInternals = await this.initializeRuntime();
    }
    return this.runtimeInternals;
  }

  private async getCompilerInternals(): Promise<CompilerInternals> {
    if (!this.compilerInternals) {
      this.compilerInternals = await this.initializeCompiler();
    }
    return this.compilerInternals;
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
    this.runtimeInternals = undefined;
    this.compilerInternals = undefined;
    this.loadIds = new WeakMap();
    this.nextLoadId = 0;
    this.executableRegistry.clear();
    this.bundleValidator.clear();
    this.moduleHashByPrefixedSource.clear();
    this.canonicalSourceByPrefixed.clear();
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

function collectVerifiedLoadSources(
  id: string,
  jsScript: JsScript,
  files: Source[],
): string[] {
  const sources = new Set<string>();
  const addSource = (value: string | undefined) => {
    if (typeof value !== "string" || value.length === 0) {
      return;
    }
    sources.add(normalizeVerifiedSource(value));
    const prefixed = `/${id}/`;
    if (value.startsWith(prefixed)) {
      sources.add(normalizeVerifiedSource(value.slice(id.length + 1)));
    }
  };

  for (const file of files) {
    addSource(file.name);
  }
  for (const source of jsScript.sourceMap?.sources ?? []) {
    addSource(source);
  }

  return [...sources];
}

function normalizeVerifiedSource(source: string): string {
  const withoutFilePrefix = source.replace(/^file:\/\//, "");
  const normalized = withoutFilePrefix.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function computeId(program: Program): string {
  const source = [
    program.main,
    ...program.files.filter(({ name }) => !name.endsWith(".d.ts")),
  ];
  return hashOf(source).toString();
}

/**
 * Strip the whole-program `/<id>` prefix from a resolved module path to recover
 * the normalized authored path (e.g. `/<id>/main.tsx` → `/main.tsx`). Modules
 * resolved without the prefix (the injected `cfc.ts` helper) are returned as-is.
 */
function stripModuleIdPrefix(name: string, id: string): string {
  const prefix = `/${id}`;
  return name.startsWith(`${prefix}/`) ? name.slice(prefix.length) : name;
}
