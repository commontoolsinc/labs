import { decode } from "@commontools/utils/encoding";
import { join } from "@std/path/join";
import { toFileUrl } from "@std/path/to-file-url";

/**
 * Simple helper for serving pattern files from the patterns directory.
 * Works with both dev mode and compiled binaries.
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
    const url = new URL(filename, this.baseUrl);

    try {
      return await Deno.readFile(url);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(`Pattern file not found: ${filename}`);
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
