import { Console } from "./console.ts";
import {
  type CacheableModule,
  type EvaluateResult,
  type Exports,
  type Harness,
  type HarnessedFunction,
  type ResolvedFabricPin,
  type RuntimeProgram,
  type TypeScriptHarnessProcessOptions,
} from "./types.ts";
import {
  collectImportSpecifiers,
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  type MappedPosition,
  type Program,
  type ProgramResolver,
  type Source,
  TypeScriptCompiler,
} from "@commonfabric/js-compiler";
import ts from "typescript";
import {
  CommonFabricTransformerPipeline,
  PATTERN_COVERAGE_GLOBAL,
  type PatternCoverageOptions,
  ReactiveErrorTransformer,
  sourceDisablesCfTransform,
} from "@commonfabric/ts-transformers";
import { getLogger } from "@commonfabric/utils/logger";
import { type MemorySpace, Runtime } from "../runtime.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { StaticCache } from "@commonfabric/static";
import {
  pretransformProgramForModules,
  transformInjectHelperModule,
} from "./pretransform.ts";
import {
  type ModuleImportEdges,
  resolveModuleImports,
} from "./module-identity.ts";
import {
  buildRecordsFromCompiled,
  type CachedCompiledModule,
  cachedModuleSourceNames,
  type CompiledModuleGraph,
  compileSourcesToRecords,
  computeFabricModuleIdentities,
  FABRIC_MOUNT_ROOT,
  type FabricMount,
} from "../sandbox/module-record-compiler.ts";
import {
  composeBundleSourceMap,
  identitySourceMap,
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
import type { PatternCoverageCollector } from "../pattern-coverage.ts";
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
import type { UnsafeHostTrustOptions } from "../unsafe-host-trust.ts";
import { ExecutableRegistry } from "./executable-registry.ts";
import { isTrustedBuilderArtifact } from "../builder/pattern-metadata.ts";
import {
  identityFromCanonicalSource,
  readBindingIdentity,
  recordVerifiedProvenance,
} from "./verified-provenance.ts";
import { FabricAwareResolver } from "./fabric-resolver.ts";
import { isFabricImportSpecifier } from "../sandbox/fabric-import-specifier.ts";

const logger = getLogger("engine");
const IMPORT_SCAN_TARGET = ts.ScriptTarget.ES2023;

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
  private nextEvalId = 0;
  // Content-addressed module hash per prefixed source path (`/<id>/file.tsx`),
  // populated at evaluate() time. Used to translate an action's bundle-relative
  // source location into a stable implementation identity.
  private moduleHashByPrefixedSource = new Map<string, string>();
  // Canonical content-addressed source per prefixed source path, i.e.
  // `/<programHash>/<authoredPath>` -> `cf:module/<moduleHash>/<authoredPath>`.
  // Used to rewrite a function's `src` into a reload-stable identity that does
  // not depend on which bundle/entry-point compiled the module.
  private canonicalSourceByPrefixed = new Map<string, string>();
  private readonly executableRegistry = new ExecutableRegistry();
  private readonly consoleShim = createSafeConsoleGlobal(new Console(this));
  private readonly patternCoverageByGraph = new WeakMap<
    CompiledModuleGraph,
    PatternCoverageCollector
  >();

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

  /**
   * Compile a program to a verified ESM module-record graph. Runs the program
   * resolution + CF transformer pipeline, emits per-module CommonJS via
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
      resolvedPins: ResolvedFabricPin[];
    }
  > {
    logger.timeStart("compileToRecordGraph");
    try {
      const id = options.identifier ?? computeId(program);
      assertNoReservedFabricPaths(program.files);
      const mappedProgram = pretransformProgramForModules(program, id);
      assertFabricImportsHaveSpace(mappedProgram.files, options);
      const engineResolver = new EngineProgramResolver(
        mappedProgram,
        this.ctRuntime.staticCache,
      );
      const fabricResolver = options.fabricImports
        ? new FabricAwareResolver(engineResolver, {
          runtime: this.ctRuntime,
          space: options.fabricImports.space,
          allowUnpinned: options.fabricImports.allowUnpinned,
        })
        : undefined;
      const resolver = fabricResolver ?? engineResolver;
      const resolvedProgram = await this.resolve(resolver);
      const mounts = fabricResolver?.mounts() ?? [];
      const specifierAliases = fabricResolver?.specifierAliases() ?? new Map();
      const resolvedPins = fabricResolver?.resolvedPins() ?? [];
      const resolvedFiles = uniqueSourcesByName(resolvedProgram.files);
      // For compilation, fabric mounts need the helper import too (they are
      // fetched as authored source — see the identity fix below). Authored
      // modules are already injected by `pretransformProgramForModules`.
      const resolvedForCompile = {
        ...resolvedProgram,
        files: injectMountSources(resolvedFiles),
      };

      // Authored (non-.d.ts) sources are the modules that must have a body.
      const moduleFiles = resolvedFiles.filter((f) =>
        !f.name.endsWith(".d.ts")
      );

      // Module identity hashes the AUTHORED source, before the helper-injection
      // decoration `pretransformProgramForModules` baked into `moduleFiles`
      // (module-loading.md: identity is over authored TS, so it is TCB-version
      // independent — CT-1740). Recover each authored module's original bytes by
      // its stored (prefix-free) filename; mounts keep their resolved bytes.
      const authoredByStoredName = new Map(
        program.files.map((f) => [f.name, f.contents]),
      );
      const patternCoverage = patternCoverageOptionsForCompile(
        options.patternCoverage,
        {
          id,
          mounts,
          sourceFiles: [
            ...program.files,
            ...resolvedFiles.filter((file) =>
              file.name.startsWith(FABRIC_MOUNT_ROOT)
            ),
          ],
        },
      );
      const pristineModuleFiles = pristineModuleSources(
        moduleFiles,
        authoredByStoredName,
        (name) => storedFilenameFor(name, id, mounts),
      );

      // Prefix-free content identity per resolved module path. Computed here
      // (cheap, no TS compile) so the cache-hit check and the write-back
      // descriptors agree with the graph's `cf:module/<hash>` specifiers.
      const identityByPath = computeFabricModuleIdentities(
        pristineModuleFiles,
        mounts,
        {
          idPrefix: `/${id}`,
        },
      );
      const entryIdentity = identityByPath.get(mappedProgram.main)!;

      // Cache hit: every emitted module already has a cached compiled body
      // (keyed by identity), so skip the TypeScript compile entirely and build
      // the record graph from the cached bodies. Per-module identities are
      // transitively sensitive, so a partial set cannot be trusted — fall back
      // to a full recompile. The cache is queried by identity (directly, or
      // lazily once identities are known) without leaking the engine's prefix.
      // Coverage compiles need fresh emitted JavaScript because cached bodies do
      // not include counters.
      const cached = patternCoverage !== undefined
        ? undefined
        : options.precompiledModules ??
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
        const modules = compiler.compileToModules(resolvedForCompile, {
          noCheck: options.noCheck,
          runtimeModules: Engine.runtimeModuleNames(),
          specifierAliases,
          getTransformedProgram: options.getTransformedProgram
            ? (nextProgram) => options.getTransformedProgram?.(nextProgram)
            : undefined,
          diagnosticMessageTransformer: new ReactiveErrorTransformer({
            verbose: options.verboseErrors,
          }),
          beforeTransformers: (program) => {
            const pipeline = new CommonFabricTransformerPipeline({
              patternCoverage,
            });
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
        specifierAliases,
        // Strip the whole-program `/<id>` prefix from per-module identities so
        // `cf:module/<hash>` is entry-point independent and dedupes across
        // programs (the content-addressed cache keys off these identities).
        idPrefix: `/${id}`,
        // Reuse the identities already computed above (cache-hit check); avoids
        // a second hashing/import-resolution pass over the module set.
        identityByPath,
      });
      if (options.patternCoverage) {
        this.patternCoverageByGraph.set(graph, options.patternCoverage);
      }

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

      // Security-verify every authored module body before it can execute —
      // EXCEPT a trusted, integrity-gated full hit. The CFC integrity label is
      // the security boundary for cache hits, so re-running the SES body verifier
      // on integrity-gated bytes is redundant per-load work (threat model:
      // `docs/specs/module-loading.md`, "the persistent compilation cache").
      // Trust is gated on PROVENANCE, not just the opt-in flag: the bodies must
      // have arrived via the lazy `precompiledModulesFor` channel (the cache
      // callback, which reads the compiled set with `requiredIntegrity`,
      // fail-closed) — NOT a direct, caller-supplied `precompiledModules` map,
      // which is untrusted injection. Freshly compiled bodies (miss / partial)
      // are likewise always verified.
      const trustBodies = fullHit &&
        options.trustedBodies === true &&
        options.precompiledModules === undefined &&
        options.precompiledModulesFor !== undefined;
      if (!trustBodies) {
        // Verify, and record which modules the verifier approved for hoist
        // registration — only those get the real `__cfReg` registrar (the rest
        // get a throwing one, so a smuggled call fails closed).
        for (const [specifier, body] of graph.compiledBodies) {
          const { hasHoistRegistration } = verifyCompiledModuleBody(
            body,
            specifier,
          );
          if (hasHoistRegistration) graph.registrationApproved.add(specifier);
        }
      } else {
        // Trusted integrity-gated bytes: SES verification — and its registration
        // approval — already ran when the cache entry was sealed, so grant the
        // real registrar to every module (one without a `__cfReg` call never
        // invokes it).
        for (const specifier of graph.compiledBodies.keys()) {
          graph.registrationApproved.add(specifier);
        }
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
      // carries the AUTHORED TS source (for the source set — pre-helper-injection,
      // matching what identity hashed), the compiled JS (for the compiled set),
      // and the internal import edges as specifier → dependency-identity links.
      // On a cache hit these mirror the artifacts just loaded. Built over the
      // pristine module set so `source` and the edges are over authored bytes.
      const importEdges = resolveModuleImports({
        main: "",
        files: pristineModuleFiles,
      });
      const modules: CacheableModule[] = pristineModuleFiles.map((file) => {
        const identity = identityByPath.get(file.name)!;
        const sourceMap = precompiledSourceMaps.get(file.name);
        const imports = cacheableImportsFor(
          file.name,
          importEdges,
          identityByPath,
          specifierAliases,
        );
        return {
          identity,
          filename: storedFilenameFor(file.name, id, mounts),
          source: file.contents,
          js: precompiledBodies.get(file.name)!,
          ...(sourceMap === undefined ? {} : { sourceMap }),
          imports,
        };
      });

      return {
        id,
        graph,
        mainSpecifier,
        entryIdentity,
        modules,
        resolvedPins,
      };
    } finally {
      logger.timeEnd("compileToRecordGraph");
    }
  }

  /**
   * PROTOTYPE (cfcheck #2): type-check + SES-verify many authored programs in a
   * SINGLE TypeScript program.
   *
   * Each program is resolved with the runtime `.d.ts` type environment injected
   * exactly as {@link compileToRecordGraph} does (pretransform → resolve), then
   * every resolved file is unioned and compiled as roots of one `ts.Program`.
   * The expensive lib/API parse+bind+typecheck is therefore paid ONCE for the
   * whole batch instead of once per program — the amortization the per-pattern
   * cfcheck path (≈330 separate programs) throws away.
   *
   * Returns the batch's transformer/type diagnostics rather than throwing, so a
   * caller can attribute failures. NOT wired into anything yet; measures the
   * ceiling and surfaces cross-program hazards (e.g. duplicate `declare global`).
   */
  async typeCheckBatch(
    programs: RuntimeProgram[],
    options: { transform?: boolean } = {},
  ): Promise<{
    patternCount: number;
    fileCount: number;
    diagnostics: readonly { file?: string; message: string }[];
  }> {
    // Nothing to check (e.g. an empty CI shard, or every program failed to
    // resolve upstream) — there is no entry to compile, so return cleanly.
    if (programs.length === 0) {
      return { patternCount: 0, fileCount: 0, diagnostics: [] };
    }

    const runTransform = options.transform ?? true;
    const unioned = new Map<string, Source>();
    const mains: string[] = [];
    for (const program of programs) {
      const id = computeId(program);
      const mapped = pretransformProgramForModules(program, id);
      const resolver = new EngineProgramResolver(
        mapped,
        this.ctRuntime.staticCache,
      );
      const resolved = await this.resolve(resolver);
      for (const file of uniqueSourcesByName(resolved.files)) {
        if (!unioned.has(file.name)) unioned.set(file.name, file);
      }
      mains.push(mapped.main);
    }

    const merged: RuntimeProgram = {
      main: mains[0]!,
      files: [...unioned.values()],
    };

    const { compiler } = await this.getCompilerInternals();
    const { modules, diagnostics: compileDiagnostics } = compiler
      .compileToModulesCollecting(merged, {
        runtimeModules: Engine.runtimeModuleNames(),
        beforeTransformers: runTransform
          ? (program) => {
            const pipeline = new CommonFabricTransformerPipeline();
            return {
              factories: pipeline.toFactories(program),
              getDiagnostics: () => pipeline.getDiagnostics(),
            };
          }
          : undefined,
      });
    const diagnostics: { file?: string; message: string }[] = [
      ...compileDiagnostics,
    ];

    // SES-verify each emitted body. compileToRecordGraph runs this per module
    // (verifyCompiledModuleBody); compileToModules does not, so the batch must
    // run it explicitly or it would silently lose cfcheck's SES coverage. Body
    // verification is per-body AST work (no type-checking), so it stays cheap.
    if (runTransform) {
      for (const [name, body] of modules) {
        if (name.endsWith(".d.ts")) continue;
        try {
          verifyCompiledModuleBody(body.js, name);
        } catch (error) {
          diagnostics.push({
            file: name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return {
      patternCount: programs.length,
      fileCount: unioned.size,
      diagnostics,
    };
  }

  /**
   * Cold-recovery path: recompile cacheable modules from the AUTHORED source
   * already stored in the content-addressed **source set** (`pattern:<identity>`
   * cells), loaded by identity — i.e. recreate the pattern from its stored
   * TypeScript alone. The stored source is prefix-free authored TS (the helper
   * import is NOT baked in — identity is over authored source, module-loading.md),
   * so we skip **re-prefixing** but DO re-inject the helper import for
   * compilation (`transformInjectHelperModule`, before resolve so the resolver
   * pulls the `commonfabric` types). We **resolve** to supply the runtime
   * `.d.ts` type environment the CF transformer needs for schema generation
   * (those types are TCB, from the static cache, not stored per pattern). Used
   * when the compiled set misses (e.g. a runtimeVersion bump invalidates
   * `compileCache:<rtver>/...`).
   *
   * Per-module identities recompute to the same content-addressed values (the
   * authored source + names are unchanged), so the rebuilt compiled set is
   * addressable — and writable-back — under the new runtimeVersion. Returns the
   * `CacheableModule[]` (feed to {@link evaluateCachedModules}) + entry identity.
   * `entryFilename` is the entry module's normalized path.
   */
  async compileResolvedToRecordGraph(
    resolvedFiles: Source[],
    entryFilename: string,
    options: {
      fabricImports?: TypeScriptHarnessProcessOptions["fabricImports"];
    } = {},
  ): Promise<{ modules: CacheableModule[]; entryIdentity: string }> {
    const { compiler } = await this.getCompilerInternals();
    assertNoReservedFabricPaths(resolvedFiles);
    assertFabricImportsHaveSpace(resolvedFiles, options);
    // The stored source set holds prefix-free AUTHORED TS (the helper import is
    // NOT baked in — identity is over authored source, module-loading.md).
    // Inject the helper BEFORE resolve so the resolver pulls the `commonfabric`
    // runtime `.d.ts` the transformer needs; identity is recomputed over the
    // authored bytes below and matches the stored keys.
    const injectedInput = transformInjectHelperModule({
      main: entryFilename,
      files: resolvedFiles,
    });
    const engineResolver = new EngineProgramResolver(
      { main: entryFilename, files: injectedInput.files },
      this.ctRuntime.staticCache,
    );
    const fabricResolver = options.fabricImports
      ? new FabricAwareResolver(engineResolver, {
        runtime: this.ctRuntime,
        space: options.fabricImports.space,
        allowUnpinned: options.fabricImports.allowUnpinned,
      })
      : undefined;
    const resolver = fabricResolver ?? engineResolver;
    const resolvedProgram = await this.resolve(resolver);
    const mounts = fabricResolver?.mounts() ?? [];
    const specifierAliases = fabricResolver?.specifierAliases() ?? new Map();
    const resolvedProgramFiles = uniqueSourcesByName(resolvedProgram.files);
    // Fabric mounts are fetched as authored source; inject the helper for
    // compilation (authored entry modules were injected before resolve above).
    const resolvedForCompile = {
      ...resolvedProgram,
      files: injectMountSources(resolvedProgramFiles),
    };
    const moduleFiles = resolvedProgramFiles.filter((f) =>
      !f.name.endsWith(".d.ts")
    );
    // Identity + stored source hash the AUTHORED bytes (recovered from the stored
    // input, by stored filename); the resolved set above carries the injected
    // form the compiler needs. Identities recompute prefix-free over the authored
    // closure — they match the stored identities the source docs were keyed by.
    const authoredByStoredName = new Map(
      resolvedFiles.map((f) => [f.name, f.contents]),
    );
    const pristineModuleFiles = pristineModuleSources(
      moduleFiles,
      authoredByStoredName,
      (name) => storedFilenameFor(name, undefined, mounts),
    );
    const identityByPath = computeFabricModuleIdentities(
      pristineModuleFiles,
      mounts,
    );

    const emitted = compiler.compileToModules(resolvedForCompile, {
      runtimeModules: Engine.runtimeModuleNames(),
      specifierAliases,
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

    const importEdges = resolveModuleImports({
      main: "",
      files: pristineModuleFiles,
    });
    const modules: CacheableModule[] = pristineModuleFiles.map((file) => {
      const out = emitted.get(file.name)!;
      const imports = cacheableImportsFor(
        file.name,
        importEdges,
        identityByPath,
        specifierAliases,
      );
      return {
        identity: identityByPath.get(file.name)!,
        filename: storedFilenameFor(file.name, undefined, mounts),
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
   * Compile + evaluate a program through the ESM module-record path,
   * returning `{ main, exportMap }` plus the per-identity namespaces.
   *
   * Low-level: this does NOT register the evaluated artifacts in the pattern
   * index, so anonymous map/filter/flatMap ops from the returned namespace have
   * no content-addressed entry ref and would resolve via their embedded graph.
   * To RUN a pattern from the returned namespace, use
   * `PatternManager.compileAndRegisterModules`, which fuses registration in (see
   * CT-1811). Reach for this bare form only to inspect serialized/verified output
   * without running.
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
    // function's `fn.src` (hence its content-addressed identity) differ between
    // this source-based compile and a source-free by-identity reload, breaking
    // by-identity resolution (`getVerifiedImplementation`) for resumed
    // callables (CT-1623).
    this.registerModuleHashesFromGraph(id, graph);

    return this.evaluateGraph(graph, mainSpecifier, {
      evalIdPrefix: id,
      // Already registered above (idempotent); keep as a no-op so evaluateGraph
      // doesn't recompute the hashes a second time.
      registerHashes: () => {},
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
      evalIdPrefix: string;
      registerHashes(): void;
      fileNameForPath(path: string): string;
      filesForExports: Source[];
    },
  ): EvaluateResult {
    logger.timeStart("evaluateRecordGraph");
    try {
      // Per-evaluation id, used ONLY to key this evaluation's synthetic
      // source-map names (`${evalId}.js`). The former "verified load id" —
      // which scoped CFC identity and registry partitions to a load — is gone
      // (PR E2): identity flows through the content-addressed provenance
      // recorded below.
      const evalId = `${ctx.evalIdPrefix}:esm:${this.nextEvalId++}`;
      // Register per-module content hashes — this wires the scheduler's
      // content-addressed implementation hash. Source-location resolution (the
      // `indexOf`-into-`script` fallback plus the per-module source maps
      // registered below) resolves `fn.src` to the canonical
      // `cf:module/<hash>/<path>` form these hashes key on. Covered by
      // `action-fingerprint.test.ts` and `esm-source-location.test.ts`.
      ctx.registerHashes();

      const patternCoverage = this.patternCoverageByGraph.get(graph);
      const globals = createModuleCompartmentGlobals({
        console: this.consoleShim,
        ...(patternCoverage
          ? { [PATTERN_COVERAGE_GLOBAL]: patternCoverage.sandboxGlobal() }
          : {}),
      });
      // Concatenated module bodies give the source-location frame a `script`
      // for fn.src `indexOf` resolution. (Insertion order need not match the
      // import-execution order; resolveLocationFromFunctionSource falls back to
      // a from-zero scan, and any mis-attribution degrades fail-closed at the
      // CFC identity layer — see the fn.src note in the design doc.)
      const script = [...graph.compiledBodies.values()].join("\n");
      // Register a composed bundle source map for `${evalId}.js` so that
      // `fn.src` coordinates (resolved against `script`) map back to the
      // original authored sources — without this the ESM loader yields raw
      // bundle coordinates and the CFC provenance src check fails closed.
      // Full module path per specifier.
      const sourceNameBySpecifier = new Map<string, string>();
      for (const [name, specifier] of graph.specifierByPath) {
        sourceNameBySpecifier.set(specifier, name);
      }
      // On the warm/cached record load (`buildRecordsFromCompiled`) no authored
      // per-module map is retained, so fall back to an IDENTITY map keyed on the
      // module's per-module source `name`. Without a registered bundle map the
      // ESM loader leaves `fn.src` as the raw `${evalId}.js:line:col` bundle
      // coordinate, which the engine's name → canonical table cannot resolve, so
      // identity downgrades to `unsupported` and CFC verified-source identity
      // fails closed (the inSpace-child owner-protected write regression,
      // CT-1754). The identity map preserves coordinates verbatim and only
      // re-labels the bundle frame with the canonical source name, so the
      // EXISTING verified-binding check passes for legitimately compiled modules
      // without weakening it.
      const bundleSourceMap = composeBundleSourceMap(
        [...graph.compiledBodies].map(([specifier, body]) => {
          const source = sourceNameBySpecifier.get(specifier);
          return {
            body,
            map: graph.moduleSourceMaps.get(specifier) ??
              (source !== undefined
                ? identitySourceMap(body, source)
                : undefined),
            source,
          };
        }),
        `${evalId}.js`,
      );
      if (bundleSourceMap) {
        this.getSESRuntime().loadSourceMap(`${evalId}.js`, bundleSourceMap);
      }
      // ALSO register each module's map under its eval `//# sourceURL` (its
      // sanitized source name). The browser surfaces the per-module eval frame
      // in `new Error().stack`, and `annotateFunctionDebugMetadata` resolves
      // `fn.src` from that frame FIRST (the indexOf-into-`script` fallback that
      // `${evalId}.js` covers only wins when the stack frame is absent, e.g.
      // under Deno's tamed SES stacks). The frame is keyed on the per-module
      // sourceURL with eval-relative line numbers, so register the per-module
      // map shifted by the factory-wrapper line (`(function (...) {\n` = +1).
      //
      // When no authored map exists for a module (the warm/cached record load \u2014
      // `buildRecordsFromCompiled` populates `moduleSourceMaps` only for cached
      // bodies that retained one), fall back to an IDENTITY map keyed on the
      // module's per-module source `name`. Without this the eval frame stays a
      // raw `${evalId}.js:line:col` bundle coordinate that the engine's
      // per-module name \u2192 canonical table cannot canonicalize, so `fn.src`
      // never reaches `cf:module/<id>/<path>` and CFC verified-source identity
      // downgrades to `unsupported` \u2014 the inSpace-child owner-protected write
      // regression (CT-1754). The identity map preserves coordinates verbatim;
      // it only re-labels the bundle frame with the module's canonical source
      // name, so the EXISTING verified-binding check passes for legitimately
      // compiled modules without weakening it.
      for (const [name, specifier] of graph.specifierByPath) {
        const map = graph.moduleSourceMaps.get(specifier) ??
          identitySourceMap(graph.compiledBodies.get(specifier) ?? "", name);
        const sourceUrl = name.replace(/[\r\n\u2028\u2029]/g, "_");
        const moduleMap = composeBundleSourceMap(
          [{ body: "", map, source: name }],
          sourceUrl,
          1, // the `(function (exports, require, module) {` wrapper line
        );
        if (moduleMap) this.getSESRuntime().loadSourceMap(sourceUrl, moduleMap);
      }

      const frame = pushFrame({
        runtime: this.ctRuntime,
        sourceLocationContext: {
          script,
          filename: `${evalId}.js`,
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
      } catch (error) {
        // Module evaluation runs outside an isolate `exec`, so errors thrown
        // at module scope would otherwise surface with a censored (empty) or
        // raw-coordinate stack. Materialize + source-map it here (once),
        // matching how invoked-function errors are mapped.
        throw this.getSESRuntime().mapThrownError(error);
      } finally {
        popFrame(frame);
      }

      const main = loaded.namespace as Exports;

      // Build the per-module export map (keyed by normalized source path) from
      // the SAME load, and map each exported value back to its RuntimeProgram
      // for sub-pattern resolution.
      const exportMap: Record<string, Exports> = {};
      const exportsByValue = new Map<unknown, RuntimeProgram>();
      // Per-module namespaces keyed by content identity (stripped from the
      // `cf:module/<identity>` specifier) for the in-memory identity cache.
      const exportsByIdentity = new Map<string, Exports>();
      const MODULE_SPECIFIER_PREFIX = "cf:module/";
      for (const [path, specifier] of graph.specifierByPath) {
        const namespace = loaded.importNow(specifier) as Exports;
        const fileName = ctx.fileNameForPath(path);
        exportMap[fileName] = namespace;
        if (specifier.startsWith(MODULE_SPECIFIER_PREFIX)) {
          exportsByIdentity.set(
            specifier.slice(MODULE_SPECIFIER_PREFIX.length),
            namespace,
          );
        }
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
      this.runtimeInternals?.exportsCallback(exportsByValue);

      // Content-addressed CFC provenance: record it HERE, where functions
      // become verified (this evaluation), rather than in the PatternManager's
      // later indexing - so provenance covers every load path, including a
      // pattern compiled by a standalone Engine and registered without going
      // through `PatternManager.compilePattern`. Keyed by the implementation
      // function object; gated on the same `isTrustedBuilderArtifact` brand the
      // index uses, so forged values get nothing. This walk also carries the
      // CT-1665 verified-binding identity for non-exported handlers: each
      // `__cfReg`-registered factory already wears its
      // `__cfVerifiedBindingIdentity` annotation, which recordModuleProvenance
      // folds into the provenance entry.
      this.recordModuleProvenance(
        exportsByIdentity,
        graph.registrationSink,
      );

      // `graph.registrationSink` was populated by each module's `__cfReg` during
      // the `importNow` loop above (committed only for modules that evaluated
      // cleanly).
      return {
        main,
        exportMap,
        exportsByIdentity,
        registrationsByIdentity: graph.registrationSink,
      };
    } finally {
      logger.timeEnd("evaluateRecordGraph");
    }
  }

  /**
   * Record content-addressed CFC provenance for every trusted builder artifact
   * surfaced by a verified evaluation — its exports (keyed by export name) and
   * its `__cfReg` hoist/non-export registrations (keyed by the hoist symbol).
   * Keyed by the artifact's implementation function object; the same gate the
   * artifact index uses (`isTrustedBuilderArtifact`) keeps forged values out.
   * First-write-wins (see `recordVerifiedProvenance`), so an export and a
   * `__cfReg` entry for one artifact agree on a single canonical symbol.
   */
  private recordModuleProvenance(
    exportsByIdentity: Map<string, Exports>,
    registrationSink: Map<string, Map<string, unknown>>,
  ): void {
    const record = (identity: string, symbol: string, value: unknown) => {
      if (!isTrustedBuilderArtifact(value)) return;
      const implementation =
        (value as { implementation?: unknown }).implementation ?? value;
      if (typeof implementation !== "function") return;
      // Reject a CONFIRMED cross-module mismatch: a re-exporting module
      // (`export { setName } from "./defn"`) surfaces the same function under
      // its own identity, but the function's canonical `fn.src` names its
      // defining module. Provenance is first-write-wins and CFC fails closed on
      // an identity/`fn.src` mismatch, so letting a re-exporter (possibly
      // visited first) stamp its identity would make a valid verified artifact
      // resolve as `unsupported`; dropping the re-exporter's record leaves the
      // defining module's (matching) record to stick. A non-canonical `src`
      // (e.g. a standalone-engine load whose src isn't rewritten to
      // `cf:module/<hash>`) is left ALONE — recording it is harmless (CFC then
      // fail-closes on its own src check), and blocking it would needlessly
      // strip the `$implRef` such a module can still resolve by.
      const srcIdentity = identityFromCanonicalSource(
        (implementation as { src?: string }).src,
      );
      if (srcIdentity !== undefined && srcIdentity !== identity) return;
      const bindingIdentity = readBindingIdentity(value);
      recordVerifiedProvenance(implementation, {
        identity,
        symbol,
        ...(bindingIdentity ? { bindingIdentity } : {}),
      });
      // The strong content-addressed implementation index — the resolution
      // (and eviction-insurance) backing for serialized `$implRef`s; see
      // `ExecutableRegistry.registerVerifiedImplementation`.
      this.executableRegistry.registerVerifiedImplementation(
        identity,
        symbol,
        implementation as HarnessedFunction,
      );
    };
    for (const [identity, namespace] of exportsByIdentity) {
      for (const [exportName, value] of Object.entries(namespace)) {
        if (exportName === "__esModule") continue;
        record(identity, exportName, value);
      }
    }
    for (const [identity, entries] of registrationSink) {
      for (const [symbol, value] of entries) {
        record(identity, symbol, value);
      }
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
    options: { sourceFiles?: Source[]; trustedBodies?: boolean } = {},
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

    // Security-verify every cached body before executing — EXCEPT a trusted
    // warm hit. These bodies always come from the integrity-gated compiled set
    // (`loadCompiledClosure` reads with `requiredIntegrity`, fail-closed), so
    // with `trustedBodies` the CFC integrity label is the security boundary and
    // re-running the SES body verifier is redundant per-load work (threat model:
    // `docs/specs/module-loading.md`, "the persistent compilation cache"). The
    // structural graph verify below always runs.
    if (options.trustedBodies !== true) {
      // Verify, and record which modules the verifier approved for hoist
      // registration — only those get the real `__cfReg` registrar.
      for (const [specifier, body] of graph.compiledBodies) {
        const { hasHoistRegistration } = verifyCompiledModuleBody(
          body,
          specifier,
        );
        if (hasHoistRegistration) graph.registrationApproved.add(specifier);
      }
    } else {
      // Trusted integrity-gated bytes: registration approval was sealed at
      // first compile; grant the real registrar to every module.
      for (const specifier of graph.compiledBodies.keys()) {
        graph.registrationApproved.add(specifier);
      }
    }
    const mainSpecifier = `cf:module/${entryIdentity}`;
    if (!graph.records.has(mainSpecifier)) {
      throw new Error(
        `Cached closure is missing the entry module ${mainSpecifier}`,
      );
    }
    verifyModuleGraph(graph.records, mainSpecifier);

    return this.evaluateGraph(graph, mainSpecifier, {
      evalIdPrefix: entryIdentity,
      // Register the KNOWN identities (keyed by normalized filename = the record
      // sourceURL) instead of recomputing from source — we have no source here,
      // and the identities are authoritative. Also populate the canonical
      // source map so `fn.src` resolves to `cf:module/<identity>/<path>`.
      registerHashes: () => {
        // Keyed by the same (collision-disambiguated) source names the record
        // graph uses for sourceURLs, so stack-resolved fn.src coordinates land
        // on the right module even when an importer and its fabric dependency
        // share a filename. The canonical value keeps the AUTHORED filename —
        // unchanged continuity with the source-compile path.
        const sourceNames = cachedModuleSourceNames(modules);
        for (const m of modules) {
          const name = sourceNames.get(m.identity)!;
          this.moduleHashByPrefixedSource.set(name, m.identity);
          this.canonicalSourceByPrefixed.set(
            name,
            `cf:module/${m.identity}${m.filename}`,
          );
        }
      },
      fileNameForPath: (path) => path, // already normalized
      filesForExports: options.sourceFiles ?? [],
    });
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

  getVerifiedImplementation(
    identity: string,
    symbol: string,
  ): HarnessedFunction | undefined {
    return this.executableRegistry.getVerifiedImplementation(identity, symbol);
  }

  unsafeTrustHostValue(
    value: unknown,
    options: UnsafeHostTrustOptions,
  ): void {
    this.executableRegistry.trustHostValue(value, options);
  }

  /**
   * Record the content-addressed identity of every module in a load, keyed by
   * its prefixed source path (`/<id>/file.tsx`) so it can be matched against
   * the source-map `source` that appears in an action's source location. Takes
   * the RESOLVED per-module identities straight from the compiled graph
   * (`cf:module/<identity>` in `graph.specifierByPath`) instead of re-hashing
   * the raw program files.
   *
   * The two must agree: the cache key, the record-graph specifiers, and the
   * source-free by-identity reload (`evaluateCachedModules`) all use the
   * resolved identity (which folds the injected/resolved modules into each
   * module's Merkle hash). Re-hashing the raw `program.files` here would yield a
   * DIFFERENT hash for the same module, so a function's `fn.src` — and thus its
   * content-addressed identity — would differ between this source-based compile
   * and a source-free reload, and `getVerifiedImplementation` would miss when a
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
    this.nextEvalId = 0;
    this.executableRegistry.clear();
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
}

function computeId(program: Program): string {
  const source = [
    program.main,
    ...program.files.filter(({ name }) => !name.endsWith(".d.ts")),
  ];
  return hashOf(source).toString();
}

function assertNoReservedFabricPaths(files: readonly Source[]): void {
  for (const file of files) {
    if (file.name.startsWith(FABRIC_MOUNT_ROOT)) {
      throw new Error("/~cf/ is a reserved namespace");
    }
  }
}

function assertFabricImportsHaveSpace(
  files: readonly Source[],
  options: { fabricImports?: { space: MemorySpace } },
): void {
  if (options.fabricImports !== undefined) return;
  for (const file of files) {
    for (
      const specifier of collectImportSpecifiers(file, IMPORT_SCAN_TARGET)
    ) {
      if (isFabricImportSpecifier(specifier)) {
        throw new Error(
          "fabric imports require a space context (options.fabricImports)",
        );
      }
    }
  }
}

// Recover each resolved AUTHORED module's pre-helper-injection source for module
// identity and the stored source set. `resolved` carries the helper-injected,
// prefixed bytes the compiler/transformer pipeline needs; identity must hash the
// authored bytes instead (module-loading.md). Authored modules map back to
// `authoredByStoredName` via their stored (prefix-free) filename. Fabric-MOUNT
// modules (`/~cf/<identity>/...`) are left untouched: their fetched `doc.code`
// is already the authored source their own space governs, and their stored
// filename can collide with an authored module's (both `/main.tsx`), so they
// must NOT be looked up in `authoredByStoredName`. `.d.ts` files are excluded by
// callers before this runs.
function pristineModuleSources(
  resolved: readonly Source[],
  authoredByStoredName: ReadonlyMap<string, string>,
  storedNameOf: (name: string) => string,
): Source[] {
  return resolved.map((file) => {
    if (file.name.startsWith(FABRIC_MOUNT_ROOT)) return file;
    const authored = authoredByStoredName.get(storedNameOf(file.name));
    return authored === undefined
      ? file
      : { name: file.name, contents: authored };
  });
}

// Inject the `__cfHelpers` import into resolved fabric-MOUNT sources, for
// compilation only. Authored modules are already helper-injected by
// `pretransformProgramForModules` (hot) / the cold path's pre-resolve inject;
// mounts are fetched as authored source (post the identity fix) and would
// otherwise reach the compiler without the helper they need. `commonfabric` is
// already resolved into the program by the authored entry's injected import, so
// injecting here (after resolve) resolves cleanly. Non-mount and `.d.ts` files
// pass through unchanged.
function injectMountSources(files: readonly Source[]): Source[] {
  const mounts = files.filter((f) => f.name.startsWith(FABRIC_MOUNT_ROOT));
  if (mounts.length === 0) return [...files];
  const injected = new Map(
    transformInjectHelperModule({ main: mounts[0].name, files: mounts }).files
      .map((f) => [f.name, f.contents] as const),
  );
  return files.map((f) => {
    const next = injected.get(f.name);
    return next === undefined ? f : { ...f, contents: next };
  });
}

// Pattern coverage runs after helper injection. This maps spans back to the
// authored file and skips spans from helper code added around the source.
// The normal line offset depends on the one-line helper import from
// packages/ts-transformers/src/core/cf-helpers.ts.
function patternCoverageOptionsForCompile(
  collector: PatternCoverageCollector | undefined,
  params: {
    id: string;
    mounts: readonly FabricMount[];
    sourceFiles: readonly Source[];
  },
): PatternCoverageOptions | undefined {
  if (collector === undefined) return undefined;

  const sourceInfo = new Map(
    params.sourceFiles.map((file) => [
      coverageFilenameFor(file.name, params.id, params.mounts),
      {
        lineOffset: sourceDisablesCfTransform(file.contents) ? 0 : -1,
        lineCount: file.contents.split(/\r\n|\r|\n/).length,
      },
    ]),
  );
  const unknownSourceInfo = {
    lineOffset: 0,
    lineCount: Number.POSITIVE_INFINITY,
  };

  return {
    fileName: (sourceFileName) =>
      coverageFilenameFor(sourceFileName, params.id, params.mounts),
    mapSpan: (span) => {
      const info = sourceInfo.get(span.fileName) ?? unknownSourceInfo;

      const startLine = span.startLine + info.lineOffset;
      if (startLine < 1 || startLine > info.lineCount) return undefined;

      return {
        ...span,
        startLine,
        endLine: Math.min(span.endLine + info.lineOffset, info.lineCount),
      };
    },
    registerSpan: (span) => collector.registerSpan(span),
  };
}

function coverageFilenameFor(
  name: string,
  id: string,
  mounts: readonly FabricMount[],
): string {
  // Mount paths carry the imported module identity. The coverage collector keys
  // spans by file name and span id, and span ids restart for each source file.
  if (name.startsWith(FABRIC_MOUNT_ROOT)) return name;
  return storedFilenameFor(name, id, mounts);
}

function uniqueSourcesByName(files: readonly Source[]): Source[] {
  const byName = new Map<string, Source>();
  for (const file of files) {
    const previous = byName.get(file.name);
    if (previous !== undefined) {
      if (previous.contents !== file.contents) {
        throw new Error(
          `Conflicting resolved source contents for '${file.name}'`,
        );
      }
      continue;
    }
    byName.set(file.name, file);
  }
  return [...byName.values()];
}

function cacheableImportsFor(
  fileName: string,
  importEdges: ReadonlyMap<string, ModuleImportEdges>,
  identityByPath: ReadonlyMap<string, string>,
  specifierAliases: ReadonlyMap<string, string>,
): CacheableModule["imports"] {
  const edges = importEdges.get(fileName);
  const internal = (edges?.internalDeps ?? []).map((dep) => ({
    specifier: dep.specifier,
    targetIdentity: requiredIdentity(identityByPath, dep.target),
  }));
  const fabric = (edges?.externalDeps ?? [])
    .filter(isFabricImportSpecifier)
    .map((specifier) => {
      const target = specifierAliases.get(specifier);
      if (target === undefined) {
        throw new Error(
          `unresolved fabric specifier '${specifier}' survived compile`,
        );
      }
      return {
        specifier,
        targetIdentity: requiredIdentity(identityByPath, target),
      };
    });
  return [...internal, ...fabric];
}

function requiredIdentity(
  identityByPath: ReadonlyMap<string, string>,
  path: string,
): string {
  const identity = identityByPath.get(path);
  if (identity === undefined) {
    throw new Error(`No module identity computed for '${path}'`);
  }
  return identity;
}

function storedFilenameFor(
  name: string,
  id: string | undefined,
  mounts: readonly FabricMount[],
): string {
  for (const mount of mounts) {
    const prefix = `${FABRIC_MOUNT_ROOT}${mount.entryIdentity}`;
    if (name.startsWith(`${prefix}/`)) {
      return name.slice(prefix.length);
    }
  }
  return id === undefined ? name : stripModuleIdPrefix(name, id);
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
