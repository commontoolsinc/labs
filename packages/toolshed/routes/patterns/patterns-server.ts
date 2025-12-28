import { decode } from "@commontools/utils/encoding";
import { generateETag } from "@commontools/static/etag";
import { join } from "@std/path/join";
import { toFileUrl } from "@std/path/to-file-url";

/**
 * Pattern file with content and ETag for HTTP caching.
 */
export interface PatternFile {
  buffer: Uint8Array;
  etag: string;
}

/**
 * Simple helper for serving pattern files from the patterns directory.
 * Works with both dev mode and compiled binaries.
 *
 * Note: No in-memory caching - we rely on HTTP ETag caching instead.
 * This ensures dev mode works correctly (file changes are reflected immediately)
 * and avoids memory growth issues. File reads are fast (~1ms for small files).
 */
export class PatternsServer {
  private baseUrl: URL;

  constructor() {
    // Simple path resolution - works for both dev and compiled
    // From packages/toolshed/routes/patterns to packages/patterns
    const patternsDir = join(
      import.meta.dirname || "",
      "..",
      "..",
      "..",
      "patterns",
    );
    this.baseUrl = toFileUrl(patternsDir);

    // Ensure the URL ends with a slash for proper path joining
    if (!this.baseUrl.href.endsWith("/")) {
      this.baseUrl.href += "/";
    }
  }

  /**
   * Get a pattern file's content as Uint8Array.
   */
  async get(filename: string): Promise<Uint8Array> {
    const { buffer } = await this.getWithETag(filename);
    return buffer;
  }

  /**
   * Get a pattern file with its ETag for cache validation.
   * Always reads from disk to ensure fresh content in dev mode.
   * HTTP ETag caching handles repeat requests efficiently.
   */
  async getWithETag(filename: string): Promise<PatternFile> {
    const url = new URL(filename, this.baseUrl);

    try {
      const buffer = await Deno.readFile(url);
      const etag = await generateETag(buffer);
      return { buffer, etag };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Deno.errors.NotFound(`Pattern file not found: ${filename}`);
      }
      throw error;
    }
  }

  /**
   * Get a pattern file's content as text.
   */
  async getText(filename: string): Promise<string> {
    const buffer = await this.get(filename);
    return decode(buffer);
  }
}
