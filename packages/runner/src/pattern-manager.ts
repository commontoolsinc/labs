import { getLogger } from "@commonfabric/utils/logger";
import { isPattern, Module, Pattern, Schema } from "./builder/types.ts";
import {
  getArtifactEntryRef,
  getPatternProgram,
  getVerifiedLoadId,
  isTrustedBuilderArtifact,
  isTrustedPattern,
  resolveOriginal,
  setArtifactEntryRef,
  setPatternProgram,
  setVerifiedLoadId,
} from "./builder/pattern-metadata.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { Cell, createCell } from "./cell.ts";
import type { MemorySpace, Runtime } from "./runtime.ts";
import { createRef } from "./create-ref.ts";
import type {
  CacheableModule,
  CompiledModuleArtifact,
  EvaluateResult,
  Exports,
} from "./harness/types.ts";
import { RuntimeProgram } from "./harness/types.ts";
import type { CachedCompiledModule } from "./sandbox/module-record-compiler.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import {
  COMPILE_CACHE_RUNTIME_VERSION,
  loadCompiledClosure,
  ROOT_LINK_SPECIFIER,
  writeCompiledDocs,
  writeSourceDocs,
} from "./compilation-cache/cell-cache.ts";
import { getTopFrame } from "./builder/pattern.ts";
import { URI } from "./sigil-types.ts";
import { toURI } from "./uri-utils.ts";
import { parseLink } from "./link-utils.ts";
import { isRecord } from "@commonfabric/utils/types";

const logger = getLogger("pattern-manager");

/**
 * Maximum number of patterns to cache in memory.
 * When exceeded, oldest (least recently used) patterns are evicted.
 * Set conservatively to prevent OOM in long-running processes and tests.
 */
const MAX_PATTERN_CACHE_SIZE = 100;
// Bound for the in-memory identity->module cache. Higher than the pattern cache
// because a single bundle contributes one entry per module (a big space-root
// bundle is ~10 modules), and entries are cheap (a reference to an already-live
// namespace).
const MAX_EVALUATED_MODULE_CACHE_SIZE = 1000;

export const patternMetaSchema = internSchema(
  {
    type: "object",
    properties: {
      spec: { type: "string" },
      parents: { type: "array", items: { type: "string" } },
      patternName: { type: "string" },
      // Content identity of the entry module (the prefix-free `cf:module/<hash>`
      // minus the scheme), learned on the first cold ESM compile. Persisting it
      // here is what makes the resolve-free by-identity fast path fire on every
      // later load: `compilePatternOnce` reads it back and passes it as
      // `knownEntryIdentity`. Absent on legacy/AMD patterns (the load simply
      // falls back to resolve + compile, then re-learns + stores it).
      entryIdentity: { type: "string" },
      program: {
        type: "object",
        properties: {
          main: { type: "string" },
          mainExport: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                contents: { type: "string" },
              },
              required: ["name", "contents"],
            },
          },
        },
        required: ["main", "files"],
      },
    },
  },
);

export type PatternMeta = Schema<typeof patternMetaSchema>;

