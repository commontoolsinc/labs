import { getLogger } from "@commontools/utils/logger";
import {
  JSONSchema,
  Module,
  Pattern,
  Schema,
  unsafe_originalPattern,
} from "./builder/types.ts";
import { Cell } from "./cell.ts";
import type { MemorySpace, Runtime } from "./runtime.ts";
import { createRef } from "./create-ref.ts";
import { RuntimeProgram } from "./harness/types.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

const logger = getLogger("pattern-manager");

/**
 * Maximum number of patterns to cache in memory.
 * When exceeded, oldest (least recently used) patterns are evicted.
 * Set conservatively to prevent OOM in long-running processes and tests.
 */
const MAX_PATTERN_CACHE_SIZE = 100;

export const patternMetaSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    // @deprecated Represents a pattern with a single source file
    src: { type: "string" },
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
  required: ["id"],
} as const satisfies JSONSchema;

export type PatternMeta = Schema<typeof patternMetaSchema>;

export class PatternManager {
  private inProgressCompilations = new Map<string, Promise<Pattern>>();
  // Maps keyed by patternId for consistent lookups
  private patternMetaCellById = new Map<string, Cell<PatternMeta>>();
  private patternIdMap = new Map<string, Pattern>();
  // Map from pattern object instance to patternId
  private patternToIdMap = new WeakMap<Pattern, string>();
  // Pending metadata set before the meta cell exists (e.g., spec, parents)
  private pendingMetaById = new Map<string, Partial<PatternMeta>>();

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
  private touchPattern(patternId: string): void {
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
    { patternId, space }: { patternId: string; space: MemorySpace },
    tx?: IExtendedStorageTransaction,
  ): Cell<PatternMeta> {
    const cell = this.runtime.getCell(
      space,
      { patternId, type: "pattern" },
      patternMetaSchema,
      tx,
    );

    return cell;
  }

  /** Legacy fallback: read pattern meta from the old {recipeId, type: "recipe"} cause. */
  private getLegacyRecipeMetaCell(
    { patternId, space }: { patternId: string; space: MemorySpace },
    tx?: IExtendedStorageTransaction,
  ): Cell<PatternMeta> {
    return this.runtime.getCell(
      space,
      { recipeId: patternId, type: "recipe" },
      patternMetaSchema,
      tx,
    );
  }

  private findOriginalPattern(pattern: Pattern): Pattern {
    while (pattern[unsafe_originalPattern]) {
      pattern = pattern[unsafe_originalPattern];
    }
    return pattern;
  }

  async loadPatternMeta(
    patternId: string,
    space: MemorySpace,
  ): Promise<PatternMeta> {
    const cell = this.getPatternMetaCell({ patternId, space });
    await cell.sync();
    if (cell.get()?.id) return cell.get();

    // Fall back to legacy {recipeId, type: "recipe"} cause
    const legacyCell = this.getLegacyRecipeMetaCell({ patternId, space });
    await legacyCell.sync();
    return legacyCell.get();
  }

  getPatternMeta(
    input: Pattern | Module | { patternId: string },
  ): PatternMeta {
    let patternId: string | undefined;
    if ("patternId" in input) {
      patternId = input.patternId;
    } else if (input && typeof input === "object") {
      patternId = this.patternToIdMap.get(
        this.findOriginalPattern(input as Pattern),
      );
    }

    if (!patternId) throw new Error("Pattern is not registered");

    const cell = this.patternMetaCellById.get(patternId);
    if (cell) return cell.get();

    // If we don't have a stored cell yet, return whatever pending/meta we have
    const pending = this.pendingMetaById.get(patternId) ?? {};
    const source = this.patternIdMap.get(patternId)?.program;
    if (!source && Object.keys(pending).length === 0) {
      throw new Error(`Pattern ${patternId} has no metadata available`);
    }
    const meta: PatternMeta = {
      id: patternId,
      ...(typeof source === "string" ? { src: source } : {}),
      ...(typeof source === "object" ? { program: source } : {}),
      ...(pending as Partial<PatternMeta>),
    } as PatternMeta;
    return meta;
  }

