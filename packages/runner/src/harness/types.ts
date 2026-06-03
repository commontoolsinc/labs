import type {
  JsScript,
  Program,
  ProgramResolver,
  Source,
} from "@commonfabric/js-compiler";
import type {
  CachedCompiledModule,
  CompiledModuleGraph,
} from "../sandbox/module-record-compiler.ts";
import type { UnsafeHostTrustOptions } from "../unsafe-host-trust.ts";

export type HarnessedFunction = (input: any) => void;

export type RuntimeProgram = Program & {
  // The named export from the program's entry file to run.
  // Defaults to "default".
  mainExport?: string;
};

export interface TypeScriptHarnessProcessOptions {
  // Disables typechecking of the program.
  noCheck?: boolean;
  // An identifer to use to uniquely identify the compiled
  // code when applying source maps.
  identifier?: string;
  // Filename to use in the compiled JS code, for engines
  // that apply source maps.
  filename?: string;
  // Get the program post-AST-transformation for debugging.
  getTransformedProgram?: (program: Program) => void;
  // Show verbose TypeScript error messages instead of simplified hints.
  verboseErrors?: boolean;
  // Cached per-module compiled bodies keyed by content-addressed module
  // identity (the prefix-free `cf:module/<hash>` minus the scheme). Used only on
  // the ESM record-graph path: when every emitted module is present,
  // `compileToRecordGraph` skips the TypeScript compile and builds the record
  // graph from these bodies instead. A partial set is ignored (the engine
  // recompiles the whole program) because per-module identities are
  // transitively sensitive — a closure either hits in full or not at all.
  precompiledModules?: Map<string, CompiledModuleArtifact>;
  // Lazy variant of `precompiledModules`: invoked once, after the engine has
  // resolved the program and computed per-module identities (so the cache can
  // be queried by content identity without a separate resolve pass). Returns the
  // identity-keyed cached bodies, or undefined for a miss. `precompiledModules`
  // takes precedence when both are set.
  precompiledModulesFor?: (info: {
    entryIdentity: string;
    identities: string[];
  }) => Promise<Map<string, CompiledModuleArtifact> | undefined>;
}

/** A cached/compiled per-module artifact: emitted JS plus optional source map. */
export interface CompiledModuleArtifact {
  js: string;
  sourceMap?: unknown;
}

/**
 * Everything the content-addressed compilation cache needs to persist (and
 * later reload) one module, surfaced by `compileToRecordGraph` in identity
 * space — callers never see the engine's internal `/<id>` path prefix.
 */
export interface CacheableModule {
  /** Prefix-free content identity (the `cf:module/<hash>` hash, no scheme). */
  identity: string;
  /** Normalized authored module path (no `/<id>` prefix; e.g. `/main.tsx`). */
  filename: string;
  /** Resolved TypeScript source whose bytes are folded into `identity`. */
  source: string;
  /** Compiled CommonJS body. */
  js: string;
  /** Per-module source map, when available. */
  sourceMap?: unknown;
  /** Internal import edges: specifier → the dependency module's identity. */
  imports: { specifier: string; targetIdentity: string }[];
}

export type Exports = Record<string, any>;

/** Result of compile(): the compiled JS and the id used for prefix stripping. */
export interface CompileResult {
  /** Content-derived id used as the filename prefix during compilation.
   *  Must be passed to evaluate() so it can correctly strip the prefix
   *  from export map keys. */
  id: string;
  jsScript: JsScript;
  /** True only after the compiled JavaScript bundle has passed SES validation. */
  sesValidated?: true;
}

export interface EvaluateResult {
  main?: Exports;
  exportMap?: Record<string, Exports>;
  loadId?: string;
}

export interface EvaluateOptions {
  /**
   * Skip SES bundle validation for compiled JavaScript loaded from a trusted
   * cache entry. Direct callers should leave this unset.
   */
  skipBundleValidation?: boolean;
}

// A `Harness` wraps a flow of compiling, bundling, and executing typescript.
export interface Harness extends EventTarget {
  // Compiles `source` to JS without evaluation.
  compile(
    source: RuntimeProgram,
    options?: TypeScriptHarnessProcessOptions,
  ): Promise<CompileResult>;

