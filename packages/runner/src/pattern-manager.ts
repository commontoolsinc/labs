import { getLogger } from "@commonfabric/utils/logger";
import type { Source } from "@commonfabric/js-compiler";
import { compilerStack } from "./harness/deferred-compiler-stack.ts";
import { Module, Pattern } from "./builder/types.ts";
import {
  brandTrustedPattern,
  getArtifactEntryRef,
  getPatternProgram,
  isTrustedBuilderArtifact,
  isTrustedPattern,
  resolveOriginal,
  setArtifactEntryRef,
  setPatternProgram,
} from "./builder/pattern-metadata.ts";
import type { MemorySpace, Runtime } from "./runtime.ts";
import type { PatternCoverageCollector } from "./pattern-coverage.ts";
import { createRef } from "./create-ref.ts";
import type {
  CacheableModule,
  CompiledModuleArtifact,
  EvaluateResult,
  Exports,
  TypeScriptHarnessProcessOptions,
} from "./harness/types.ts";
import { RuntimeProgram } from "./harness/types.ts";
import type { CachedCompiledModule } from "./sandbox/module-record-compiler.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
} from "./storage/interface.ts";
import {
  compiledDocKey,
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
  loadVerifiedSourceClosure,
  ROOT_LINK_SPECIFIER,
  type SourceDoc,
  sourceDocKey,
  WRITE_TARGET_EDGE_SYNC_SCHEMA,
  writeCompiledDocs,
  writeSourceDocs,
} from "./compilation-cache/cell-cache.ts";
import {
  isFabricImportSpecifier,
  parseFabricRef,
  pinnedIdentity,
} from "./sandbox/fabric-import-specifier.ts";
import { fromURI, toURI } from "./uri-utils.ts";
import { isRecord } from "@commonfabric/utils/types";
import { interleaveCompileYield } from "./harness/compile-interleave.ts";

const logger = getLogger("pattern-manager");

// Bound for the in-memory identity->module cache. Higher than the pattern cache
// because a single bundle contributes one entry per module (a big space-root
// bundle is ~10 modules), and entries are cheap (a reference to an already-live
// namespace).
const MAX_EVALUATED_MODULE_CACHE_SIZE = 1000;

function throwableStorageError(error: CommitError): Error {
  if (error instanceof Error) return error;
  return Object.assign(new Error(error.message), {
    name: error.name,
    cause: error,
  });
}

function moduleByteCacheRuntimeVersion(
  runtimeVersion: string | undefined,
  options: { patternCoverage: boolean },
): string | undefined {
  if (runtimeVersion === undefined) return undefined;
  return options.patternCoverage
    ? `${runtimeVersion}/pattern-coverage`
    : runtimeVersion;
}

/**
 * Re-derive a stored module's fabric edges from its SOURCE text (source docs
 * deliberately do not store them as links). Unpinned specifiers are skipped:
 * they carry no target identity to link, and they cannot legitimately occur
 * here — the cell-cache write path refuses to persist modules with unpinned
 * fabric imports (`assertNoUnpinnedFabricImports`), so a skip only ever drops
 * an edge from data that predates that guard.
 */
