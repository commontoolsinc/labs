import { decode } from "@commontools/utils/encoding";
import { join } from "@std/path/join";
import { toFileUrl } from "@std/path/to-file-url";

/**
 * Cache for pattern files that handles both dev and compiled modes.
 * In dev mode, reads from file system on every request (no caching).
 * In compiled mode, reads from included resources with caching enabled.
 */
export class PatternsCache {
  private cache: Map<string, Promise<Uint8Array>> = new Map();
  private baseUrl: URL;
  private isDevMode: boolean;

  constructor() {
    // Determine base URL based on execution context
    // Check if we're in a compiled binary by looking for the deno-compile temp directory
    const dirname = import.meta.dirname || "";
    const isCompiled = dirname.includes("deno-compile-");

    // In dev mode, we want to read from disk every time
    this.isDevMode = !isCompiled;

    if (isCompiled) {
      // We're in a compiled binary
      // The dirname will be something like: /var/folders/.../deno-compile-toolshed/packages/toolshed/routes/patterns
      // We need to go up to the root of the extracted files and then to packages/patterns
      // From routes/patterns, we need to go up 4 levels to reach the root, then down to packages/patterns
      const rootDir = join(dirname, "..", "..", "..", ".."); // Go up from routes/patterns to root
      const patternsDir = join(rootDir, "packages", "patterns");
      this.baseUrl = toFileUrl(patternsDir);
    } else {
      // We're in dev mode with a real file system path
      // We're running from packages/toolshed/routes/patterns, patterns is at ../../../patterns
      const patternsDir = join(dirname, "..", "..", "..", "patterns");
      this.baseUrl = toFileUrl(patternsDir);
    }

    // Ensure the URL ends with a slash for proper path joining
    if (!this.baseUrl.href.endsWith("/")) {
      this.baseUrl.href += "/";
    }
  }

  /**
   * Get a pattern file's content as Uint8Array.
   */
  async get(filename: string): Promise<Uint8Array> {
    // In dev mode, always read from disk (no caching)
    if (this.isDevMode) {
      console.log(`[PatternsCache] Reading ${filename} from disk (dev mode)`);
      return this.loadFile(filename);
    }

    // In production/compiled mode, use caching
    const cached = this.cache.get(filename);
    if (cached) {
      return cached;
    }

    const promise = this.loadFile(filename);
    this.cache.set(filename, promise);
    return promise;
  }

  /**
   * Get a pattern file's content as text.
   */
  async getText(filename: string): Promise<string> {
    const buffer = await this.get(filename);
    return decode(buffer);
  }

  /**
   * Check if a pattern file exists.
   */
  async exists(filename: string): Promise<boolean> {
    try {
      await this.get(filename);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load a file from the appropriate location based on mode.
   */
  private async loadFile(filename: string): Promise<Uint8Array> {
    const url = new URL(filename, this.baseUrl);

    try {
      // Always use Deno.readFile for both modes
      // In compiled mode, this reads from included resources
      // In dev mode, this reads from file system
      return await Deno.readFile(url);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(`Pattern file not found: ${filename}`);
      }
      throw error;
    }
  }

  /**
   * Get the full URL for a pattern file.
   */
  getUrl(filename: string): URL {
    return new URL(filename, this.baseUrl);
  }
}
