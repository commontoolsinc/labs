import {
  getTypeScriptEnvironmentTypes,
  type JsScript,
  type Program,
  type ProgramResolver,
  type Source,
  TypeScriptCompiler,
} from "@commontools/js-compiler";
import {
  CommonToolsTransformerPipeline,
  transformCtDirective,
} from "@commontools/ts-transformers";
import { refer } from "@commontools/memory/reference";
import { StaticCacheFS } from "@commontools/static";
import { PatternsServer } from "./patterns-server.ts";

/**
 * Runtime module identifiers that are resolved at runtime, not bundled.
 * These match the identifiers in packages/runner/src/harness/runtime-modules.ts
 */
const RUNTIME_MODULE_IDENTIFIERS = [
  "commontools",
  "turndown",
  "@commontools/html",
  "@commontools/builder",
  "@commontools/runner",
];

/**
 * Console hook script injected into compiled patterns.
 * This mirrors the pattern from packages/runner/src/harness/engine.ts
 */
const CONSOLE_HOOK_SCRIPT = `const console = globalThis.RUNTIME_ENGINE_CONSOLE_HOOK;`;

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
      this.mainContent = await this.patternsServer.getText(
        this.mainFilename.substring(1),
      );
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
      const filename = identifier.substring(1); // Remove leading /
      const contents = await this.patternsServer.getText(filename);
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
 * Pre-transform program with cts-enable directive and path prefixing.
 * Simplified version of packages/runner/src/harness/pretransform.ts
 */
function pretransformProgram(
  program: Program,
  id: string,
): Program {
  // Transform cts-enable directives
  const transformedFiles = program.files.map((source) => ({
    name: source.name,
    contents: transformCtDirective(source.contents),
  }));

  // Add prefix to all files and create index entry
  const main = program.main;
  const prefix = (filename: string) => `/${id}${filename}`;

  const exportNameds = `export * from "${prefix(main)}";`;
  const exportDefault = `export { default } from "${prefix(main)}";`;

  const files = [
    ...transformedFiles.map((source) => ({
      name: prefix(source.name),
      contents: source.contents,
    })),
    {
      name: `/index.ts`,
      contents: `${exportNameds}\n${exportDefault}`,
    },
  ];

  return {
    main: `/index.ts`,
    files,
  };
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
 * Server-side pattern compiler with LRU caching.
 *
 * Compiles TypeScript patterns to JavaScript, caching results by content hash.
 * This moves compilation from client to server, where it can be shared across
 * all users.
 */
export class PatternCompiler {
  private cache = new PatternCompileCache();
  private compiler: TypeScriptCompiler | null = null;
  private staticCache = new StaticCacheFS();
  private patternsServer = new PatternsServer();
  private initPromise: Promise<TypeScriptCompiler> | null = null;

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
    const { noCheck = true, includeSourceMap = true } = options;

    // 1. Get the compiler (lazy initialization)
    const compiler = await this.getCompiler();

    // 2. Create resolver for this pattern
    const resolver = new LocalPatternResolver(this.patternsServer, filename);

    // 3. Resolve the full program (main + all imports)
    const program = await compiler.resolveProgram(resolver, {
      runtimeModules: RUNTIME_MODULE_IDENTIFIERS,
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
        filename: cached.result.filename || `${contentHash.substring(0, 12)}.js`,
      };
    }

    // 6. Pre-transform the program
    const shortHash = contentHash.substring(0, 12);
    const transformed = pretransformProgram(program, shortHash);

    // 7. Compile to JavaScript
    const result = compiler.compile(transformed, {
      filename: `${shortHash}.js`,
      noCheck,
      runtimeModules: RUNTIME_MODULE_IDENTIFIERS,
      beforeTransformers: (prog) =>
        new CommonToolsTransformerPipeline().toFactories(prog),
      // Don't export all - just the main module exports
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
 * Singleton pattern compiler instance for the handler.
 */
export const patternCompiler = new PatternCompiler();