  registerPattern(
    pattern: Pattern | Module,
    src?: string | RuntimeProgram,
  ): string {
    // Walk up derivation copies to original
    pattern = this.findOriginalPattern(pattern as Pattern);

    if (src && !pattern.program) {
      if (typeof src === "string") {
        pattern.program = {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: src }],
        };
      } else {
        pattern.program = src;
      }
    }

    // If this pattern object was already registered, return its id
    const existingId = this.patternToIdMap.get(pattern);
    if (existingId) return existingId;

    const generatedId = src
      ? createRef({ src }, "pattern source").toString()
      : createRef(pattern, "pattern").toString();

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
      patternId: string;
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

    const program = this.patternIdMap.get(patternId)?.program;
    if (!program) return false;

    const pending = this.pendingMetaById.get(patternId) ?? {};
    const patternMeta: PatternMeta = {
      id: patternId,
      program,
      ...(pending as Partial<PatternMeta>),
    } as PatternMeta;

    const patternMetaCell = this.getPatternMetaCell({ patternId, space }, tx);
    patternMetaCell.set(patternMeta);

    if (!providedTx) {
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
      patternId: string;
      space: MemorySpace;
    },
    tx?: IExtendedStorageTransaction,
  ) {
    if (this.savePattern({ patternId, space }, tx)) {
      await this.getPatternMetaCell({ patternId, space }, tx).sync();
    }
  }

  // returns a pattern already loaded
  patternById(patternId: string): Pattern | undefined {
    const pattern = this.patternIdMap.get(patternId);
    if (pattern) {
      // Touch to mark as recently used
      this.touchPattern(patternId);
    }
    return pattern;
  }

  async compilePattern(input: string | RuntimeProgram): Promise<Pattern> {
    let program: RuntimeProgram | undefined;
    if (typeof input === "string") {
      program = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: input }],
      };
    } else {
      program = input;
    }
    const pattern = await this.runtime.harness.run(program);
    pattern.program = program;
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
    const patternId = createRef({ src: program }, "pattern source").toString();

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
    patternId: string,
    space: MemorySpace,
    tx?: IExtendedStorageTransaction,
  ): Promise<Pattern> {
    let metaCell = this.getPatternMetaCell({ patternId, space }, tx);
    await metaCell.sync();
    let patternMeta = metaCell.get();

    // Fall back to legacy {recipeId, type: "recipe"} cause
    if (!patternMeta?.src && !patternMeta?.program) {
      metaCell = this.getLegacyRecipeMetaCell({ patternId, space }, tx);
      await metaCell.sync();
      patternMeta = metaCell.get();
    }

    if (!patternMeta.src && !patternMeta.program) {
      throw new Error(`Pattern ${patternId} has no stored source`);
    }

    const source = patternMeta.program
      ? (patternMeta.program as RuntimeProgram)
      : patternMeta.src!;
    const pattern = await this.compilePattern(source);
    this.patternIdMap.set(patternId, pattern);
    this.patternToIdMap.set(pattern, patternId);
    this.patternMetaCellById.set(patternId, metaCell.withTx());
    this.evictIfNeeded();
    return pattern;
  }

  async loadPattern(
    id: string,
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
    patternId: string,
    fields: Partial<PatternMeta>,
  ): Promise<void> {
    const cell = this.patternMetaCellById.get(patternId);
    if (cell) {
      const current = cell.get();
      await this.runtime.editWithRetry((tx) => {
        cell.withTx(tx).set({ ...current, ...fields, id: patternId });
      });
    } else {
      const pending = this.pendingMetaById.get(patternId) ?? {};
      this.pendingMetaById.set(patternId, { ...pending, ...fields });
    }
  }
}