export class PatternManager {
  private inProgressCompilations = new Map<string, Promise<Pattern>>();
  // Maps keyed by patternId for consistent lookups
  private patternMetaCellById = new Map<string, Cell<PatternMeta>>();
  private patternIdMap = new Map<URI, Pattern>();
  // Map from pattern object instance to patternId
  private patternToIdMap = new WeakMap<Pattern, URI>();
  // The forward value → {identity, symbol} map lives module-level in
  // builder/pattern-metadata.ts (`setArtifactEntryRef`/`getArtifactEntryRef`)
  // so builder-layer copy sites can carry refs onto derived copies without a
  // PatternManager handle.
  // THE in-memory reverse index for content-addressed builder artifacts: module
  // identity -> (symbol -> live value). The single source for
  // `artifactFromIdentitySync` (the inverse of the forward `valueToEntryRef`),
  // populated by ONE path (`indexArtifact`) from BOTH a module's `__cfReg`
  // registrations (hoists + non-exported top-level) AND its exports — so callers
  // never look in two places. Bounded (FIFO); a miss returns undefined and
  // callers fall back (e.g. to an embedded op graph or a source reload).
  private addressableByIdentity = new Map<string, Map<string, unknown>>();
  private patternToVerifiedLoadId = new WeakMap<Pattern, string>();
  // Pending metadata set before the meta cell exists (e.g., spec, parents)
  private pendingMetaById = new Map<URI, Partial<PatternMeta>>();
  // ESM content-addressed compile-cache instrumentation.
  private esmCacheStats = { hits: 0, misses: 0, byIdentityHits: 0 };
  // In-memory identity -> module-namespace cache (CT-1623). Populated for EVERY
  // module of an evaluated ESM bundle (keyed by prefix-free content identity),
  // so a by-identity load of a sub-pattern reuses the already-live module from
  // its parent's bundle instead of re-reading the closure from storage and
  // re-evaluating it in SES. Content-addressed, so a hit is always the same
  // bytes — never stale. Bounded (FIFO) to cap memory.
  private modulesByIdentity = new Map<
    string,
    { exports: Exports; loadId?: string }
  >();
  // In-flight compiled-cache write-backs (fire-and-forget); awaited by
  // flushCompileCacheWrites() for graceful shutdown / deterministic tests.
  private compileCacheWrites = new Set<Promise<unknown>>();

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
   * Evict oldest patterns if cache exceeds MAX_PATTERN_CACHE_SIZE.
   * Uses Map insertion order for LRU - oldest entries are first.
   */
  private evictIfNeeded(): void {
    while (this.patternIdMap.size > MAX_PATTERN_CACHE_SIZE) {
      const oldestId = this.patternIdMap.keys().next().value;
      if (oldestId === undefined) break;

      // Remove from all caches
      this.patternIdMap.delete(oldestId);
      this.patternMetaCellById.delete(oldestId);
      // Note: patternToIdMap is WeakMap, will be GC'd when pattern is collected

      logger.debug(
        "pattern-manager",
        `Evicted pattern ${oldestId} (cache size: ${this.patternIdMap.size})`,
      );
    }
  }

  /**
   * Touch a pattern to mark it as recently used (moves to end of Map).
   * Call this on cache hits to maintain LRU order.
   */
  private touchPattern(patternId: URI): void {
    const pattern = this.patternIdMap.get(patternId);
    if (pattern) {
      // Re-insert to move to end (most recently used)
      this.patternIdMap.delete(patternId);
      this.patternIdMap.set(patternId, pattern);
    }

    const metaCell = this.patternMetaCellById.get(patternId);
    if (metaCell) {
      this.patternMetaCellById.delete(patternId);
      this.patternMetaCellById.set(patternId, metaCell);
    }
  }

  private getPatternMetaCell(
    { patternId, space }: { patternId: URI; space: MemorySpace },
    tx?: IExtendedStorageTransaction,
  ): Cell<PatternMeta> {
    return createCell(
      this.runtime,
      {
        id: patternId,
        path: [],
        space,
        schema: patternMetaSchema,
      },
      tx,
      true,
    );
  }

  /** Legacy fallback: read pattern meta from the old {patternId, type: "pattern"} cause. */
  private getLegacyPatternMetaCell(
    { patternId, space }: { patternId: URI; space: MemorySpace },
    tx?: IExtendedStorageTransaction,
  ): Cell<PatternMeta> {
    return this.runtime.getCell(
      space,
      { patternId, type: "pattern" },
      patternMetaSchema,
      tx,
    );
  }

  /**
   * Get the patternId for a pattern or module object.
   * Returns undefined if the pattern is not registered.
   */
  getPatternId(pattern: Pattern | Module): URI | undefined {
    return this.patternToIdMap.get(
      this.findOriginalPattern(pattern as Pattern),
    );
  }

  private findOriginalPattern(pattern: Pattern): Pattern {
    // Derivation links live in the module-level side table (pattern-metadata);
    // the former `unsafe_originalPattern` symbol backref is gone.
    return resolveOriginal(pattern);
  }

  // Roots already fully seeded per verifiedLoadId. The walk is idempotent
  // and pattern graphs are frozen after load, but it re-ran on every
  // by-identity cache hit (i.e. every map/filter op resolve), paying a full
  // Reflect.ownKeys recursion over the pattern graph each time — ~24% of the
  // commit-callback phase in the default-app profile.
  #seededVerifiedRoots = new WeakMap<object, Set<string>>();

