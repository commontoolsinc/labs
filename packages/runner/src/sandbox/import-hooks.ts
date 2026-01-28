/**
 * Import hooks for SES Compartments.
 *
 * This module provides resolve and import hooks that allow patterns to
 * use external modules (e.g., from esm.sh) within SES Compartments.
 *
 * Each import gets a unique suffix to force fresh instances, preventing
 * cross-pattern state sharing through shared module caches.
 */

import { SandboxSecurityError } from "./types.ts";

/**
 * Configuration for import hooks.
 */
export interface ImportHookConfig {
  /**
   * Allowed URL prefixes for external imports.
   * Default: ["https://esm.sh/"]
   */
  readonly allowedPrefixes?: readonly string[];

  /**
   * Whether to cache fetched modules.
   * Default: true
   */
  readonly cacheEnabled?: boolean;

  /**
   * Maximum cache entries.
   * Default: 100
   */
  readonly maxCacheSize?: number;

  /**
   * The pattern ID for error attribution.
   */
  readonly patternId?: string;

  /**
   * Whether debug mode is enabled.
   */
  readonly debug?: boolean;
}

/**
 * Default allowed URL prefixes for module imports.
 */
const DEFAULT_ALLOWED_PREFIXES = [
  "https://esm.sh/",
  "npm:",
] as const;

/**
 * Blocked module specifiers that should never be resolved.
 */
const BLOCKED_SPECIFIERS = [
  "node:",
  "deno:",
  "file:",
  "data:",
] as const;

/**
 * A cached module source.
 */
interface CachedModule {
  /**
   * The module source text.
   */
  readonly source: string;

  /**
   * The resolved URL.
   */
  readonly url: string;

  /**
   * When the module was cached.
   */
  readonly cachedAt: number;
}

/**
 * Module cache for fetched external modules.
 */
export class ESMCache {
  private readonly cache = new Map<string, CachedModule>();
  private readonly maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  /**
   * Get a cached module.
   */
  get(url: string): CachedModule | undefined {
    return this.cache.get(url);
  }

  /**
   * Set a cached module.
   */
  set(url: string, module: CachedModule): void {
    // Evict oldest entry if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(url, module);
  }

  /**
   * Check if a URL is cached.
   */
  has(url: string): boolean {
    return this.cache.has(url);
  }

  /**
   * Clear the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   */
  get size(): number {
    return this.cache.size;
  }
}

/**
 * Counter for generating unique import suffixes.
 * This ensures each compartment gets fresh module instances.
 */
let importCounter = 0;

/**
 * Create a resolve hook for a SES Compartment.
 *
 * The resolve hook validates import specifiers and appends unique
 * suffixes to force fresh module instances per compartment.
 *
 * @param config - Import hook configuration
 * @returns A resolve hook function
 */
export function createResolveHook(
  config: ImportHookConfig = {},
): (specifier: string, referrer: string) => string {
  const allowedPrefixes = config.allowedPrefixes ?? DEFAULT_ALLOWED_PREFIXES;
  const patternId = config.patternId;

  return (specifier: string, _referrer: string): string => {
    // Check for blocked specifiers
    for (const blocked of BLOCKED_SPECIFIERS) {
      if (specifier.startsWith(blocked)) {
        throw new SandboxSecurityError(
          `Import of "${specifier}" is not allowed. Only external HTTP modules are permitted.`,
          patternId,
          "resolveHook",
        );
      }
    }

    // Check for relative imports (not allowed in sandboxed patterns)
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      throw new SandboxSecurityError(
        `Relative import "${specifier}" is not allowed in sandboxed patterns.`,
        patternId,
        "resolveHook",
      );
    }

    // Check if it's an allowed URL
    const isAllowed = allowedPrefixes.some((prefix) =>
      specifier.startsWith(prefix)
    );

    if (!isAllowed) {
      // Try to treat bare specifiers as npm: imports via esm.sh
      if (
        !specifier.startsWith("http://") && !specifier.startsWith("https://")
      ) {
        // Convert bare specifier to esm.sh URL
        const esmUrl = `https://esm.sh/${specifier}`;
        return appendUniqueParam(esmUrl);
      }

      throw new SandboxSecurityError(
        `Import from "${specifier}" is not allowed. Allowed prefixes: ${
          allowedPrefixes.join(", ")
        }`,
        patternId,
        "resolveHook",
      );
    }

    // Append unique parameter for isolation
    return appendUniqueParam(specifier);
  };
}

/**
 * Append a unique query parameter to force fresh module instances.
 */
function appendUniqueParam(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}__ct_instance=${++importCounter}`;
}

/**
 * Create an import hook for a SES Compartment.
 *
 * The import hook fetches external modules and returns them as
 * static module records that can be evaluated in the compartment.
 *
 * @param config - Import hook configuration
 * @param cache - Optional shared module cache
 * @returns An async import hook function
 */
export function createImportHook(
  config: ImportHookConfig = {},
  cache?: ESMCache,
): (specifier: string) => Promise<{ source: string }> {
  const moduleCache = cache ?? new ESMCache(config.maxCacheSize ?? 100);
  const debug = config.debug ?? false;
  const patternId = config.patternId;

  return async (specifier: string): Promise<{ source: string }> => {
    // Strip the unique parameter for caching
    const baseUrl = stripUniqueParam(specifier);

    // Check cache
    const cached = moduleCache.get(baseUrl);
    if (cached && config.cacheEnabled !== false) {
      if (debug) {
        console.log(
          `[ImportHook] Cache hit for "${baseUrl}" (pattern: ${patternId})`,
        );
      }
      return { source: cached.source };
    }

    // Fetch the module
    try {
      if (debug) {
        console.log(
          `[ImportHook] Fetching "${baseUrl}" (pattern: ${patternId})`,
        );
      }

      const response = await fetch(baseUrl);

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const source = await response.text();

      // Cache the result
      moduleCache.set(baseUrl, {
        source,
        url: baseUrl,
        cachedAt: Date.now(),
      });

      return { source };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SandboxSecurityError(
        `Failed to import "${baseUrl}": ${message}`,
        patternId,
        "importHook",
      );
    }
  };
}

/**
 * Strip the unique query parameter from a URL.
 */
function stripUniqueParam(url: string): string {
  return url.replace(/[?&]__ct_instance=\d+/, "");
}

/**
 * Check if a module specifier is an external URL.
 */
export function isExternalSpecifier(specifier: string): boolean {
  return specifier.startsWith("https://") ||
    specifier.startsWith("http://") ||
    specifier.startsWith("npm:");
}

/**
 * Reset the import counter (for testing).
 */
export function resetImportCounter(): void {
  importCounter = 0;
}