function fabricImportRefsFromSource(
  doc: SourceDoc,
): CacheableModule["imports"] {
  // Deferred compiler stack (parses): source docs only reach this via
  // loadVerifiedSourceClosure, which awaits ensureCompilerStack().
  const { collectImportSpecifiers, ts } = compilerStack();
  const source: Source = { name: doc.filename, contents: doc.code };
  const refs: CacheableModule["imports"] = [];
  const seen = new Set<string>();
  for (
    const specifier of collectImportSpecifiers(
      source,
      ts.ScriptTarget.ES2023,
    )
  ) {
    if (!isFabricImportSpecifier(specifier)) continue;
    const ref = parseFabricRef(specifier);
    if (ref === undefined) continue;
    const targetIdentity = pinnedIdentity(ref);
    if (targetIdentity === undefined) continue;
    const key = `${specifier}\0${targetIdentity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ specifier, targetIdentity });
  }
  return refs;
}

function uniqueCacheableImports(
  imports: CacheableModule["imports"],
): CacheableModule["imports"] {
  const seen = new Set<string>();
  const out: CacheableModule["imports"] = [];
  for (const imp of imports) {
    const key = `${imp.specifier}\0${imp.targetIdentity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(imp);
  }
  return out;
}

export class PatternManager {
  // Single-flight dedup + in-memory result cache for `compileOrGetPattern`,
  // keyed by a content hash of the program (NOT a cell id, NOT the retired
  // patternId) so identical source returns one shared, already-compiled pattern
  // instance. The hash is computed with `createRef` purely as a stable digest
  // function — no `pattern:` cell is ever minted. Bounded FIFO to cap memory.
  private inProgressCompilations = new Map<string, Promise<Pattern>>();
  // Single-flight dedup for the expensive tail of `loadPatternByIdentity`
  // (storage closure read + SES evaluation), keyed by `${space}\0${identity}`.
  // Boot references the same entry several times at once (one load per
  // referencing piece/system pattern); without this every concurrent miss ran
  // its own full closure evaluation — measured as 4 identical 9-module SES
  // evals per cold worker boot, the multiplier behind most of the per-module
  // boot-floor buckets. Followers await the leader and then resolve their own
  // symbol from the indexes the leader's evaluation populated — the same path
  // a load arriving after completion takes.
  private inProgressByIdentityLoads = new Map<
    string,
    Promise<Pattern | undefined>
  >();
  // Content-hash → { compiled pattern, the space its closure was first written
  // into }. The space is tracked so a cross-space cache hit can replicate the
  // source/compiled closure into the requested space (see compileOrGetPattern):
  // identical source dedupes the expensive TS compile, but every space holding
  // a piece that points at the pattern still needs the closure persisted there
  // to reload by { identity, symbol } in a fresh runtime.
  private compiledByContent = new Map<
    string,
    { pattern: Pattern; space?: MemorySpace }
  >();
  // The forward value → {identity, symbol} map lives module-level in
  // builder/pattern-metadata.ts (`setArtifactEntryRef`/`getArtifactEntryRef`)
  // so builder-layer copy sites can carry refs onto derived copies without a
  // PatternManager handle.
  // THE in-memory reverse index for content-addressed builder artifacts: module
  // identity -> (symbol -> live value). The single source for
  // `artifactFromIdentitySync` (the inverse of the forward `valueToEntryRef`),
  // populated by ONE path (`indexArtifact`) from BOTH a module's `__cfReg`
  // registrations (hoists + non-exported top-level) AND its exports — so callers
  // never look in two places. SESSION-LIFETIME, deliberately unbounded (design
  // § Open questions 2, resolved): the sync resolution the list builtins and
  // refs-only pattern JSON depend on must never lose an artifact whose module
  // evaluated this session. Entries are live builder artifacts of evaluated
  // modules — the same order of retention the engine's strong implementation
  // index (E1) already committed to for their implementation functions.
  private addressableByIdentity = new Map<string, Map<string, unknown>>();
  // Bound for the module-NAMESPACE cache below (`modulesByIdentity`) only; its
  // misses recover through the async storage-backed load. Instance field so
  // tests can shrink it.
  private maxEvaluatedModuleCacheSize = MAX_EVALUATED_MODULE_CACHE_SIZE;
  // ESM content-addressed compile-cache instrumentation.
  private esmCacheStats = { hits: 0, misses: 0, byIdentityHits: 0 };
  // In-memory identity -> module-namespace cache (CT-1623). Populated for EVERY
  // module of an evaluated ESM bundle (keyed by prefix-free content identity),
  // so a by-identity load of a sub-pattern reuses the already-live module from
  // its parent's bundle instead of re-reading the closure from storage and
  // re-evaluating it in SES. Content-addressed, so a hit is always the same
  // bytes — never stale. Bounded (FIFO) to cap memory.
  private modulesByIdentity = new Map<string, { exports: Exports }>();
  // In-flight compiled-cache write-backs; awaited by flushCompileCacheWrites()
  // for graceful shutdown / deterministic tests. Cold compile write-backs are
  // awaited by compilePattern; recovery/replication paths may still run in the
  // background.
  private compileCacheWrites = new Set<Promise<unknown>>();
  // The subset of `compileCacheWrites` that are cold-compile closure
  // write-backs. Tracked separately so `replicateClosures` can await them
  // before reading the origin space — its own promise lives in
  // `compileCacheWrites`, so awaiting that whole set would deadlock on itself.
  private pendingCacheWriteBacks = new Set<Promise<unknown>>();
  // `${entryIdentity}\0${space}` closure replications already kicked off this
  // session (see `replicatePatternToSpace`). An entry is removed on failure so
  // the next child creation retries.
  private replicatedClosures = new Set<string>();

  constructor(readonly runtime: Runtime) {}

  /**
   * Counters for the ESM content-addressed compile cache:
   * - `byIdentityHits`: warm loads served directly by entry identity (no
   *   resolve, no compile — the fast path);
   * - `hits`: warm loads that still resolved but reused cached bodies (skipped
   *   only the TS compile);
   * - `misses`: cold compiles (also written back).
   */
  getCompileCacheStats(): {
    hits: number;
    misses: number;
    byIdentityHits: number;
  } {
    return { ...this.esmCacheStats };
  }

  /** Resolve once all in-flight compiled-cache write-backs have settled. */
  async flushCompileCacheWrites(): Promise<void> {
    await Promise.allSettled([...this.compileCacheWrites]);
  }

  /**
   * Attach a rehydration `program` to a hand-built pattern object (one with no
   * module-scope entry ref). The only surviving job of the old
   * `registerPattern`: source-bearing tests/builtins that construct a Pattern in
   * hand can associate its source so `getPatternProgram` (and thus
   * `getPatternFilesBySync`) returns it. No-op when the pattern already carries a
   * program. Walks to the derivation root so a copy inherits the association.
   */
  associatePatternProgram(
    pattern: Pattern | Module,
    src: RuntimeProgram | string,
  ): void {
    const root = resolveOriginal(pattern as Pattern);
    if (getPatternProgram(root)) return;
    if (typeof src === "string") {
      setPatternProgram(root, {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: src }],
      });
    } else {
      setPatternProgram(root, src);
    }
  }

  /**
   * Give a hand-built pattern a content-addressed `{ identity, symbol }` pointer
   * and index it so `artifactFromIdentitySync` / `loadPatternByIdentity` resolve
   * it in-session — the manual analog of what `compilePattern` does for an ESM
   * pattern. The caller asserts trust for `pattern` (same host-trust model as
   * `Runtime.unsafeTrustPattern`); the pattern is branded so it is treated as a
   * verified-loaded pattern. SESSION-ONLY: there is no source/compiled closure
   * behind a synthetic identity, so a fresh-runtime reload of such a pointer is
   * unrecoverable. Intended for runner internals and tests that exercise the
   * by-identity resume path without a compiled bundle.
   */
  associatePatternIdentity(
    pattern: Pattern,
    ref: { identity: string; symbol: string },
  ): void {
    brandTrustedPattern(pattern);
    this.indexArtifact(ref.identity, ref.symbol, pattern);
  }

  /**
   * The session pointer for a KEYLESS (hand-built) pattern — one with no
   * content-addressed entry ref (it never went through an ESM compile). The
   * identity is a CONTENT hash of the pattern's structure (`createRef`), so two
   * structurally-identical hand-built patterns share one identity: a lift that
   * returns the same sub-pattern shape on every run does not churn its result
   * cell's pointer (the CT-1623 structural-dedup property the old per-structure
   * patternId provided). The pattern is branded + indexed so
   * `artifactFromIdentitySync` / `loadPatternByIdentity` resolve it. SESSION-ONLY
   * (no source/compiled closure behind a hand-built structure hash).
   */
  ensureKeylessPatternIdentity(
    pattern: Pattern,
  ): { identity: string; symbol: string } {
    const root = resolveOriginal(pattern);
    const existing = getArtifactEntryRef(root);
    if (existing) return existing;
    const identity = `keyless:${fromURI(toURI(createRef(root, "pattern")))}`;
    const ref = { identity, symbol: "default" };
    this.associatePatternIdentity(root, ref);
    return ref;
  }

  /**
   * Make a cross-space child piece independently loadable from its own space
   * (CT-1687). A fresh runtime navigating to a `Factory.inSpace(...)` child
   * loads pattern artifacts from the CHILD's space — but the parent bundle's
   * compile-cache write-back targets the space the parent compiled into, so the
   * child space had nothing and the load died with "has no stored source".
   * Replicates the content-addressed source + compiled closures into `toSpace`
   * when the pattern carries an artifact entry ref (the by-identity reload path
   * — the only one a `{ identity, symbol }` piece pointer can take).
   *
   * Closure replication is fire-and-forget (tracked in `compileCacheWrites`,
   * awaited by `flushCompileCacheWrites`): the child is loadable in-session
   * regardless, this only affects fresh runtimes. A failure is logged and
   * retried on the next child creation — never on the caller's commit path.
   */
  replicatePatternToSpace(
    pattern: Pattern | Module,
    toSpace: MemorySpace,
    fromSpace: MemorySpace,
  ): void {
    if (toSpace === fromSpace) return;

    const entryRef = this.getArtifactEntryRef(pattern);
    if (!entryRef) return;
    const dedupeKey = `${entryRef.identity}\0${toSpace}`;
    if (this.replicatedClosures.has(dedupeKey)) return;
    this.replicatedClosures.add(dedupeKey);
    const replication = this.replicateClosures(
      entryRef.identity,
      fromSpace,
      toSpace,
    ).catch((error) => {
      // Release the claim so a later child creation retries.
      this.replicatedClosures.delete(dedupeKey);
      logger.error("closure-replication-failed", () => [
        `entry=${entryRef.identity}`,
        `from=${fromSpace}`,
        `to=${toSpace}`,
        String(error),
      ]);
    });
    this.compileCacheWrites.add(replication);
    replication.finally(() => this.compileCacheWrites.delete(replication));
  }

  /**
   * Copy the closures reachable from `entryIdentity` out of `fromSpace` into
   * `toSpace`, rebuilding the emitted-module shape the write functions expect.
   * All-or-nothing: a partial compiled closure can never be served (the loaders
   * require a full, integrity-valid hit), so an incomplete origin set throws
   * instead of persisting an unservable copy.
   */
  private async replicateClosures(
    entryIdentity: string,
    fromSpace: MemorySpace,
    toSpace: MemorySpace,
    visited = new Set<string>(),
  ): Promise<void> {
    const visitKey = `${fromSpace}\0${toSpace}\0${entryIdentity}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    // The origin-space closure may have been produced by THIS session's cold
    // compile, whose write-back is itself fire-and-forget and may not have
    // committed yet. A lost race would throw here — and for a handler-created
    // child (one space per profile) nothing re-fires the released dedupe key,
    // leaving that child permanently unloadable. Await the in-flight
    // write-backs first. (Their own set, not flushCompileCacheWrites: this
    // replication promise is tracked there and would await itself.)
    await Promise.allSettled([...this.pendingCacheWriteBacks]);
    // Replicate the same cached variant the compile path uses — the coverage
    // suffix keeps an instrumented closure from being served under an ordinary
    // key (and vice versa).
    const runtimeVersion = moduleByteCacheRuntimeVersion(
      await getCompileCacheRuntimeVersion(),
      { patternCoverage: this.runtime.patternCoverage !== undefined },
    );
    const readTx = this.runtime.edit();
    let sourceDocs;
    let compiledDocs;
    try {
      // Verification recomputes module identities with the default ("")
      // runtimeFingerprint — the same default every compile path in the tree
      // uses today. If a non-empty fingerprint is ever threaded into
      // compilation, it must be threaded here too or verification will
      // reject every closure (logged as replication failures).
      sourceDocs = await loadVerifiedSourceClosure(
        this.runtime,
        fromSpace,
        entryIdentity,
        readTx,
      );
      if (runtimeVersion === undefined) {
        compiledDocs = undefined;
      } else {
        const cacheOpts = { runtimeVersion };
        compiledDocs = await loadCompiledClosure(
          this.runtime,
          fromSpace,
          entryIdentity,
          cacheOpts,
          readTx,
        );
      }
    } finally {
      readTx.abort?.("closure-replication read complete");
    }
    if (!sourceDocs?.has(entryIdentity)) {
      throw new Error("source closure unavailable in origin space");
    }
    const modules: CacheableModule[] = [];
    const fabricDependencies = new Set<string>();
    for (const [identity, doc] of sourceDocs) {
      const compiled = compiledDocs?.get(identity);
      if (runtimeVersion !== undefined && !compiled) {
        throw new Error(`compiled doc missing for ${identity}`);
      }
      const fabricImports = fabricImportRefsFromSource(doc);
      for (const imp of fabricImports) {
        fabricDependencies.add(imp.targetIdentity);
      }
      modules.push({
        identity,
        filename: doc.filename,
        source: doc.code,
        js: compiled?.code ?? "",
        ...(compiled?.sourceMap !== undefined
          ? { sourceMap: compiled.sourceMap }
          : {}),
        // The write functions re-derive the entry's root links; keep only the
        // real import edges.
        imports: uniqueCacheableImports([
          ...doc.imports
            .filter((imp) => !imp.specifier.startsWith(ROOT_LINK_SPECIFIER))
            .map((imp) => ({
              specifier: imp.specifier,
              targetIdentity: imp.identity,
            })),
          ...fabricImports,
        ]),
      });
    }
    const { error } = await this.runtime.editWithRetry((tx) => {
      writeSourceDocs(this.runtime, toSpace, modules, entryIdentity, tx);
      if (runtimeVersion !== undefined) {
        writeCompiledDocs(
          this.runtime,
          toSpace,
          modules,
          entryIdentity,
          { runtimeVersion },
          tx,
        );
      }
    });
    if (error) throw error;

    for (const dependencyIdentity of fabricDependencies) {
      await this.replicateClosures(
        dependencyIdentity,
        fromSpace,
        toSpace,
        visited,
      );
    }
  }

  async compilePattern(
    input: string | RuntimeProgram,
    cacheCtx?: {
      space: MemorySpace;
      tx?: IExtendedStorageTransaction;
      // When the entry module's content identity is already known (e.g. stored
      // in pattern metadata from a prior compile), the ESM cache path loads the
      // compiled closure by identity and skips resolve + compile entirely.
      knownEntryIdentity?: string;
      // Invoked once the entry module's content identity is known for this
      // compile (warm-by-identity or cold). Lets the caller persist it (e.g.
      // into pattern metadata) so subsequent loads can take the fast path.
      onEntryIdentity?: (entryIdentity: string) => void;
    },
  ): Promise<Pattern> {
    let program: RuntimeProgram;
    if (typeof input === "string") {
      program = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: input }],
      };
    } else {
      program = input;
    }

    // Use the content-addressed cell cache when we have a target space and
    // CFC is enforced (the compiled-set integrity label only persists — and
    // is only trusted on read — under an enforcing mode; see cell-cache).
    if (cacheCtx && this.runtime.cfcEnforcementMode !== "disabled") {
      return await this.compileViaCellCache(program, cacheCtx);
    }
    const patternCoverage = this.patternCoverageFor();
    const { id, graph, mainSpecifier, entryIdentity } = await this.runtime
      .harness.compileToRecordGraph(
        program,
        {
          ...(cacheCtx ? { fabricImports: { space: cacheCtx.space } } : {}),
          ...(patternCoverage ? { patternCoverage } : {}),
        },
      );
    cacheCtx?.onEntryIdentity?.(entryIdentity);
    // evaluateRecordGraph is a single synchronous SES stretch; in the browser
    // worker, yield first so event-loop work queued behind the compile runs
    // before it, not after. No-op in Deno, where it would be batch overhead.
    await interleaveCompileYield();
    const result = this.runtime.harness.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    return this.patternFromEvaluation(result, program);
  }

  /**
   * Compile + evaluate a program's modules AND register the evaluated artifacts,
   * returning the full module namespace (`EvaluateResult`).
   *
   * This is the load seam for callers that need the raw evaluated namespace —
   * `main.default`, a named `fetchMocks` export, multi-user descriptors — rather
   * than the single `Pattern` that `compilePattern` returns. It is the reason the
   * CLI pattern-test harness and the multi-user worker previously reached for the
   * lower-level `Engine.compileAndEvaluateModules` directly and skipped
   * registration (CT-1811): map/filter/flatMap ops then had no content-addressed
   * entry ref and fell back to a defer-corrupted embedded graph instead of their
   * canonical `$patternRef` artifact.
   *
   * Registration is fused with evaluation here on purpose, so it cannot be
   * forgotten — mirroring what the runtime's own `compilePattern` /
   * `patternFromEvaluation` load path does. Reach for the bare
   * `Engine.compileAndEvaluateModules` only to inspect serialized/verified output
   * *without running* (engine unit tests), where stamping entry refs is unwanted.
   */
  /**
   * The pattern-coverage collector to instrument a compile with: a per-call
   * option wins, else the runtime-level default (`RuntimeOptions.patternCoverage`).
   * Undefined leaves the compile uninstrumented.
   */
  private patternCoverageFor(
    options?: TypeScriptHarnessProcessOptions,
  ): PatternCoverageCollector | undefined {
    return options?.patternCoverage ?? this.runtime.patternCoverage;
  }

  async compileAndRegisterModules(
    program: RuntimeProgram,
    options?: TypeScriptHarnessProcessOptions,
  ): Promise<EvaluateResult> {
    const patternCoverage = this.patternCoverageFor(options);
    const effectiveOptions: TypeScriptHarnessProcessOptions = {
      ...options,
      patternCoverage,
    };
    const byteCache = this.runtime.moduleByteCache;
    const runtimeVersion = byteCache === undefined
      ? undefined
      : moduleByteCacheRuntimeVersion(
        await getCompileCacheRuntimeVersion(),
        { patternCoverage: patternCoverage !== undefined },
      );
    if (byteCache === undefined || runtimeVersion === undefined) {
      const result = await this.runtime.harness.compileAndEvaluateModules(
        program,
        effectiveOptions,
      );
      this.registerEvaluatedModules(result);
      return result;
    }

    const { id, graph, mainSpecifier, modules } = await this.runtime.harness
      .compileToRecordGraph(program, {
        ...effectiveOptions,
        precompiledModulesFor: ({ identities }) =>
          Promise.resolve(byteCache.getCompleteSet(runtimeVersion, identities)),
      });
    byteCache.putAll(runtimeVersion, modules);
    // Yield ahead of the synchronous SES evaluation (see compilePattern).
    await interleaveCompileYield();
    const result = this.runtime.harness.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    this.registerEvaluatedModules(result);
    return result;
  }

  /**
   * ESM compile + evaluate backed by the content-addressed cell cache in
   * `cacheCtx.space`. On a warm full hit the per-module compiled bodies are
   * reused (no TypeScript compile / transformer pipeline / SES re-verify); on a
   * miss the program is compiled and its modules are written back (source +
   * integrity-stamped compiled docs) on a fresh transaction before returning.
   */
  private async compileViaCellCache(
    program: RuntimeProgram,
    cacheCtx: {
      space: MemorySpace;
      tx?: IExtendedStorageTransaction;
      knownEntryIdentity?: string;
      onEntryIdentity?: (entryIdentity: string) => void;
    },
  ): Promise<Pattern> {
    const harness = this.runtime.harness;
    const { space } = cacheCtx;
    const patternCoverage = this.patternCoverageFor();
    // The instrumented compile is a distinct cached variant: the coverage suffix
    // keeps its compiled bytes from colliding with an ordinary compile of the
    // same source under one key, and makes a coverage-on runtime miss (and
    // recompile-with-coverage) rather than reuse uninstrumented bytes. Source
    // docs are keyed by content identity, not by this version, so they stay
    // shared — a coverage run reuses the persisted source and only recompiles.
    const runtimeVersion = moduleByteCacheRuntimeVersion(
      await getCompileCacheRuntimeVersion(),
      { patternCoverage: patternCoverage !== undefined },
    );
    if (runtimeVersion === undefined) {
      const { id, graph, mainSpecifier, entryIdentity, modules } = await harness
        .compileToRecordGraph(
          program,
          {
            fabricImports: { space },
            ...(patternCoverage ? { patternCoverage } : {}),
          },
        );
      await this.persistSourceCacheTracked(space, modules, entryIdentity);
      cacheCtx.onEntryIdentity?.(entryIdentity);
      // Yield ahead of the synchronous SES evaluation (see compilePattern).
      await interleaveCompileYield();
      const result = harness.evaluateRecordGraph(
        id,
        graph,
        mainSpecifier,
        program.files,
      );
      return this.patternFromEvaluation(result, program, entryIdentity);
    }
    const cacheOpts = { runtimeVersion };

    // Fast path — warm load BY IDENTITY: if the entry's content identity is
    // already known (stored from a prior compile), load the compiled closure
    // directly and build+evaluate from it, skipping `resolve` and `compile`
    // entirely. Falls through to the compile path on any miss/incompleteness
    // (evaluateCachedModules re-verifies the graph, so an incomplete closure
    // throws and we recompile).
    if (cacheCtx.knownEntryIdentity) {
      const byIdentity = await this.tryWarmLoadByIdentity(
        cacheCtx.knownEntryIdentity,
        space,
        cacheOpts,
        program,
      );
      if (byIdentity) {
        this.esmCacheStats.byIdentityHits++;
        cacheCtx.onEntryIdentity?.(cacheCtx.knownEntryIdentity);
        return byIdentity;
      }
    }

    // Read the cache on a dedicated, owned transaction (used read-only — the
    // load path only reads, and it is aborted below, never committed) so
    // cache-cell reads never enter the caller's transaction (whose commit must
    // not gain dependencies on the write-back), and so repeated compiles don't
    // accumulate open transactions.
    const readTx = this.runtime.edit();

    const byteCache = this.runtime.moduleByteCache;
    // The per-space storage closure served the full module set (already durable
    // in this space, so no write-back needed).
    let warmHit = false;
    // The process-level byte cache served the full module set, skipping the
    // transform-and-emit step (the TypeScript program build, type-check, the
    // type-driven CF transformer, and the emit — `compileToModules`). The bytes
    // are durable in the byte cache but NOT necessarily in this space's persisted
    // cache, so this still triggers a write-back.
    let processServed = false;
    let compiled;
    try {
      compiled = await harness.compileToRecordGraph(program, {
        fabricImports: { space },
        // A miss below falls through to a fresh compile; instrument it when
        // coverage is on so the recompiled bytes carry the hit calls. A warm hit
        // reuses bytes a prior coverage compile already instrumented (the coverage
        // suffix on `runtimeVersion` keeps the two variants apart).
        ...(patternCoverage ? { patternCoverage } : {}),
        // The bodies returned below come either from the process byte cache or
        // from `loadCompiledClosure`, an integrity-gated (`requiredIntegrity`,
        // fail-closed) read of the compiled set. On a full hit the byte cache's
        // provenance (see the channel below) / the CFC integrity label is the
        // security boundary, so skip the redundant per-module SES re-verification
        // (threat model: docs/specs/module-loading.md). A partial/miss returns
        // undefined below → fresh compile → bodies are SES-verified as usual.
        trustedBodies: true,
        precompiledModulesFor: async ({ entryIdentity, identities }) => {
          // Process byte cache first (cross-runtime, cross-space): a full hit
          // skips BOTH the transform-and-emit step (`compileToModules`: TS
          // program build, type-check, CF transform, emit) and the per-space
          // storage read. Trust by provenance: bytes this process compiled were
          // SES-verified then; bytes a test seeded from a CI disk file were not —
          // those are trusted via the workflow's cache key, which fingerprints
          // every compile input. Either path is test/CI-only: nothing in
          // production installs a byte cache.
          if (byteCache) {
            const bodies = byteCache.getCompleteSet(
              cacheOpts.runtimeVersion,
              identities,
            );
            if (bodies) {
              processServed = true;
              return bodies;
            }
          }
          // Concurrency-safe timing: explicit start (no shared timer key, which
          // parallel compiles would clobber). Same for the others below.
          const readStart = performance.now();
          const closure = await loadCompiledClosure(
            this.runtime,
            space,
            entryIdentity,
            cacheOpts,
            readTx,
          );
          logger.time(readStart, "compile-cache", "read");
          // Full hit only: every emitted module must be present (and
          // integrity-valid). A partial set cannot be trusted (transitively
          // sensitive identities), so fall back to a full recompile.
          if (!identities.every((identity) => closure.has(identity))) {
            return undefined;
          }
          const bodies = new Map<string, CompiledModuleArtifact>();
          for (const [identity, doc] of closure) {
            bodies.set(identity, {
              js: doc.code,
              ...(doc.sourceMap === undefined
                ? {}
                : { sourceMap: doc.sourceMap }),
              ...(doc.policyManifests === undefined
                ? {}
                : { policyManifests: doc.policyManifests }),
            });
          }
          warmHit = true;
          return bodies;
        },
      });
    } finally {
      // Release the read-only cache transaction (no commit needed) so repeated
      // compiles don't accumulate open transactions.
      readTx.abort?.("compile-cache read complete");
    }
    const { id, graph, mainSpecifier, entryIdentity, modules } = compiled;
    cacheCtx.onEntryIdentity?.(entryIdentity);

    // Populate the process byte cache with this program's module bytes (freshly
    // compiled, or reused from storage). Idempotent and content-addressed, so a
    // redundant put is harmless. A later runtime or space then reuses these
    // modules instead of re-transforming them.
    byteCache?.putAll(cacheOpts.runtimeVersion, modules);

    // Yield ahead of the synchronous SES evaluation (see compilePattern).
    await interleaveCompileYield();
    const evalStart = performance.now();
    const result = harness.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    logger.time(evalStart, "compile-cache", "evaluate");

    if (warmHit) {
      // The per-space storage closure was just READ from this space, i.e. it is
      // already durable here — no write-back.
      this.esmCacheStats.hits++;
    } else {
      this.esmCacheStats[processServed ? "hits" : "misses"]++;
      // Persist the module set into this space. AWAITED (identity E4): refs-only
      // pattern JSON makes artifact persistence part of the compilation
      // contract — a cell can only carry a `$patternRef` after compilePattern
      // returned, so completing the write here guarantees every persisted ref
      // has a durable closure behind it (no race against session end). This
      // covers BOTH a cold compile AND a process-byte-cache hit: in the latter
      // the transform-and-emit step was skipped, but this space's persisted
      // cache may be empty (e.g. a fresh space), and the by-identity reload path
      // needs the closure here. A failed write fails the compile: persisted
      // refs-only pattern JSON would otherwise point at a closure that is not
      // durable in `space`.
      await this.persistCompileCacheTracked(
        space,
        modules,
        entryIdentity,
        cacheOpts,
      );
    }

    return this.patternFromEvaluation(result, program, entryIdentity);
  }

  /**
   * Resolve-free warm load: fetch the integrity-valid compiled closure for
   * `entryIdentity` and build + evaluate the pattern directly from those cached
   * bodies (no `resolve`, no `compile`). Returns the pattern, or `undefined`
   * if the closure is absent/incomplete/invalid (caller then recompiles).
   */
  private async tryWarmLoadByIdentity(
    entryIdentity: string,
    space: MemorySpace,
    cacheOpts: { runtimeVersion: string },
    program: RuntimeProgram,
  ): Promise<Pattern | undefined> {
    const harness = this.runtime.harness;
    // `cacheOpts.runtimeVersion` already selects the coverage variant, so the
    // bodies read below carry probes exactly when this is set.
    const patternCoverage = this.patternCoverageFor();
    const readTx = this.runtime.edit();
    let closure;
    try {
      const readStart = performance.now();
      closure = await loadCompiledClosure(
        this.runtime,
        space,
        entryIdentity,
        cacheOpts,
        readTx,
      );
      logger.time(readStart, "compile-cache", "read-by-identity");
    } finally {
      readTx.abort?.("compile-cache by-identity read complete");
    }
    if (!closure.has(entryIdentity)) return undefined;

    const cachedModules: CachedCompiledModule[] = [...closure].map(
      ([identity, doc]) => ({
        identity,
        filename: doc.filename,
        code: doc.code,
        ...(doc.sourceMap !== undefined
          ? { sourceMap: doc.sourceMap as never }
          : {}),
        // Fix B: carry the precomputed record surface so the boot record build
        // skips the in-worker parse (absent on legacy docs → parse fallback).
        ...(doc.exportNames !== undefined
          ? { exportNames: doc.exportNames }
          : {}),
        ...(doc.starTargetSpecs !== undefined
          ? { starTargetSpecs: doc.starTargetSpecs }
          : {}),
        ...(doc.importSpecs !== undefined
          ? { importSpecs: doc.importSpecs }
          : {}),
        // The spans naming the lines this body's coverage probes stand for.
        ...(doc.patternCoverageSpans !== undefined
          ? { patternCoverageSpans: doc.patternCoverageSpans }
          : {}),
        // Drop the synthetic entry→root links (cfc.ts etc.); only real
        // require/export-* edges resolve module records.
        imports: doc.imports
          .filter((i) => !i.specifier.startsWith(ROOT_LINK_SPECIFIER))
          .map((i) => ({ specifier: i.specifier, targetIdentity: i.identity })),
      }),
    );

    try {
      const result = await harness.evaluateCachedModules(
        cachedModules,
        entryIdentity,
        // Bodies came from the integrity-gated compiled-set read
        // (`loadCompiledClosure`, `requiredIntegrity`), so the CFC label is the
        // security boundary — skip redundant SES body re-verification.
        {
          sourceFiles: program.files,
          trustedBodies: true,
          ...(patternCoverage ? { patternCoverage } : {}),
        },
      );
      return this.patternFromEvaluation(result, program, entryIdentity);
    } catch (error) {
      // Incomplete/invalid cached closure — fall back to recompile.
      logger.warn("compile-cache-by-identity-miss", () => [
        `entry=${entryIdentity}`,
        String(error),
      ]);
      return undefined;
    }
  }

  /**
   * Load a pattern referenced purely by content identity — the
   * `{identity, symbol}` result-cell reference — the ONLY pattern pointer. The
   * resolution chain is: in-memory live module → integrity-valid compiled
   * closure → cold recompile from the verified `pattern:<identity>` source-doc
   * closure ({@link tryColdLoadByIdentity}, which survives a
   * runtime-version change). No TypeScript program in hand, no meta cell — the
   * source docs are the single durable source.
   *
   * Returns the pattern, or `undefined` when the by-identity load is
   * unavailable (CFC not enforcing / closure absent or incomplete / invalid /
   * no stored source). A piece carrying only a legacy `pattern` link (no
   * `patternIdentity`) is unrecoverable — the sanctioned data-wipe outcome.
   */
  async loadPatternByIdentity(
    entryIdentity: string,
    symbol: string,
    space: MemorySpace,
  ): Promise<Pattern | undefined> {
    // In-memory artifact index: the pattern may already be live this session —
    // an evaluated ESM artifact, or a hand-built pattern given a synthetic
    // pointer via `associatePatternIdentity`. This path is independent of the
    // compiled cache (and of CFC enforcement), so it serves the same artifact
    // `artifactFromIdentitySync` would return.
    const indexed = this.addressableByIdentity.get(entryIdentity)?.get(symbol);
    if (indexed !== undefined && isTrustedPattern(indexed)) {
      this.esmCacheStats.byIdentityHits++;
      return indexed;
    }
    if (this.runtime.cfcEnforcementMode === "disabled") {
      return undefined;
    }
    // In-memory fast path (CT-1623): the module may already be live from a
    // parent bundle's evaluation (e.g. a sub-pattern of the just-loaded
    // space root). Reuse it directly — no storage closure read, no SES re-eval.
    const live = this.patternFromEvaluatedModule(entryIdentity, symbol);
    if (live) {
      this.esmCacheStats.byIdentityHits++;
      return live;
    }
    // Single-flight the expensive tail (see `inProgressByIdentityLoads`).
    const key = `${space}\0${entryIdentity}`;
    const pending = this.inProgressByIdentityLoads.get(key);
    if (pending === undefined) {
      const load = this.loadPatternByIdentityFromStorage(
        entryIdentity,
        symbol,
        space,
      ).finally(() => this.inProgressByIdentityLoads.delete(key));
      this.inProgressByIdentityLoads.set(key, load);
      return await load;
    }
    // Follower: the leader's evaluation indexes every symbol of the closure,
    // so after it settles the in-memory lookups above serve this call. Its
    // failure is the leader caller's to surface; this call retries on its own
    // behalf below.
    await pending.catch(() => {});
    // Back through the front door: hits the now-populated indexes in the
    // common case. If the leader failed or did not surface this symbol, the
    // in-flight entry is gone, so this call becomes the leader of its own
    // attempt — the same load it would have run without dedup. Each pass
    // consumes a settled leader, so the recursion is bounded by the number of
    // concurrent callers.
    return await this.loadPatternByIdentity(entryIdentity, symbol, space);
  }

  /**
   * The storage-backed tail of {@link loadPatternByIdentity}: closure read,
   * SES evaluation, artifact indexing, and the cold-load recovery fallbacks.
   * Callers must hold the single-flight slot for `(space, entryIdentity)`.
   */
  private async loadPatternByIdentityFromStorage(
    entryIdentity: string,
    symbol: string,
    space: MemorySpace,
  ): Promise<Pattern | undefined> {
    const harness = this.runtime.harness;
    const patternCoverage = this.patternCoverageFor();
    // Select the same cached variant the compile path wrote. A coverage-on
    // runtime resumes from the instrumented closure; reading the ordinary key
    // here would serve uninstrumented bodies for an instrumented run.
    const runtimeVersion = moduleByteCacheRuntimeVersion(
      await getCompileCacheRuntimeVersion(),
      { patternCoverage: patternCoverage !== undefined },
    );
    if (runtimeVersion === undefined) {
      return await this.tryColdLoadByIdentity(entryIdentity, symbol, space);
    }
    const cacheOpts = { runtimeVersion };

    const readTx = this.runtime.edit();
    let closure;
    try {
      const readStart = performance.now();
      closure = await loadCompiledClosure(
        this.runtime,
        space,
        entryIdentity,
        cacheOpts,
        readTx,
      );
      logger.time(readStart, "compile-cache", "load-pattern-by-identity");
    } finally {
      readTx.abort?.("load-pattern-by-identity read complete");
    }
    if (!closure.has(entryIdentity)) {
      return await this.tryColdLoadByIdentity(
        entryIdentity,
        symbol,
        space,
        cacheOpts,
      );
    }

    const cachedModules: CachedCompiledModule[] = [...closure].map(
      ([identity, doc]) => ({
        identity,
        filename: doc.filename,
        code: doc.code,
        ...(doc.sourceMap !== undefined
          ? { sourceMap: doc.sourceMap as never }
          : {}),
        // Fix B: carry the precomputed record surface (parse fallback if absent).
        ...(doc.exportNames !== undefined
          ? { exportNames: doc.exportNames }
          : {}),
        ...(doc.starTargetSpecs !== undefined
          ? { starTargetSpecs: doc.starTargetSpecs }
          : {}),
        ...(doc.importSpecs !== undefined
          ? { importSpecs: doc.importSpecs }
          : {}),
        // The spans naming the lines this body's coverage probes stand for.
        ...(doc.patternCoverageSpans !== undefined
          ? { patternCoverageSpans: doc.patternCoverageSpans }
          : {}),
        imports: doc.imports
          .filter((i) => !i.specifier.startsWith(ROOT_LINK_SPECIFIER))
          .map((i) => ({ specifier: i.specifier, targetIdentity: i.identity })),
      }),
    );

    try {
      // Source-free: no sourceFiles. Sub-patterns fall back to identity.
      // Bodies came from the integrity-gated compiled-set read
      // (`loadCompiledClosure`, `requiredIntegrity`), so trust the CFC label and
      // skip redundant SES body re-verification.
      const result = await harness.evaluateCachedModules(
        cachedModules,
        entryIdentity,
        {
          trustedBodies: true,
          ...(patternCoverage ? { patternCoverage } : {}),
        },
      );
      const pattern = this.patternFromMain(result, symbol, entryIdentity);
      this.esmCacheStats.byIdentityHits++;
      return pattern;
    } catch (error) {
      logger.warn("load-pattern-by-identity-miss", () => [
        `entry=${entryIdentity}`,
        `symbol=${symbol}`,
        String(error),
      ]);
      return await this.tryColdLoadByIdentity(
        entryIdentity,
        symbol,
        space,
        cacheOpts,
      );
    }
  }

  /**
   * Runtime-version-bump recovery for a content-addressed pattern reference:
   * recompile from the verified source closure, letting fabric imports refetch
   * their own source closures from the same space.
   */
  private async tryColdLoadByIdentity(
    entryIdentity: string,
    symbol: string,
    space: MemorySpace,
    cacheOpts?: { runtimeVersion: string },
  ): Promise<Pattern | undefined> {
    const harness = this.runtime.harness;
    const readTx = this.runtime.edit();
    let sourceDocs;
    try {
      sourceDocs = await loadVerifiedSourceClosure(
        this.runtime,
        space,
        entryIdentity,
        readTx,
      );
    } finally {
      readTx.abort?.("load-pattern-by-identity source read complete");
    }
    if (sourceDocs === undefined) return undefined;
    const entry = sourceDocs.get(entryIdentity);
    if (entry === undefined) return undefined;

    const sourceFiles: Source[] = [...sourceDocs.values()].map((doc) => ({
      name: doc.filename,
      contents: doc.code,
    }));

    const patternCoverage = this.patternCoverageFor();
    try {
      const compiled = await harness.compileResolvedToRecordGraph(
        sourceFiles,
        entry.filename,
        {
          fabricImports: { space },
          ...(patternCoverage ? { patternCoverage } : {}),
        },
      );
      if (compiled.entryIdentity !== entryIdentity) {
        throw new Error(
          `source closure recompiled to ${compiled.entryIdentity}, expected ${entryIdentity}`,
        );
      }
      const cachedModules: CachedCompiledModule[] = compiled.modules.map(
        (module) => ({
          identity: module.identity,
          filename: module.filename,
          code: module.js,
          ...(module.sourceMap !== undefined
            ? { sourceMap: module.sourceMap as never }
            : {}),
          // The spans naming the lines this body's coverage probes stand for.
          ...(module.patternCoverageSpans !== undefined
            ? { patternCoverageSpans: module.patternCoverageSpans }
            : {}),
          imports: module.imports,
        }),
      );
      const result = await harness.evaluateCachedModules(
        cachedModules,
        entryIdentity,
        {
          sourceFiles,
          ...(patternCoverage ? { patternCoverage } : {}),
        },
      );
      const pattern = this.patternFromMain(result, symbol, entryIdentity);
      if (cacheOpts !== undefined) {
        const writeBack = this.writeBackCompileCache(
          space,
          compiled.modules,
          entryIdentity,
          cacheOpts,
        ).catch((error) => {
          logger.warn("load-pattern-by-identity-writeback-failed", () => [
            `entry=${entryIdentity}`,
            `symbol=${symbol}`,
            String(error),
          ]);
        });
        this.compileCacheWrites.add(writeBack);
        this.pendingCacheWriteBacks.add(writeBack);
        writeBack.finally(() => {
          this.compileCacheWrites.delete(writeBack);
          this.pendingCacheWriteBacks.delete(writeBack);
        });
      }
      return pattern;
    } catch (error) {
      logger.warn("load-pattern-by-identity-source-miss", () => [
        `entry=${entryIdentity}`,
        `symbol=${symbol}`,
        String(error),
      ]);
      return undefined;
    }
  }

  /**
   * Build a pattern object from an evaluation result by export `symbol`, with
   * NO program attached (the source-free by-identity path). Mirrors
   * `patternFromEvaluation` minus `setPatternProgram` — recovery of the program
   * happens by identity via the source closure, not from the pattern object.
   */
  private patternFromMain(
    result: EvaluateResult,
    symbol: string,
    entryIdentity: string,
  ): Pattern {
    this.registerEvaluatedModules(result);
    const { main } = result;
    if (!main) {
      throw new Error("Pattern compilation produced no exports.");
    }
    // Usually an authored export, but a map/filter/flatMap `op` reloads by a
    // transformer HOIST symbol (`__cfReg`, e.g. `__cfPattern_1`) that is not an
    // export — `registerEvaluatedModules` above indexed it, so resolve it there.
    const pattern =
      (symbol in main
        ? main[symbol]
        : this.addressableByIdentity.get(entryIdentity)?.get(symbol)) as
          | Pattern
          | undefined;
    if (!pattern) {
      throw new Error(
        `No "${symbol}" export or hoist registration found in compiled pattern.`,
      );
    }
    // Trust gate stays pattern-only on purpose: the forward
    // `{ identity, symbol }` ref for a NON-pattern artifact was already set by
    // `registerEvaluatedModules` via `indexArtifact`, whose gate is the wider
    // `isTrustedBuilderArtifact` — narrowing `indexArtifact` would drop
    // exported lift/handler forward refs (the gap Codex flagged on an earlier
    // revision of #3912).
    if (isTrustedPattern(pattern)) {
      setArtifactEntryRef(pattern, { identity: entryIdentity, symbol });
    }
    return pattern;
  }

  /**
   * Index every module of a just-evaluated ESM bundle by its content identity
   * (CT-1623). Lets `loadPatternByIdentity` reuse a sub-pattern module already
   * evaluated as part of its parent's bundle — no storage read, no SES re-eval.
   *
   * Public because it is the shared indexing step every path that RUNS a
   * just-evaluated pattern must perform: the runtime's own load path calls it via
   * `patternFromEvaluation`, and the namespace load seam `compileAndRegisterModules`
   * (used by the CLI test harness and the multi-user worker) calls it too.
   * Skipping it leaves anonymous map/filter/flatMap ops un-indexed, so
   * `getArtifactEntryRef` misses and the op falls back to its embedded graph
   * instead of the content-addressed canonical artifact — the CT-1811 defer
   * corruption. It is deliberately NOT folded into `Engine.compileAndEvaluateModules`,
   * since that primitive is also used to inspect serialized/verified output
   * without running (engine unit tests), where the side effect of stamping entry
   * refs is unwanted — `compileAndRegisterModules` is the fused seam callers use to
   * run. Idempotent per identity (re-registering refreshes the LRU), so paths that
   * already registered are unaffected.
   */
  registerEvaluatedModules(result: EvaluateResult): void {
    const byId = result.exportsByIdentity;
    if (byId) {
      for (const [identity, exports] of byId) {
        // `modulesByIdentity` keeps the whole namespace for MODULE reuse on a
        // by-identity reload (a separate concern from artifact addressing).
        // Refresh insertion order (Map is FIFO-ordered) so eviction is ~LRU.
        this.modulesByIdentity.delete(identity);
        this.modulesByIdentity.set(identity, { exports });
        // Index each exported builder artifact for addressing by its export name.
        // (Reload relies on this so a sub-pattern's result cell loads BY IDENTITY
        // instead of cold-recompiling — CT-1623.)
        for (const exportName of Object.keys(exports)) {
          if (exportName === "__esModule") continue;
          this.indexArtifact(identity, exportName, exports[exportName]);
        }
      }
      while (this.modulesByIdentity.size > this.maxEvaluatedModuleCacheSize) {
        const oldest = this.modulesByIdentity.keys().next().value;
        if (oldest === undefined) break;
        this.modulesByIdentity.delete(oldest);
      }
    }

    // Index the hoisted + non-exported top-level builder artifacts the module
    // registered via `__cfReg`, into the SAME index as the exports above.
    const sink = result.registrationsByIdentity;
    if (sink) {
      for (const [identity, entries] of sink) {
        for (const [symbol, value] of entries) {
          this.indexArtifact(identity, symbol, value);
        }
      }
    }

    // No eviction for `addressableByIdentity` — the artifact index is
    // session-lifetime (see its declaration): sync by-identity resolution
    // must keep working for every module evaluated this session.
  }

  /**
   * Index one content-addressed builder artifact `{ identity, symbol } -> value`,
   * the single path that populates both the reverse `addressableByIdentity` and
   * forward `valueToEntryRef` maps — whether the value came from a module's
   * `__cfReg` registration (hoists + non-exported top-level) or its exports.
   *
   * SECURITY: only a genuine trusted builder artifact (pattern / lift / handler —
   * `isTrustedBuilderArtifact`) is indexed. A `__cf_data`-forged plain object
   * carries no brand and is dropped, so it can never acquire a content-addressed
   * reference or be handed back as a trusted value. (Cross-module forgery is
   * independently impossible: identity is a content hash, so a module can only
   * register under its own bytes' identity.)
   */
  private indexArtifact(
    identity: string,
    symbol: string,
    value: unknown,
  ): void {
    if (!isTrustedBuilderArtifact(value)) return;
    // Reverse index. Overwrite an existing symbol so a re-evaluation of the
    // same identity resolves to the FRESH artifact instance, not a stale one
    // from a prior eval.
    let bucket = this.addressableByIdentity.get(identity);
    if (!bucket) {
      bucket = new Map<string, unknown>();
      this.addressableByIdentity.set(identity, bucket);
    }
    bucket.set(symbol, value);
    // Forward map is FIRST-WRITE-WINS, deliberately, on two grounds:
    //   - One artifact instance legitimately reachable under two refs (e.g. both
    //     a `__cfReg` entry AND an export, or set first by `patternFromMain`)
    //     keeps a single canonical `{ identity, symbol }` for serialization.
    //   - The reverse index above already overwrote, so by-identity LOOKUP
    //     (`artifactFromIdentitySync`) is always fresh; the forward ref only
    //     needs to be A valid name for the value, not the newest.
    // Caveat: if the SAME instance is later re-registered under a CHANGED
    // identity (a content edit that preserves object identity across re-eval),
    // the forward ref stays pinned to the original — acceptable because the
    // value is, by content identity, the original. `getArtifactEntryRef`
    // consumers tolerate this (it resolves to a real, addressable artifact).
    setArtifactEntryRef(value, { identity, symbol });
    // Note: content-addressed CFC provenance is recorded by the engine at
    // evaluation time (Engine.recordModuleProvenance) — the single home, so it
    // covers every load path, not only ones routed through this indexing.
  }

  /**
   * Resolve a content-addressed `{ identity, symbol }` reference to its live
   * builder artifact, synchronously, from the single in-memory index — or
   * `undefined` on a miss (the module never evaluated in this session; callers
   * fall back to a stored graph vintage or an async source reload). The index
   * is session-lifetime, so a hit is guaranteed for any module evaluated this
   * session — what the list builtins rely on to resolve a map/filter/flatMap
   * `op` during a synchronous Action without an embedded fallback graph.
   */
  artifactFromIdentitySync(
    identity: string,
    symbol: string,
  ): unknown {
    // Returns the live builder artifact (pattern / lift / handler). Callers know
    // the kind they expect from the symbol's origin and cast accordingly.
    return this.addressableByIdentity.get(identity)?.get(symbol);
  }

  /**
   * Best-effort authored source files for a live pattern by its content
   * `{ identity, symbol }` — the source-viewing debug surface
   * (`getPatternSources`). Returns undefined when the pattern is not live in
   * this session or carries no program (e.g. a source-free by-identity
   * reload); callers degrade gracefully (omit the pattern). Source-bearing
   * cross-session recovery is the source-doc closure's job, not this.
   */
  getPatternFilesBySync(
    identity: string,
    symbol: string,
  ): { name: string; contents: string }[] | undefined {
    const pattern = this.artifactFromIdentitySync(identity, symbol) as
      | Pattern
      | undefined;
    if (!pattern) return undefined;
    return getPatternProgram(pattern)?.files;
  }

  /**
   * Reuse a module already evaluated in-memory (as part of any bundle) for a
   * by-identity load, skipping the storage closure read + SES re-evaluation.
   * Returns undefined on a miss so the caller falls back to the cache path.
   */
  private patternFromEvaluatedModule(
    entryIdentity: string,
    symbol: string,
  ): Pattern | undefined {
    const cached = this.modulesByIdentity.get(entryIdentity);
    if (!cached) return undefined;
    // The symbol is usually an authored export, but a map/filter/flatMap `op`
    // result cell references a transformer HOIST (`__cfReg`, e.g. `__cfPattern_1`)
    // which is NOT a module export — it lives in the artifact index. Resolving it
    // there (instead of falling through to a cold source recompile) is what keeps
    // a reloaded op compile-free (CT-1623).
    const pattern =
      (symbol in cached.exports
        ? cached.exports[symbol]
        : this.addressableByIdentity.get(entryIdentity)?.get(symbol)) as
          | Pattern
          | undefined;
    if (!pattern || !isTrustedPattern(pattern)) return undefined;
    // Refresh recency.
    this.modulesByIdentity.delete(entryIdentity);
    this.modulesByIdentity.set(entryIdentity, cached);
    setArtifactEntryRef(pattern, { identity: entryIdentity, symbol });
    return pattern;
  }

  /**
   * Write the module set into `space` and AWAIT it, tracking the in-flight
   * promise in `compileCacheWrites` + `pendingCacheWriteBacks` (so graceful
   * shutdown and closure replication can observe it). A failure PROPAGATES and
   * fails the compile: refs-only pattern JSON makes a durable closure in `space`
   * part of the compilation contract.
   */
  private async persistCompileCacheTracked(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
    opts: { runtimeVersion: string },
  ): Promise<void> {
    const writeBack = this.writeBackCompileCache(
      space,
      modules,
      entryIdentity,
      opts,
    );
    this.compileCacheWrites.add(writeBack);
    this.pendingCacheWriteBacks.add(writeBack);
    try {
      await writeBack;
    } finally {
      this.compileCacheWrites.delete(writeBack);
      this.pendingCacheWriteBacks.delete(writeBack);
    }
  }

  private async persistSourceCacheTracked(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
  ): Promise<void> {
    const writeBack = this.writeBackSourceCache(space, modules, entryIdentity);
    this.compileCacheWrites.add(writeBack);
    this.pendingCacheWriteBacks.add(writeBack);
    try {
      await writeBack;
    } finally {
      this.compileCacheWrites.delete(writeBack);
      this.pendingCacheWriteBacks.delete(writeBack);
    }
  }

  private async writeBackSourceCache(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
  ): Promise<void> {
    const writebackStart = performance.now();
    await this.syncSourceCacheWriteTargets(space, modules);
    const { error } = await this.runtime.editWithRetry((tx) => {
      writeSourceDocs(this.runtime, space, modules, entryIdentity, tx);
    });
    logger.time(writebackStart, "compile-cache", "source-writeback");
    if (error) {
      logger.error("source-cache-writeback-failed", () => [
        `entry=${entryIdentity}`,
        error.message,
      ]);
      throw throwableStorageError(error);
    }
  }

  /**
   * Write the source + compiled document sets for an emitted module set into
   * `space`, on its own transaction, independent of the caller's. Uses
   * `editWithRetry` so a commit conflict (e.g. the cache write racing the
   * pattern's own space writes) retries rather than silently dropping the
   * entry. A final failure throws because persisted refs-only pattern JSON
   * requires a durable closure behind every `$patternRef`.
   */
  private async writeBackCompileCache(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
    opts: { runtimeVersion: string },
  ): Promise<void> {
    const writebackStart = performance.now();
    await this.syncCompileCacheWriteTargets(space, modules, opts);
    // The write-back re-writes source docs whose values carry quote-cell
    // indirections (one derived doc per import edge). On a cold replica those
    // derived docs are unknown, and each commit attempt discovers exactly ONE
    // of them: the engine rejects on the first stale read, editWithRetry
    // pulls that doc, and only then does the next attempt's diff reach the
    // following one (CT-1824, live-traced on the browser rig — the system-app
    // closure re-write conflicts on ~24 pre-existing edge docs, one per
    // round). Convergence therefore needs one retry per pre-existing derived
    // doc; the general DEFAULT_MAX_RETRIES (5) exhausts long before that and
    // the cache never heals, so every later cold boot recompiles. Budget by
    // the write set's edge count (source + compiled edge docs) with slack.
    // Rounds are bounded by actual conflicts — a conflict-free write-back
    // still commits on the first attempt — so the ceiling is only paid during
    // recovery after a compiler-version bump.
    const importEdges = modules.reduce((n, m) => n + m.imports.length, 0);
    const writebackMaxRetries = Math.max(16, 2 * importEdges + 8);
    const { error } = await this.runtime.editWithRetry((tx) => {
      writeSourceDocs(this.runtime, space, modules, entryIdentity, tx);
      writeCompiledDocs(this.runtime, space, modules, entryIdentity, opts, tx);
    }, writebackMaxRetries);
    logger.time(writebackStart, "compile-cache", "writeback");
    if (error) {
      logger.error("compile-cache-writeback-failed", () => [
        `entry=${entryIdentity}`,
        error.message,
      ]);
      throw throwableStorageError(error);
    }
  }

  // Write-target pre-syncs carry the one-hop edge selector (CT-1848): a
  // schema-less sync delivers only the root doc, leaving the per-edge element
  // docs unknown to the replica, so a re-write of pre-existing docs touches
  // them blind and conflicts one engine round per edge (the CT-1824 loop).
  // With the edge docs materialized up front the write-back diffs against
  // true state and commits on the first attempt; the retry budget in
  // writeBackCompileCache remains as a backstop. Same-microtask syncs batch
  // into a single server round trip.
  private async syncSourceCacheWriteTargets(
    space: MemorySpace,
    modules: readonly CacheableModule[],
  ): Promise<void> {
    await Promise.all(
      modules.map((module) =>
        this.runtime.getCell(
          space,
          sourceDocKey(module.identity),
          WRITE_TARGET_EDGE_SYNC_SCHEMA,
        ).sync()
      ),
    );
  }

  private async syncCompileCacheWriteTargets(
    space: MemorySpace,
    modules: readonly CacheableModule[],
    opts: { runtimeVersion: string },
  ): Promise<void> {
    await Promise.all(
      modules.flatMap((module) => [
        this.runtime.getCell(
          space,
          sourceDocKey(module.identity),
          WRITE_TARGET_EDGE_SYNC_SCHEMA,
        ).sync(),
        this.runtime.getCell(
          space,
          compiledDocKey(opts.runtimeVersion, module.identity),
          WRITE_TARGET_EDGE_SYNC_SCHEMA,
        ).sync(),
      ]),
    );
  }

  // Resolve a Pattern from an evaluate result.
  private patternFromEvaluation(
    result: EvaluateResult,
    program: RuntimeProgram,
    entryIdentity?: string,
  ): Pattern {
    this.registerEvaluatedModules(result);
    const { main } = result;
    if (!main) {
      throw new Error("Pattern compilation produced no exports.");
    }
    const exportName = program.mainExport ?? "default";
    if (!(exportName in main)) {
      throw new Error(
        `No "${exportName}" export found in compiled pattern.`,
      );
    }
    const pattern = main[exportName] as Pattern;
    // Only a trusted (builder-produced) entry pattern receives rehydration
    // metadata; a forged pattern-shaped export gets none and so cannot
    // masquerade as a verified-loaded pattern in the side-tables.
    if (isTrustedPattern(pattern)) {
      setPatternProgram(pattern, program);
      if (entryIdentity) {
        setArtifactEntryRef(pattern, {
          identity: entryIdentity,
          symbol: exportName,
        });
      }
    }
    return pattern;
  }

  /**
   * The content-addressed `{ identity, symbol }` reference for a builder artifact
   * (pattern / lift / handler), if known (learned on the ESM path). Lets callers
   * persist a result cell's reference so the artifact reloads straight from the
   * compiled cache. Returns undefined for legacy/AMD artifacts.
   */
  getArtifactEntryRef(
    value: object,
  ): { identity: string; symbol: string } | undefined {
    // Exact object first, then the derivation root — handled by the
    // module-level store (refs are indexed post-evaluation, after build-time
    // copies were made, so the lookup walks the derivation link lazily).
    return getArtifactEntryRef(value);
  }

  /**
   * Compile a pattern from source, or return a cached/in-flight result.
   * Provides single-flight deduplication based on program content.
   *
   * @param input - Source code string or RuntimeProgram to compile
   * @param space - When provided, routes the ESM compile through the
   *   content-addressed cell cache in this space (CT-1623): cold compiles write
   *   their module set back, and subsequent loads of the same source skip the TS
   *   compile. Without it (e.g. tests), compilation is uncached as before.
   * @returns The compiled pattern (from cache, in-flight compilation, or new)
   */
  compileOrGetPattern(
    input: string | RuntimeProgram,
    space?: MemorySpace,
  ): Promise<Pattern> {
    // Normalize to RuntimeProgram
    let program: RuntimeProgram;
    if (typeof input === "string") {
      program = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: input }],
      };
    } else {
      program = input;
    }

    // Content-hash key (createRef as a pure digest, NOT a cell id). Identical
    // source returns the same compiled instance; concurrent compiles share one
    // evaluation.
    const dedupeKey = toURI(createRef({ src: program }, "pattern source"));

    const cached = this.compiledByContent.get(dedupeKey);
    if (cached) {
      // Refresh recency (FIFO ~LRU).
      this.compiledByContent.delete(dedupeKey);
      this.compiledByContent.set(dedupeKey, cached);
      // The content cache is space-agnostic, but a piece persisted in `space`
      // needs the source/compiled closure IN that space to reload by
      // { identity, symbol } in a fresh runtime (the meta-cell fallback is
      // gone). When this hit serves a different space than the one we first
      // compiled into, replicate the closure there — cheap (no TS recompile),
      // deduped, and fire-and-forget (tracked in compileCacheWrites).
      if (space && cached.space && space !== cached.space) {
        this.replicatePatternToSpace(cached.pattern, space, cached.space);
      }
      return Promise.resolve(cached.pattern);
    }

    const inProgress = this.inProgressCompilations.get(dedupeKey);
    if (inProgress) return inProgress;

    // Pass the cell-cache context when a space is available so nested/dynamic
    // compiles benefit from the cache too.
    const compilationPromise = this.compilePattern(
      program,
      space ? { space } : undefined,
    )
      .then((pattern) => {
        this.compiledByContent.set(dedupeKey, { pattern, space });
        while (this.compiledByContent.size > MAX_EVALUATED_MODULE_CACHE_SIZE) {
          const oldest = this.compiledByContent.keys().next().value;
          if (oldest === undefined) break;
          this.compiledByContent.delete(oldest);
        }
        return pattern;
      })
      .finally(() => {
        this.inProgressCompilations.delete(dedupeKey);
      });

    this.inProgressCompilations.set(dedupeKey, compilationPromise);
    return compilationPromise;
  }

  /**
   * Best-effort authored source program for a stored pattern by its content
   * `entryIdentity` — recovered from the verified `pattern:<identity>` source-doc
   * closure in `space`. The single-source replacement for the deleted meta
   * cell's `program`: the source docs are written (awaited) by every cold
   * compile, so this returns the same bytes that produced the identity. `main`
   * is the entry document's authored filename. Returns `undefined` when no
   * verified source closure exists in the space.
   */
  async getPatternSourceProgramByIdentity(
    entryIdentity: string,
    space: MemorySpace,
  ): Promise<
    { main: string; files: { name: string; contents: string }[] } | undefined
  > {
    const readTx = this.runtime.edit();
    let sourceDocs;
    try {
      sourceDocs = await loadVerifiedSourceClosure(
        this.runtime,
        space,
        entryIdentity,
        readTx,
      );
    } finally {
      readTx.abort?.("get-pattern-source-files read complete");
    }
    if (sourceDocs === undefined) return undefined;
    const entry = sourceDocs.get(entryIdentity);
    if (entry === undefined) return undefined;
    // Return only the AUTHORED files — the faithful replacement for the old
    // meta-cell `program`. The verified source closure also contains
    // runtime-INJECTED helper modules (e.g. `cfc.ts`), which the compiler
    // resolves WITHOUT the `/<id>/` prefix (see Engine), so authored files are
    // exactly the grounded (`/`-prefixed) ones. The full closure is used for
    // recompilation via `loadVerifiedSourceClosure` directly, not here.
    return {
      main: entry.filename,
      files: [...sourceDocs.values()]
        .filter((doc) => doc.filename.startsWith("/"))
        .map((doc) => ({
          name: doc.filename,
          contents: doc.code,
        })),
    };
  }

  /**
   * Attach an optional, NON-NORMATIVE annotation link to a pattern's entry
   * source doc (`pattern:<identity>` in `space`). Annotations are product
   * metadata (a name doc, a spec doc, lineage); the runtime NEVER reads them for
   * execution, and `verifySourceDocs` excludes them from the content hash — an
   * annotated and an unannotated doc verify identically. First-write semantics
   * are last-write-wins per `key` (the merge below). Fire-and-forget at the
   * caller's discretion.
   */
  async annotatePattern(
    entryIdentity: string,
    space: MemorySpace,
    key: string,
    link: unknown,
  ): Promise<void> {
    await this.runtime.editWithRetry((tx) => {
      const cell = this.runtime.getCell<
        { annotations?: Record<string, unknown> }
      >(
        space,
        sourceDocKey(entryIdentity),
        undefined,
        tx,
      );
      const current = cell.get();
      const annotations = {
        ...(isRecord(current?.annotations) ? current!.annotations : {}),
        [key]: link,
      };
      cell.key("annotations").set(annotations);
    });
  }
}