  private seedVerifiedLoadIds(
    value: unknown,
    verifiedLoadId: string,
    seen?: Map<unknown, boolean>,
    trusted = false,
  ): void {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return;
    }
    const isRoot = seen === undefined;
    if (
      isRoot && this.#seededVerifiedRoots.get(value)?.has(verifiedLoadId)
    ) {
      return;
    }
    seen ??= new Map<unknown, boolean>();

    // Trust is rooted at a builder-produced (`isTrustedPattern`) value; nested
    // subpatterns within a trusted pattern's serialized node graph are legit
    // (and unbranded), so once inside a trusted subtree we propagate to
    // structurally-`isPattern` values too. A `__cf_data`-forged pattern-shaped
    // value at the top level (trusted === false) is never seeded, so it cannot
    // launder a CFC identity into the side-tables.
    const subtreeTrusted = trusted || isTrustedPattern(value);

    // `seen` records the trust level a node was visited at, so a node reached
    // first via an untrusted path is still re-processed (and seeded) when later
    // reached via a trusted path — order-independent. A trusted visit is final.
    const prior = seen.get(value);
    if (prior === true || (prior === false && !subtreeTrusted)) {
      return;
    }
    seen.set(value, subtreeTrusted);

    if (subtreeTrusted && isPattern(value)) {
      const originalPattern = this.findOriginalPattern(value);
      if (!this.patternToVerifiedLoadId.has(originalPattern)) {
        this.patternToVerifiedLoadId.set(originalPattern, verifiedLoadId);
      }
      // Side-table storage works even when `value` has been frozen by the
      // loader (no own-property write needed).
      if (getVerifiedLoadId(value) !== verifiedLoadId) {
        setVerifiedLoadId(value, verifiedLoadId);
      }
    }

    for (const key of Reflect.ownKeys(value as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
      if (!descriptor || !("value" in descriptor)) {
        continue;
      }
      this.seedVerifiedLoadIds(
        descriptor.value,
        verifiedLoadId,
        seen,
        subtreeTrusted,
      );
    }

    if (isRoot) {
      let ids = this.#seededVerifiedRoots.get(value as object);
      if (ids === undefined) {
        ids = new Set();
        this.#seededVerifiedRoots.set(value as object, ids);
      }
      ids.add(verifiedLoadId);
    }
  }

  async loadPatternMeta(
    patternId: URI,
    space: MemorySpace,
  ): Promise<PatternMeta> {
    const cell = this.getPatternMetaCell({ patternId, space });
    await cell.sync();
    if (cell.get() !== undefined) {
      // Cache so sync getPatternMeta({ patternId }) works afterward
      this.patternMetaCellById.set(patternId, cell);
      return cell.get();
    }

    // Fall back to legacy {patternId, type: "pattern"} cause
    const legacyPatternCell = this.getLegacyPatternMetaCell({
      patternId,
      space,
    });
    await legacyPatternCell.sync();
    if (legacyPatternCell.get() !== undefined) {
      this.patternMetaCellById.set(patternId, legacyPatternCell);
      return legacyPatternCell.get();
    }

    throw new Error("missing pattern meta cell");
  }

  getPatternMeta(
    input: Pattern | Module | { patternId: URI },
  ): PatternMeta {
    let patternId: URI | undefined;
    if ("patternId" in input) {
      patternId = input.patternId;
    } else if (
      input && (typeof input === "object" || typeof input === "function")
    ) {
      patternId = this.patternToIdMap.get(
        this.findOriginalPattern(input as Pattern),
      );
    }

    if (!patternId) throw new Error("Pattern is not registered");

    const cell = this.patternMetaCellById.get(patternId);
    if (cell) {
      const meta = cell.get();
      if (meta) return meta;
    }

    // If we don't have a stored cell yet, return whatever pending/meta we have
    const pending = this.pendingMetaById.get(patternId) ?? {};
    const source = getPatternProgram(this.patternIdMap.get(patternId));
    if (!source && Object.keys(pending).length === 0) {
      throw new Error(`Pattern ${patternId} has no metadata available`);
    }
    const meta: PatternMeta = {
      ...(typeof source === "object" ? { program: source } : {}),
      ...(pending as Partial<PatternMeta>),
    } as PatternMeta;
    return meta;
  }