  // Evaluates pre-compiled JS, returning exports.
  // `id` and `files` are the values from compilation — pass them through
  // to avoid recomputing and to prevent mismatches.
  evaluate(
    id: string,
    jsScript: JsScript,
    files: Source[],
    options?: EvaluateOptions,
  ): Promise<EvaluateResult>;

  // Compile + evaluate a program through the ESM module-record path (the
  // `esmModuleLoader` flag route), returning the same shape as `evaluate`.
  // Optional: present only on harnesses that implement the ESM loader.
  compileAndEvaluateModules?(
    program: RuntimeProgram,
    options?: TypeScriptHarnessProcessOptions,
  ): Promise<EvaluateResult>;

  // Compile a program to a verified ESM record graph, returning the graph plus
  // the per-module cache descriptors (in content-identity space). Split from
  // evaluation so a caller can write the descriptors to the content-addressed
  // cache between compile and evaluate. Optional (ESM-loader harnesses only).
  compileToRecordGraph?(
    program: RuntimeProgram,
    options?: TypeScriptHarnessProcessOptions,
  ): Promise<{
    id: string;
    graph: CompiledModuleGraph;
    mainSpecifier: string;
    entryIdentity: string;
    modules: CacheableModule[];
  }>;

  // Evaluate a verified ESM record graph produced by `compileToRecordGraph`.
  evaluateRecordGraph?(
    id: string,
    graph: CompiledModuleGraph,
    mainSpecifier: string,
    files: Source[],
  ): EvaluateResult;

  // Warm load: build + verify + evaluate a pattern directly from cached compiled
  // modules (by content identity) — no TS source, no resolve, no recompile.
  evaluateCachedModules?(
    modules: readonly CachedCompiledModule[],
    entryIdentity: string,
    options?: { sourceFiles?: Source[] },
  ): Promise<EvaluateResult>;

  // Cold recovery: recompile cacheable modules from the stored (already-resolved,
  // inject-transformed) source set — e.g. after a runtimeVersion bump.
  compileResolvedToRecordGraph?(
    resolvedFiles: Source[],
    entryFilename: string,
  ): Promise<{ modules: CacheableModule[]; entryIdentity: string }>;

  // Resolves a `ProgramResolver` into a `Program` using the engine's
  // configuration.
  resolve(
    source: ProgramResolver,
  ): Promise<Program>;

  invoke(fn: () => any): any;

  getInvocation(source: string): HarnessedFunction;

  getVerifiedLoadId?(
    implementationRef: string,
    patternId?: string,
  ): string | undefined;

  getVerifiedFunctionInLoad?(
    loadId: string,
    implementationRef: string,
  ): HarnessedFunction | undefined;

  isVerifiedSourceInLoad?(
    loadId: string,
    source: string,
  ): boolean;

  getVerifiedBundleId?(
    loadId: string,
  ): string | undefined;

  getVerifiedBindingMetadata?(
    implementationRef: string,
  ): { sourceFile?: string; bindingPath?: string[] } | undefined;

  registerVerifiedFunction?(
    loadId: string,
    implementationRef: string,
    implementation: HarnessedFunction,
  ): void;

  getExecutableFunction?(
    implementationRef: string,
    patternId?: string,
  ): HarnessedFunction | undefined;

  unsafeTrustHostValue(
    value: unknown,
    options: UnsafeHostTrustOptions,
  ): void;

  // Translate a source-location string (`/<id>/file.tsx:line:col`, as found on
  // an action's `src`) into a stable, content-addressed implementation hash
  // (`cf:module/<moduleHash>:line:col`). Returns undefined when the source
  // location does not correspond to a loaded module, in which case callers fall
  // back to the raw source location. See docs/specs/module-loading.md.
  implementationHashForSource?(sourceLocation: string): string | undefined;

  // Translate a bundle-prefixed source path (`/<programHash>/<authoredPath>`, as
  // returned by `mapPosition`) into the reload-stable canonical source
  // `cf:module/<moduleHash>/<authoredPath>`, keeping the authored path for
  // debuggability. Returns undefined for built-in / non-program sources, so
  // callers fall back to the raw value.
  canonicalModuleSource?(source: string): string | undefined;
}
