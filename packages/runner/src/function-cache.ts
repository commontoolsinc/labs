import type { Module } from "./builder/types.ts";

/**
 * Cache for verified JavaScript functions keyed by implementationRef.
 */
export class FunctionCache {
  private cache = new Map<string, (...args: any[]) => any>();

  /**
   * Get a cached function by its module key.
   * @param module The module to use as a cache key
   * @returns The cached function, or undefined if not found
   */
  get(module: Module): ((...args: any[]) => any) | undefined {
    const key = this.getKey(module);
    return key ? this.cache.get(key) : undefined;
  }

  /**
   * Cache a function with its module as the key.
   * @param module The module to use as a cache key
   * @param fn The function to cache
   */
  set(module: Module, fn: (...args: any[]) => any): void {
    const key = this.getKey(module);
    if (!key) {
      return;
    }
    this.cache.set(key, fn);
  }

  /**
   * Check if a function is cached for the given module.
   * @param module The module to check
   * @returns True if a function is cached for this module
   */
  has(module: Module): boolean {
    const key = this.getKey(module);
    return key ? this.cache.has(key) : false;
  }

  /**
   * Clear all cached functions.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the cache key for a module.
   * @param module The module to generate a key for
   * @returns The cache key
   */
  private getKey(module: Module): string | undefined {
    return module.implementationRef;
  }

  /**
   * Get the current cache size.
   * @returns Number of cached functions
   */
  get size(): number {
    return this.cache.size;
  }
}
