import { decode } from "@commonfabric/utils/encoding";
import { join } from "@std/path/join";
import { toFileUrl } from "@std/path/to-file-url";
import { resolveEntryIdentity } from "@commonfabric/runner";

// The URL prefix this route serves patterns under. A pattern's content identity
// folds in each module's authored path, and the worker names modules by their
// URL pathname (HttpProgramResolver), so the identity must be computed over
// pathname-prefixed names to equal the worker's stored patternIdentity.
const PATTERNS_ROUTE_PREFIX = "/api/patterns/";

/**
 * Simple helper for serving pattern files from the patterns directory.
 * Works with both dev mode and compiled binaries.
 */
export class PatternsServer {
  private baseUrl: URL;
  // Pattern files are fixed for the process's lifetime (baked into the binary
  // or static on disk), so each file's content identity is computed once and
  // cached forever. A rejected computation is evicted so a transient failure
  // (e.g. an incomplete closure during a partial deploy) can be retried.
  private identityCache = new Map<string, Promise<string>>();

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

    // Security: verify the resolved URL stays within the patterns directory.
    // This prevents path traversal via encoded sequences (e.g. %2e%2e) that
    // bypass string-level checks but are decoded during URL resolution.
    if (!url.href.startsWith(this.baseUrl.href)) {
      throw new Error("Path traversal detected");
    }

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

  /**
   * Compute (and memoize) the content-addressed identity of a pattern entry —
   * the value advertised to runtimes through `?identity`. Walks the entry's
   * authored import closure via `getText` (single-file reads only, so it works
   * in a compiled binary) and hashes the pristine bytes; no compiler, runtime,
   * or storage is involved. An updater independently compiles the downloaded
   * closure and requires its entry ref to have this identity before replacing
   * a root.
   *
   * `filename` is the same root-relative path `getText` accepts, e.g.
   * `system/default-app.tsx`. Rejects if the closure is incomplete or reaches a
   * `cf:` fabric import (unsupported by the light path).
   */
  identity(filename: string): Promise<string> {
    let cached = this.identityCache.get(filename);
    if (!cached) {
      // Name modules by their URL pathname so the identity equals the one the
      // worker computes when it compiles the same source over HTTP.
      cached = resolveEntryIdentity(
        `${PATTERNS_ROUTE_PREFIX}${filename}`,
        (name) => this.getText(name.slice(PATTERNS_ROUTE_PREFIX.length)),
      );
      this.identityCache.set(filename, cached);
      cached.catch(() => this.identityCache.delete(filename));
    }
    return cached;
  }
}
