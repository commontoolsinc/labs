import type {
  Program,
  ProgramResolver,
  Source,
} from "@commonfabric/js-compiler";
import type { PatternCoverageSpan } from "@commonfabric/ts-transformers";
import type { PatternCoverageCollector } from "../pattern-coverage.ts";
import type { MemorySpace } from "../runtime.ts";
import type {
  CachedCompiledModule,
  CompiledModuleGraph,
  HoistRegistrationSink,
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
  // Trust the precompiled bodies on a FULL hit: skip the per-module SES body
  // verifier (`verifyCompiledModuleBody`). Set ONLY when the bodies came from an
  // integrity-gated read (the `compileCache` set, loaded with `requiredIntegrity`
  // via `loadCompiledClosure`) — the CFC integrity label, not the SES verifier,
  // is the security boundary for cache hits (see the threat model in
  // `docs/specs/module-loading.md` §"the persistent compilation cache"). Ignored
  // on a miss/partial hit: freshly compiled bodies are always SES-verified.
  // Never set for direct `precompiledModules` injection (untrusted bytes).
  trustedBodies?: boolean;
  /**
   * Enables fabric (cf:) imports for this compile: the space whose cell-cache
   * source docs fabric refs are fetched from and verified against. Absent means
   * any fabric specifier in the authored program is a compile error.
   */
  fabricImports?: FabricImportOptions;
}

export interface FabricImportOptions {
  space: MemorySpace;
  /**
   * Dev-only: resolve unpinned mutable refs by chasing the live pointer.
   * The resulting compile is NOT cacheable — module identity folds the
   * (unpinned) specifier text, so the chase result varies under a fixed
   * identity, and persisting it would make `pattern:`/`compileCache:` docs
   * key-unstable. The cell-cache write path enforces this
   * (`assertNoUnpinnedFabricImports`); callers that write compiled artifacts
   * back must never set this flag.
   */
  allowUnpinned?: boolean;
}

export interface ResolvedFabricPin {
  specifier: string;
  resolvedIdentity: string;
  chain: string[];
}

/** A cached/compiled per-module artifact: emitted JS plus optional metadata. */
export interface CompiledModuleArtifact {
  js: string;
  sourceMap?: unknown;
  patternCoverageSpans?: PatternCoverageSpan[];
  /** Compiler-issued policy manifests, transported separately from JS exports. */
  policyManifests?: readonly unknown[];
}

/**
 * Everything the content-addressed compilation cache needs to persist (and
 * later reload) one module, surfaced by `compileToRecordGraph` in identity
 * space — callers never see the engine's internal `/<id>` path prefix.
 */
export interface CacheableModule extends CompiledModuleArtifact {
  /** Prefix-free content identity (the `cf:module/<hash>` hash, no scheme). */
  identity: string;
  /** Normalized authored module path (no `/<id>` prefix; e.g. `/main.tsx`). */
  filename: string;
  /** Resolved TypeScript source whose bytes are folded into `identity`. */
  source: string;
  /** Internal import edges: specifier → the dependency module's identity. */
  imports: { specifier: string; targetIdentity: string }[];
}

export type Exports = Record<string, any>;

export interface EvaluateResult {
  main?: Exports;
  exportMap?: Record<string, Exports>;
  /**
   * Per-module namespaces keyed by content identity (the prefix-free
   * `cf:module/<identity>` hash). Lets the runner register every module in a
   * just-evaluated bundle into an in-memory identity->Pattern cache, so a later
   * by-identity load of a sub-pattern reuses the already-live module instead of
   * re-reading the closure from storage and re-evaluating it (CT-1623).
   * Populated only on the ESM evaluate paths.
   */
  exportsByIdentity?: Map<string, Exports>;
  /**
   * Hoist registrations collected during this evaluation (`__cfReg`): module
   * content identity → (symbol → live builder artifact). The PatternManager turns
   * each trusted entry into a content-addressed `{ identity, symbol }` reference
   * and indexes it for synchronous by-identity resolution.
   */
  registrationsByIdentity?: HoistRegistrationSink;
}

// A `Harness` wraps a flow of compiling, bundling, and executing typescript.
export interface Harness extends EventTarget {
  // Compile + evaluate a program through the ESM module-record path,
  // returning the entry exports plus the per-module export map.
  compileAndEvaluateModules(
    program: RuntimeProgram,
    options?: TypeScriptHarnessProcessOptions,
  ): Promise<EvaluateResult>;

  // Compile a program to a verified ESM record graph, returning the graph plus
  // the per-module cache descriptors (in content-identity space). Split from
  // evaluation so a caller can write the descriptors to the content-addressed
  // cache between compile and evaluate.
  compileToRecordGraph(
    program: RuntimeProgram,
    options?: TypeScriptHarnessProcessOptions,
  ): Promise<{
    id: string;
    graph: CompiledModuleGraph;
    mainSpecifier: string;
    entryIdentity: string;
    modules: CacheableModule[];
    resolvedPins: ResolvedFabricPin[];
  }>;

  // Evaluate a verified ESM record graph produced by `compileToRecordGraph`.
  evaluateRecordGraph(
    id: string,
    graph: CompiledModuleGraph,
    mainSpecifier: string,
    files: Source[],
  ): EvaluateResult;

  // Warm load: build + verify + evaluate a pattern directly from cached compiled
  // modules (by content identity) — no TS source, no resolve, no recompile.
  evaluateCachedModules(
    modules: readonly CachedCompiledModule[],
    entryIdentity: string,
    options?: {
      sourceFiles?: Source[];
      trustedBodies?: boolean;
      patternCoverage?: PatternCoverageCollector;
    },
  ): Promise<EvaluateResult>;

  // Cold recovery: recompile cacheable modules from the stored (already-resolved,
  // inject-transformed) source set — e.g. after a runtimeVersion bump.
  compileResolvedToRecordGraph(
    resolvedFiles: Source[],
    entryFilename: string,
    options?: {
      fabricImports?: FabricImportOptions;
      patternCoverage?: PatternCoverageCollector;
    },
  ): Promise<{ modules: CacheableModule[]; entryIdentity: string }>;

  // Resolves a `ProgramResolver` into a `Program` using the engine's
  // configuration.
  resolve(
    source: ProgramResolver,
  ): Promise<Program>;

  invoke(fn: () => any): any;

  getInvocation(source: string): HarnessedFunction;

  // Resolve a verified implementation function by its content-addressed
  // `{ identity, symbol }` entry ref — the strong (session-lifetime) index
  // behind serialized `$implRef`s. Unlike the bounded artifact index this
  // never evicts, so a `$implRef`-only graph stays resolvable for as long as
  // its module was verified-evaluated in this session.
  getVerifiedImplementation?(
    identity: string,
    symbol: string,
  ): HarnessedFunction | undefined;

  unsafeTrustHostValue(
    value: unknown,
    options: UnsafeHostTrustOptions,
  ): void;

  // Translate a bundle-prefixed source path (`/<programHash>/<authoredPath>`, as
  // returned by `mapPosition`) into the reload-stable canonical source
  // `cf:module/<moduleHash>/<authoredPath>`, keeping the authored path for
  // debuggability. Returns undefined for built-in / non-program sources, so
  // callers fall back to the raw value.
  canonicalModuleSource?(source: string): string | undefined;
}