  registerPattern(
    pattern: Pattern | Module,
    src?: RuntimeProgram,
  ): URI {
    // Walk up derivation copies to original
    pattern = this.findOriginalPattern(pattern as Pattern);
    const verifiedLoadId = getTopFrame()?.verifiedLoadId ??
      this.patternToVerifiedLoadId.get(pattern as Pattern) ??
      getVerifiedLoadId(pattern as Pattern);
    if (verifiedLoadId) {
      this.seedVerifiedLoadIds(pattern as Pattern, verifiedLoadId);
    }

    if (src && !getPatternProgram(pattern)) {
      if (typeof src === "string") {
        setPatternProgram(pattern, {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: src }],
        });
      } else {
        setPatternProgram(pattern, src);
      }
    }

    // If this pattern object was already registered, return its id
    const existingId = this.patternToIdMap.get(pattern);
    if (existingId) {
      return existingId;
    }

    const generatedRef = src
      ? createRef({ src }, "pattern source")
      : createRef(pattern, "pattern");
    const generatedId = toURI(generatedRef);

    this.patternToIdMap.set(pattern as Pattern, generatedId);

    if (!this.patternIdMap.has(generatedId)) {
      this.patternIdMap.set(generatedId, pattern as Pattern);
      this.evictIfNeeded();
    } else {
      // Pattern exists - touch to mark as recently used
      this.touchPattern(generatedId);
    }

    return generatedId;
  }

  savePattern(
    { patternId, space }: {
      patternId: URI;
      space: MemorySpace;
    },
    providedTx?: IExtendedStorageTransaction,
  ): boolean {
    // HACK(seefeld): Let's always use a new transaction for now. The reason is
    // that this will fail when saving the same pattern again, even though it's
    // identical (it's effecively content addresed). So let's just parallelize
    // and eat the conflict, until we support these kinds of writes properly.
    providedTx = undefined;

    const tx = providedTx ?? this.runtime.edit();

    // Already saved
    if (this.patternMetaCellById.has(patternId)) {
      return true;
    }

    const program = getPatternProgram(this.patternIdMap.get(patternId));
    if (!program) return false;

    const pending = this.pendingMetaById.get(patternId) ?? {};
    const patternMeta: PatternMeta = {
      program,
      ...(pending as Partial<PatternMeta>),
    } as PatternMeta;

    const patternMetaCell = this.getPatternMetaCell({ patternId, space }, tx);
    patternMetaCell.set(patternMeta);

    if (!providedTx) {
      this.runtime.prepareTxForCommit(tx);
      tx.commit().then((result) => {
        if (result.error) {
          logger.warn("pattern", "Pattern already existed", patternId);
        }
      });
    }

    this.patternMetaCellById.set(patternId, patternMetaCell.withTx());
    // If we have a pattern object for this id, ensure the back mapping exists
    const pattern = this.patternIdMap.get(patternId);
    if (pattern) this.patternToIdMap.set(pattern, patternId);
    // Clear pending once persisted
    this.pendingMetaById.delete(patternId);
    // Evict if cache is full
    this.evictIfNeeded();
    return true;
  }

  async saveAndSyncPattern(
    { patternId, space }: {
      patternId: URI;
      space: MemorySpace;
    },
    tx?: IExtendedStorageTransaction,
  ) {
    if (this.savePattern({ patternId, space }, tx)) {
      await this.getPatternMetaCell({ patternId, space }, tx).sync();
    }
  }

  private async syncLinkedPatternSource(
    metaCell: Cell<PatternMeta>,
    rawMeta: unknown,
  ): Promise<void> {
    if (!isRecord(rawMeta) || !isRecord(rawMeta.program)) {
      return;
    }
    const program = rawMeta.program;

    const base = metaCell.getAsNormalizedFullLink();
    const seen = new Set<string>();
    const linkedCells: Cell<unknown>[] = [];

    const collectLinks = (value: unknown): void => {
      const link = parseLink(value, base);
      if (link?.space && link.id) {
        const key = `${link.space}\0${link.scope}\0${link.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          linkedCells.push(this.runtime.getCellFromLink(link));
        }
        return;
      }

      if (Array.isArray(value)) {
        for (const item of value) collectLinks(item);
      } else if (isRecord(value)) {
        for (const item of Object.values(value)) collectLinks(item);
      }
    };

    collectLinks(program);
    await Promise.all(linkedCells.map((cell) => cell.sync()));
  }

  // returns a pattern already loaded
  patternById(patternId: URI): Pattern | undefined {
    const pattern = this.patternIdMap.get(patternId);
    if (pattern) {
      // Touch to mark as recently used
      this.touchPattern(patternId);
    }
    return pattern;
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
    const { id, graph, mainSpecifier, entryIdentity } = await this.runtime
      .harness.compileToRecordGraph(program);
    cacheCtx?.onEntryIdentity?.(entryIdentity);
    const result = this.runtime.harness.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    return this.patternFromEvaluation(result, program);
  }

  /**
   * ESM compile + evaluate backed by the content-addressed cell cache in
   * `cacheCtx.space`. On a warm full hit the per-module compiled bodies are
   * reused (no TypeScript compile / transformer pipeline / SES re-verify); on a
   * miss the program is compiled and its modules are written back (source +
   * integrity-stamped compiled docs) on a fresh transaction, fire-and-forget.
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
    const compilerDid = this.runtime.userIdentityDID;
    const cacheOpts = {
      runtimeVersion: COMPILE_CACHE_RUNTIME_VERSION,
      compilerDid,
    };

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
    // not gain dependencies on, or race, the fire-and-forget write-back), and
    // so repeated compiles don't accumulate open transactions.
    const readTx = this.runtime.edit();

    let warmHit = false;
    let compiled;
    try {
      compiled = await harness.compileToRecordGraph(program, {
        // The bodies returned below come from `loadCompiledClosure`, an
        // integrity-gated (`requiredIntegrity`, fail-closed) read of the
        // compiled set. On a full hit the CFC integrity label is the security
        // boundary, so skip the redundant per-module SES re-verification (threat
        // model: docs/specs/module-loading.md). A partial/miss returns undefined
        // below → fresh compile → bodies are SES-verified as usual.
        trustedBodies: true,
        precompiledModulesFor: async ({ entryIdentity, identities }) => {
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
            bodies.set(
              identity,
              doc.sourceMap === undefined
                ? { js: doc.code }
                : { js: doc.code, sourceMap: doc.sourceMap },
            );
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

    const evalStart = performance.now();
    const result = harness.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    logger.time(evalStart, "compile-cache", "evaluate");

    if (warmHit) {
      this.esmCacheStats.hits++;
    } else {
      this.esmCacheStats.misses++;
      // Cold/partial: persist the freshly compiled module set for next time.
      // Fire-and-forget — the pattern is already returned below, so cache
      // persistence never blocks the load. Tracked for flush/shutdown.
      const writeBack = this.writeBackCompileCache(
        space,
        modules,
        entryIdentity,
        cacheOpts,
      );
      this.compileCacheWrites.add(writeBack);
      writeBack.finally(() => this.compileCacheWrites.delete(writeBack));
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
    cacheOpts: { runtimeVersion: string; compilerDid: string },
    program: RuntimeProgram,
  ): Promise<Pattern | undefined> {
    const harness = this.runtime.harness;
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
        { sourceFiles: program.files, trustedBodies: true },
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
   * `{identity, symbol}` result-cell reference — straight from the compiled
   * cache, with NO TypeScript program in hand and NO meta-cell roundtrip. The
   * pattern's TS source is never pulled on this path; it is only needed for cold
   * recovery, which the caller handles by falling back to the patternId load.
   *
   * Returns the pattern, or `undefined` when the by-identity load is
   * unavailable (CFC not enforcing / closure absent or incomplete / invalid)
   * so the caller can fall back to `loadPattern`.
   */
  async loadPatternByIdentity(
    entryIdentity: string,
    symbol: string,
    space: MemorySpace,
  ): Promise<Pattern | undefined> {
    const harness = this.runtime.harness;
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
    const cacheOpts = {
      runtimeVersion: COMPILE_CACHE_RUNTIME_VERSION,
      compilerDid: this.runtime.userIdentityDID,
    };

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
    if (!closure.has(entryIdentity)) return undefined;

    const cachedModules: CachedCompiledModule[] = [...closure].map(
      ([identity, doc]) => ({
        identity,
        filename: doc.filename,
        code: doc.code,
        ...(doc.sourceMap !== undefined
          ? { sourceMap: doc.sourceMap as never }
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
        { trustedBodies: true },
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
    const { main, loadId } = result;
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
    // Gate is pattern-only on purpose: `seedVerifiedLoadIds` is CFC's
    // pattern-specific verified-load association, so it must not run for a
    // lift/handler. The forward `{ identity, symbol }` ref for a NON-pattern
    // artifact is NOT skipped here — `registerEvaluatedModules` (called at the
    // top of this method) already set it via `indexArtifact`, whose gate is the
    // wider `isTrustedBuilderArtifact`. Keep that ordering: widening this gate
    // instead would (wrongly) seed load-ids for non-patterns, and narrowing
    // `indexArtifact` would drop exported lift/handler forward refs — the gap
    // Codex flagged on an earlier revision of #3912.
    if (isTrustedPattern(pattern)) {
      setArtifactEntryRef(pattern, { identity: entryIdentity, symbol });
      if (loadId) {
        this.seedVerifiedLoadIds(pattern, loadId);
      }
    }
    return pattern;
  }

  /**
   * Index every module of a just-evaluated ESM bundle by its content identity
   * (CT-1623). Lets `loadPatternByIdentity` reuse a sub-pattern module already
   * evaluated as part of its parent's bundle — no storage read, no SES re-eval.
   */
  private registerEvaluatedModules(result: EvaluateResult): void {
    const byId = result.exportsByIdentity;
    if (byId) {
      for (const [identity, exports] of byId) {
        // `modulesByIdentity` keeps the whole namespace for MODULE reuse on a
        // by-identity reload (a separate concern from artifact addressing).
        // Refresh insertion order (Map is FIFO-ordered) so eviction is ~LRU.
        this.modulesByIdentity.delete(identity);
        this.modulesByIdentity.set(identity, {
          exports,
          loadId: result.loadId,
        });
        // Index each exported builder artifact for addressing by its export name.
        // (Reload relies on this so a sub-pattern's result cell loads BY IDENTITY
        // instead of cold-recompiling — CT-1623.)
        for (const exportName of Object.keys(exports)) {
          if (exportName === "__esModule") continue;
          this.indexArtifact(identity, exportName, exports[exportName]);
        }
      }
      while (this.modulesByIdentity.size > MAX_EVALUATED_MODULE_CACHE_SIZE) {
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

    while (this.addressableByIdentity.size > MAX_EVALUATED_MODULE_CACHE_SIZE) {
      const oldest = this.addressableByIdentity.keys().next().value;
      if (oldest === undefined) break;
      this.addressableByIdentity.delete(oldest);
    }
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
    // Reverse index, refreshing recency (FIFO ~ LRU). Overwrite an existing
    // symbol so a re-evaluation of the same identity resolves to the FRESH
    // artifact instance, not a stale one from a prior eval.
    let bucket = this.addressableByIdentity.get(identity);
    if (bucket) this.addressableByIdentity.delete(identity);
    else bucket = new Map<string, unknown>();
    bucket.set(symbol, value);
    this.addressableByIdentity.set(identity, bucket);
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
   * `undefined` on a miss (never registered, or rolled out of the bounded cache;
   * callers fall back, e.g. to an embedded op graph or a source reload). Public
   * so the list builtins can resolve a map/filter/flatMap `op` during a
   * synchronous Action.
   */
  artifactFromIdentitySync(
    identity: string,
    symbol: string,
  ): unknown {
    const bucket = this.addressableByIdentity.get(identity);
    if (!bucket || !bucket.has(symbol)) return undefined;
    // Refresh recency.
    this.addressableByIdentity.delete(identity);
    this.addressableByIdentity.set(identity, bucket);
    // Returns the live builder artifact (pattern / lift / handler). Callers know
    // the kind they expect from the symbol's origin and cast accordingly.
    return bucket.get(symbol);
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
    if (cached.loadId) this.seedVerifiedLoadIds(pattern, cached.loadId);
    return pattern;
  }

  /**
   * Write the source + compiled document sets for an emitted module set into
   * `space`, on its own transaction, independent of the caller's. Uses
   * `editWithRetry` so a commit conflict (e.g. the cache write racing the
   * pattern's own space writes) retries rather than silently dropping the
   * entry; a final failure is logged (not thrown) since the cache is an
   * optimization, never on the correctness path.
   */
  private async writeBackCompileCache(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
    opts: { runtimeVersion: string; compilerDid: string },
  ): Promise<void> {
    const writebackStart = performance.now();
    const { error } = await this.runtime.editWithRetry((tx) => {
      writeSourceDocs(this.runtime, space, modules, entryIdentity, tx);
      writeCompiledDocs(this.runtime, space, modules, entryIdentity, opts, tx);
    });
    logger.time(writebackStart, "compile-cache", "writeback");
    if (error) {
      logger.error("compile-cache-writeback-failed", () => [
        `entry=${entryIdentity}`,
        error.message,
      ]);
    }
  }

  // Resolve a Pattern from an evaluate result.
  private patternFromEvaluation(
    result: EvaluateResult,
    program: RuntimeProgram,
    entryIdentity?: string,
  ): Pattern {
    this.registerEvaluatedModules(result);
    const { main, loadId } = result;
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
    // Only a trusted (builder-produced) entry pattern receives rehydration /
    // verified-load metadata; a forged pattern-shaped export gets none and so
    // cannot masquerade as a verified-loaded pattern in the side-tables.
    if (isTrustedPattern(pattern)) {
      setPatternProgram(pattern, program);
      if (entryIdentity) {
        setArtifactEntryRef(pattern, {
          identity: entryIdentity,
          symbol: exportName,
        });
      }
      if (loadId) {
        this.seedVerifiedLoadIds(pattern, loadId);
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

    // Compute deterministic patternId (matches registerPattern's ID generation)
    const patternRef = createRef({ src: program }, "pattern source");
    const patternId = toURI(patternRef);

    // Check cache
    const existing = this.patternIdMap.get(patternId);
    if (existing) {
      this.touchPattern(patternId);
      return Promise.resolve(existing);
    }

    // Check in-flight compilation (single-flight deduplication)
    const inProgress = this.inProgressCompilations.get(patternId);
    if (inProgress) {
      return inProgress;
    }

    // Compile with single-flight pattern. Pass the cell-cache context when a
    // space is available so nested/dynamic compiles benefit from the cache too.
    const compilationPromise = this.compilePattern(
      program,
      space ? { space } : undefined,
    )
      .then((pattern) => {
        // Register directly with pre-computed patternId to avoid double-hashing
        // (registerPattern would recompute the same hash from program)
        pattern = this.findOriginalPattern(pattern);
        this.patternToIdMap.set(pattern, patternId);
        if (!this.patternIdMap.has(patternId)) {
          this.patternIdMap.set(patternId, pattern);
          this.evictIfNeeded();
        }
        return pattern;
      })
      .finally(() => {
        this.inProgressCompilations.delete(patternId);
      });

    this.inProgressCompilations.set(patternId, compilationPromise);
    return compilationPromise;
  }

  // we need to ensure we only compile once otherwise we get ~12 +/- 4
  // compiles of each pattern
  private async compilePatternOnce(
    patternId: URI,
    space: MemorySpace,
    tx?: IExtendedStorageTransaction,
  ): Promise<Pattern> {
    let metaCell = this.getPatternMetaCell({ patternId, space }, tx);
    await metaCell.sync();
    let patternMeta = metaCell.get();
    if (!patternMeta?.program) {
      const rawMeta = metaCell.getRaw();
      await this.syncLinkedPatternSource(metaCell, rawMeta);
      patternMeta = metaCell.get();
    }

    // Fall back to legacy {patternId, type: "pattern"} cause
    if (!patternMeta?.program) {
      metaCell = this.getLegacyPatternMetaCell({ patternId, space }, tx);
      await metaCell.sync();
      patternMeta = metaCell.get();
      if (!patternMeta?.program) {
        const rawMeta = metaCell.getRaw();
        await this.syncLinkedPatternSource(metaCell, rawMeta);
        patternMeta = metaCell.get();
      }
    }

    if (!patternMeta?.program) {
      throw new Error(`Pattern ${patternId} has no stored source`);
    }

    const source = patternMeta.program!;
    // A previously-stored entry identity (set on the first cold ESM compile)
    // lets the cache path skip resolve + compile and load by identity.
    const knownEntryIdentity = patternMeta.entryIdentity;
    let learnedEntryIdentity: string | undefined;
    // Pass the target space so the ESM path can use the per-space cell cache.
    const pattern = await this.compilePattern(source, {
      space,
      tx,
      knownEntryIdentity,
      onEntryIdentity: (id) => {
        learnedEntryIdentity = id;
      },
    });
    this.patternIdMap.set(patternId, pattern);
    this.patternToIdMap.set(pattern, patternId);
    this.patternMetaCellById.set(patternId, metaCell.withTx());
    this.evictIfNeeded();
    // Persist the entry identity once learned (cold compile) so the next load
    // takes the by-identity fast path. Fire-and-forget — never blocks the load,
    // but tracked alongside the cache writes so shutdown / tests can flush it.
    if (learnedEntryIdentity && learnedEntryIdentity !== knownEntryIdentity) {
      const metaWrite = this.setPatternMetaFields(patternId, {
        entryIdentity: learnedEntryIdentity,
      });
      this.compileCacheWrites.add(metaWrite);
      metaWrite.finally(() => this.compileCacheWrites.delete(metaWrite));
    }
    return pattern;
  }

  async loadPattern(
    id: URI,
    space: MemorySpace,
    tx?: IExtendedStorageTransaction,
  ): Promise<Pattern> {
    const existing = this.patternIdMap.get(id);
    if (existing) {
      // Touch to mark as recently used
      this.touchPattern(id);
      return existing;
    }

    if (this.inProgressCompilations.has(id)) {
      return this.inProgressCompilations.get(id)!;
    }

    // single-flight compilation
    const compilationPromise = this.compilePatternOnce(id, space, tx)
      .finally(() => this.inProgressCompilations.delete(id)); // tidy up

    this.inProgressCompilations.set(id, compilationPromise);

    return await compilationPromise;
  }

  /**
   * Load a pattern by its content-addressed {identity, symbol} reference and
   * register it under `patternId` so `patternById(patternId)` resolves it (the
   * reload path keys on patternId everywhere). The source-free fast path: no TS
   * program, no meta-cell sync. Returns undefined when the by-identity load is
   * unavailable, so the caller falls back to `loadPattern(patternId)`.
   */
  async loadPatternByIdentityAs(
    patternId: URI,
    entryIdentity: string,
    symbol: string,
    space: MemorySpace,
  ): Promise<Pattern | undefined> {
    const existing = this.patternIdMap.get(patternId);
    if (existing) {
      this.touchPattern(patternId);
      return existing;
    }
    const pattern = await this.loadPatternByIdentity(
      entryIdentity,
      symbol,
      space,
    );
    if (!pattern) return undefined;
    this.patternIdMap.set(patternId, pattern);
    this.patternToIdMap.set(pattern, patternId);
    this.evictIfNeeded();
    return pattern;
  }

  /**
   * Set or update metadata fields for a pattern before or after saving.
   * If the metadata cell already exists, it updates it in-place.
   * Otherwise, it stores the fields to be applied on the next save.
   */
  async setPatternMetaFields(
    patternId: URI,
    fields: Partial<PatternMeta>,
  ): Promise<void> {
    const cell = this.patternMetaCellById.get(patternId);
    if (cell) {
      const current = cell.get();
      await this.runtime.editWithRetry((tx) => {
        cell.withTx(tx).set({ ...current, ...fields });
      });
    } else {
      const pending = this.pendingMetaById.get(patternId) ?? {};
      this.pendingMetaById.set(patternId, { ...pending, ...fields });
    }
  }
}
