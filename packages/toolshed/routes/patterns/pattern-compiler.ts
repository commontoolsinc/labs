import {
  getTypeScriptEnvironmentTypes,
  type JsScript,
  type Program,
  type ProgramResolver,
  type Source,
  TypeScriptCompiler,
} from "@commontools/js-compiler";
import { CommonToolsTransformerPipeline } from "@commontools/ts-transformers";
import { refer } from "@commontools/memory/reference";
import { StaticCacheFS } from "@commontools/static";
import { RuntimeModuleIdentifiers } from "@commontools/runner/harness/runtime-modules";
import { pretransformProgram } from "@commontools/runner/harness/pretransform";
import { CONSOLE_HOOK_SCRIPT } from "@commontools/runner/harness/engine";
import type { RuntimeProgram } from "@commontools/runner/harness/types";
import {
  Semaphore,
  SemaphoreQueueFullError,
} from "@commontools/utils/semaphore";
import { PatternsServer } from "./patterns-server.ts";
import { normalize } from "@std/path/posix";

/**
 * Compiled pattern result with metadata.
 */
export interface CompiledPattern {
  js: string;
  sourceMap?: JsScript["sourceMap"];
  contentHash: string;
  filename: string;
}

/**
 * Options for pattern compilation.
 */
export interface CompileOptions {
  /** Skip type checking for faster compilation (default: true) */
  noCheck?: boolean;
  /** Include source map in result (default: true) */
  includeSourceMap?: boolean;
  /** Compilation timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

/** Default compilation timeout in milliseconds */
const DEFAULT_COMPILATION_TIMEOUT_MS = 30_000;

/**
 * Error thrown when compilation times out.
 */
export class CompilationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Compilation timed out after ${timeoutMs / 1000}s`);
    this.name = "CompilationTimeoutError";
  }
}

/**
 * Error thrown when a path traversal attack is detected.
 */
export class PathTraversalError extends Error {
  constructor(path: string) {
    super(`Path traversal detected: "${path}" escapes patterns directory`);
    this.name = "PathTraversalError";
  }
}

/** Default maximum number of concurrent compilations. */
const DEFAULT_MAX_CONCURRENT_COMPILATIONS = 4;

/** Default maximum queue depth for waiting compilations (backpressure). */
const DEFAULT_MAX_QUEUE_DEPTH = 100;

/**
 * Creates a promise that rejects after the specified timeout.
 * Returns both the promise and a cleanup function to clear the timeout.
 */
function createTimeout(
  timeoutMs: number,
): { promise: Promise<never>; cleanup: () => void } {
  let timeoutId: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new CompilationTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  const cleanup = () => clearTimeout(timeoutId);
  return { promise, cleanup };
}

/**
 * LRU cache entry for compiled patterns.
 */
interface CacheEntry {
  result: JsScript;
  contentHash: string;
  createdAt: number;
}

/**
 * Simple LRU cache for compiled patterns.
 * Evicts oldest entries when at capacity.
 */
class PatternCompileCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private maxAgeMs: number;

  constructor(maxSize = 100, maxAgeMs = 60 * 60 * 1000) {
    this.maxSize = maxSize;
    this.maxAgeMs = maxAgeMs;
  }

  get(hash: string): CacheEntry | undefined {
    const entry = this.cache.get(hash);
    if (!entry) return undefined;

    // Check age
    if (Date.now() - entry.createdAt > this.maxAgeMs) {
      this.cache.delete(hash);
      return undefined;
    }

    // LRU: move to end by re-inserting
    this.cache.delete(hash);
    this.cache.set(hash, entry);
    return entry;
  }

  set(hash: string, result: JsScript, contentHash: string): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(hash, { result, contentHash, createdAt: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Validates that a path stays within the patterns directory.
 * Returns the normalized path (without leading slash) if valid.
 * Throws PathTraversalError if the path escapes the patterns directory.
 *
 * @param path - The path to validate (with or without leading /)
 * @returns The normalized path without leading slash
 * @throws PathTraversalError if path escapes patterns directory
 */
export function validatePatternPath(path: string): string {
  // Normalize the path to resolve .. and . sequences
  // The normalize function handles paths like "/foo/../../../etc/passwd"
  // and converts them to "/etc/passwd"
  const normalizedPath = normalize(path);

  // Remove leading slash for internal use
  const withoutLeadingSlash = normalizedPath.startsWith("/")
    ? normalizedPath.substring(1)
    : normalizedPath;

  // After normalization:
  // - Valid: "foo/bar.ts", "system/app.tsx"
  // - Invalid: "../etc/passwd", "../../etc/passwd"
  // A normalized path that starts with ".." means it tried to escape root
  if (
    withoutLeadingSlash.startsWith("..") ||
    withoutLeadingSlash.startsWith("/")
  ) {
    throw new PathTraversalError(path);
  }

  // Also reject empty paths (edge case where path was just "/" or similar)
  if (withoutLeadingSlash === "" || withoutLeadingSlash === ".") {
    throw new PathTraversalError(path);
  }

  return withoutLeadingSlash;
}

/**
 * Program resolver that reads from the local patterns directory.
 * Used for server-side compilation of patterns.
 */
class LocalPatternResolver implements ProgramResolver {
  private patternsServer: PatternsServer;
  private mainFilename: string;
  private mainContent: string | undefined;

  constructor(patternsServer: PatternsServer, filename: string) {
    this.patternsServer = patternsServer;
    // Ensure filename starts with / for consistency
    this.mainFilename = filename.startsWith("/") ? filename : `/${filename}`;
  }

  async main(): Promise<Source> {
    if (!this.mainContent) {
      // Security: validate path stays within patterns directory
      const validatedPath = validatePatternPath(this.mainFilename);
      this.mainContent = await this.patternsServer.getText(validatedPath);
    }
    return {
      name: this.mainFilename,
      contents: this.mainContent,
    };
  }

  async resolveSource(identifier: string): Promise<Source | undefined> {
    // Only resolve local files (starting with /)
    if (!identifier || identifier[0] !== "/") {
      return undefined;
    }

    try {
      // Security: validate path stays within patterns directory
      const validatedPath = validatePatternPath(identifier);
      const contents = await this.patternsServer.getText(validatedPath);
      return { name: identifier, contents };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return undefined;
      }
      throw error;
    }
  }
}

/**
 * Compute a content-addressable cache key for a program.
 */
function computeCacheKey(program: Program): string {
  return refer({
    main: program.main,
    files: program.files.map((f) => ({ name: f.name, contents: f.contents })),
  }).toString();
}

/**
 * Options for configuring the PatternCompiler.
 */
export interface PatternCompilerOptions {
  /**
   * Maximum number of concurrent compilations.
   * Limits CPU usage under load while still allowing parallelism.
   * Default: 4
   */
  maxConcurrency?: number;

  /**
   * Maximum number of requests that can queue waiting for a compilation slot.
   * When exceeded, requests fail fast with SemaphoreQueueFullError.
   * Default: 100
   */
  maxQueueDepth?: number;
}

/**
 * Server-side pattern compiler with LRU caching.
 *
 * Compiles TypeScript patterns to JavaScript, caching results by content hash.
 * This moves compilation from client to server, where it can be shared across
 * all users.
 *
 * Limits concurrent compilations to prevent CPU exhaustion under load.
 */
export class PatternCompiler {
  private cache = new PatternCompileCache();
  private compiler: TypeScriptCompiler | null = null;
  private staticCache = new StaticCacheFS();
  private patternsServer = new PatternsServer();
  private initPromise: Promise<TypeScriptCompiler> | null = null;
  /**
   * Track in-flight compilations to prevent thundering herd.
   *
   * NOTE: This uses filename as key, while the cache uses contentHash.
   * This means concurrent requests for the same filename will coalesce,
   * but if the file changes mid-compilation, the second request won't
   * reuse the first's result (since the contentHash will differ).
   * This is an acceptable trade-off: content-based dedup would require
   * reading all files before we could deduplicate requests.
   */
  private inFlight = new Map<string, Promise<CompiledPattern>>();
  /** Semaphore to limit concurrent compilations */
  private compilationSemaphore: Semaphore;

  constructor(options: PatternCompilerOptions = {}) {
    const maxConcurrent = options.maxConcurrency ??
      DEFAULT_MAX_CONCURRENT_COMPILATIONS;
    const maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.compilationSemaphore = new Semaphore({ maxConcurrent, maxQueueDepth });
  }

  /**
   * Lazily initialize the TypeScript compiler.
   * Loading type libraries is expensive, so we do it once on first compile.
   */
  private async getCompiler(): Promise<TypeScriptCompiler> {
    if (this.compiler) return this.compiler;

    // Use a promise to prevent concurrent initialization
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const typeLibs = await getTypeScriptEnvironmentTypes(this.staticCache);
        this.compiler = new TypeScriptCompiler(typeLibs);
        return this.compiler;
      })();
    }

    return this.initPromise;
  }

  /**
   * Compile a pattern file to JavaScript.
   *
   * @param filename - Pattern file path (e.g., "system/default-app.tsx")
   * @param options - Compilation options
   * @returns Compiled JavaScript with metadata
   */
  async compile(
    filename: string,
    options: CompileOptions = {},
  ): Promise<CompiledPattern> {
    // Check if compilation is already in progress for this file
    const existing = this.inFlight.get(filename);
    if (existing) return existing;

    // Start compilation and track it
    const promise = this.doCompile(filename, options);
    this.inFlight.set(filename, promise);

    try {
      return await promise;
    } finally {
      this.inFlight.delete(filename);
    }
  }

  /**
   * Internal compilation implementation.
   * Acquires a semaphore permit to limit concurrent compilations.
   */
  private async doCompile(
    filename: string,
    options: CompileOptions,
  ): Promise<CompiledPattern> {
    const {
      noCheck = true,
      includeSourceMap = true,
      timeoutMs = DEFAULT_COMPILATION_TIMEOUT_MS,
    } = options;

    // Acquire semaphore permit to limit concurrent compilations
    await this.compilationSemaphore.acquire();

    try {
      // Create timeout to prevent hanging on pathological inputs
      const { promise: timeoutPromise, cleanup: cleanupTimeout } =
        createTimeout(timeoutMs);

      // Wrap compilation work in an async function for Promise.race
      const compilationWork = async (): Promise<CompiledPattern> => {
        // 1. Get the compiler (lazy initialization)
        const compiler = await this.getCompiler();

        // 2. Create resolver for this pattern
        const resolver = new LocalPatternResolver(
          this.patternsServer,
          filename,
        );

        // 3. Resolve the full program (main + all imports)
        const program = await compiler.resolveProgram(resolver, {
          runtimeModules: RuntimeModuleIdentifiers,
        });

        // 4. Compute content hash for caching
        const contentHash = computeCacheKey(program);

        // 5. Check cache
        const cached = this.cache.get(contentHash);
        if (cached) {
          return {
            js: cached.result.js,
            sourceMap: includeSourceMap ? cached.result.sourceMap : undefined,
            contentHash: cached.contentHash,
            filename: cached.result.filename ||
              `${contentHash.substring(0, 12)}.js`,
          };
        }

        // 6. Pre-transform the program
        const shortHash = contentHash.substring(0, 12);
        const transformed = pretransformProgram(program, shortHash);

        // 7. Compile to JavaScript
        const result = compiler.compile(transformed, {
          filename: `${shortHash}.js`,
          noCheck,
          runtimeModules: RuntimeModuleIdentifiers,
          beforeTransformers: (prog) =>
            new CommonToolsTransformerPipeline().toFactories(prog),
          bundleExportAll: true, // Matches Engine behavior - produces { main, exportMap }
          injectedScript: CONSOLE_HOOK_SCRIPT,
        });

        // 8. Cache the result
        this.cache.set(contentHash, result, contentHash);

        // 9. Return compiled pattern
        return {
          js: result.js,
          sourceMap: includeSourceMap ? result.sourceMap : undefined,
          contentHash,
          filename: result.filename || `${shortHash}.js`,
        };
      };

      try {
        // Race compilation against timeout
        return await Promise.race([compilationWork(), timeoutPromise]);
      } finally {
        // Always clean up the timeout to prevent memory leaks
        cleanupTimeout();
      }
    } finally {
      // Always release the semaphore permit, even on errors or timeouts
      this.compilationSemaphore.release();
    }
  }

  /**
   * Clear the compilation cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size.
   */
  get cacheSize(): number {
    return this.cache.size;
  }
}

/**
 * Create a new PatternCompiler instance.
 *
 * @param options - Configuration options
 * @returns New PatternCompiler instance
 */
export function createPatternCompiler(
  options?: PatternCompilerOptions,
): PatternCompiler {
  return new PatternCompiler(options);
}
