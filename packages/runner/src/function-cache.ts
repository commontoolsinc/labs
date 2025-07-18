import type { Module } from "./builder/types.ts";

/**
 * Cache for JavaScript functions keyed by their stringified module.
 * This allows us to avoid re-evaluating the same function strings multiple times
 * during recipe execution.
 */
export class FunctionCache {
  private cache = new Map<string, Function>();

  /**
   * Get a cached function by its module key.
   * @param module The module to use as a cache key
   * @returns The cached function, or undefined if not found
   */
  get(module: Module): Function | undefined {
    const key = this.getKey(module);
    return this.cache.get(key);
  }

  /**
   * Cache a function with its module as the key.
   * @param module The module to use as a cache key
   * @param fn The function to cache
   */
  set(module: Module, fn: Function): void {
    const key = this.getKey(module);
    this.cache.set(key, fn);
  }

  /**
   * Check if a function is cached for the given module.
   * @param module The module to check
   * @returns True if a function is cached for this module
   */
  has(module: Module): boolean {
    const key = this.getKey(module);
    return this.cache.has(key);
  }

  /**
   * Clear all cached functions.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the cache key for a module.
   * Uses JSON.stringify to create a stable key from the module object.
   * @param module The module to generate a key for
   * @returns The cache key
   */
  private getKey(module: Module): string {
    return JSON.stringify(module);
  }

  /**
   * Get the current cache size.
   * @returns Number of cached functions
   */
  get size(): number {
    return this.cache.size;
  }
}