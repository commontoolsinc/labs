import { getLogger } from "@commonfabric/utils/logger";
import {
  isPattern,
  Module,
  Pattern,
  Schema,
  unsafe_originalPattern,
} from "./builder/types.ts";
import {
  getPatternProgram,
  getVerifiedLoadId,
  setPatternProgram,
  setVerifiedLoadId,
} from "./builder/pattern-metadata.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { Cell, createCell } from "./cell.ts";
import type { MemorySpace, Runtime } from "./runtime.ts";
import { createRef } from "./create-ref.ts";
import type { CompileResult, EvaluateResult } from "./harness/types.ts";
import { RuntimeProgram } from "./harness/types.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
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

export const patternMetaSchema = internSchema(
  {
    type: "object",
    properties: {
      spec: { type: "string" },
      parents: { type: "array", items: { type: "string" } },
      patternName: { type: "string" },
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
  private patternToVerifiedLoadId = new WeakMap<Pattern, string>();
  // Pending metadata set before the meta cell exists (e.g., spec, parents)
  private pendingMetaById = new Map<URI, Partial<PatternMeta>>();

  constructor(readonly runtime: Runtime) {}

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
    while (pattern[unsafe_originalPattern]) {
      pattern = pattern[unsafe_originalPattern];
    }
    return pattern;
  }

  private seedVerifiedLoadIds(
    value: unknown,
    verifiedLoadId: string,
    seen = new Set<unknown>(),
  ): void {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (isPattern(value)) {
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
      );
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
      this.associateVerifiedFunctions(existingId, pattern);
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

    this.associateVerifiedFunctions(generatedId, pattern);

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

  async compilePattern(input: string | RuntimeProgram): Promise<Pattern> {
    let program: RuntimeProgram;
    if (typeof input === "string") {
      program = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: input }],
      };
    } else {
      program = input;
    }

    // ESM module-record loader path (experimental, default off). Bypasses the
    // AMD bundle compile/evaluate and the persistent compile cache.
    if (
      this.runtime.experimental.esmModuleLoader === true &&
      this.runtime.harness.compileAndEvaluateModules
    ) {
      const result = await this.runtime.harness.compileAndEvaluateModules(
        program,
      );
      return this.patternFromEvaluation(result, program);
    }

    const { cachedCompiler } = this.runtime;
    if (cachedCompiler) {
      const programHash = createRef(
        { src: program },
        "pattern source",
      ).toString();
      let compileResult = await cachedCompiler.get(programHash);
      let loadedFromCache = true;
      if (!compileResult) {
        loadedFromCache = false;
        compileResult = await this.runtime.harness.compile(program);
        // Fire-and-forget cache write
        cachedCompiler.set(programHash, compileResult).catch(() => {});
      }
      return this.evaluateToPattern(compileResult, program, {
        skipBundleValidation: loadedFromCache,
      });
    }

    // No persistent cache — compile and evaluate directly
    const compileResult = await this.runtime.harness.compile(program);
    return this.evaluateToPattern(compileResult, program);
  }

  private async evaluateToPattern(
    { id, jsScript }: CompileResult,
    program: RuntimeProgram,
    options?: { skipBundleValidation?: boolean },
  ): Promise<Pattern> {
    const result = await this.runtime.harness.evaluate(
      id,
      jsScript,
      program.files,
      options,
    );
    return this.patternFromEvaluation(result, program);
  }

  // Resolve a Pattern from an evaluate result (shared by the AMD and ESM paths).
  private patternFromEvaluation(
    { main, loadId }: EvaluateResult,
    program: RuntimeProgram,
  ): Pattern {
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
    setPatternProgram(pattern, program);
    if (loadId) {
      this.seedVerifiedLoadIds(pattern, loadId);
    }
    return pattern;
  }

  /**
   * Compile a pattern from source, or return a cached/in-flight result.
   * Provides single-flight deduplication based on program content.
   *
   * @param input - Source code string or RuntimeProgram to compile
   * @returns The compiled pattern (from cache, in-flight compilation, or new)
   */
  compileOrGetPattern(input: string | RuntimeProgram): Promise<Pattern> {
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

    // Compile with single-flight pattern
    const compilationPromise = this.compilePattern(program)
      .then((pattern) => {
        // Register directly with pre-computed patternId to avoid double-hashing
        // (registerPattern would recompute the same hash from program)
        pattern = this.findOriginalPattern(pattern);
        this.patternToIdMap.set(pattern, patternId);
        if (!this.patternIdMap.has(patternId)) {
          this.patternIdMap.set(patternId, pattern);
          this.evictIfNeeded();
        }
        this.associateVerifiedFunctions(patternId, pattern);
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
    const pattern = await this.compilePattern(source);
    this.patternIdMap.set(patternId, pattern);
    this.patternToIdMap.set(pattern, patternId);
    this.patternMetaCellById.set(patternId, metaCell.withTx());
    this.associateVerifiedFunctions(patternId, pattern);
    this.evictIfNeeded();
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

  private associateVerifiedFunctions(
    patternId: URI,
    value: Pattern | Module,
  ): void {
    const originalPattern = this.findOriginalPattern(value as Pattern);
    const verifiedLoadId = this.patternToVerifiedLoadId.get(originalPattern);
    if (!getPatternProgram(originalPattern) && !verifiedLoadId) {
      return;
    }
    this.runtime.harness.associatePattern(
      patternId,
      value,
      verifiedLoadId,
    );
  }
}
