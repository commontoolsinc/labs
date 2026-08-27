import { join } from "@std/path/join";
import { toFileUrl } from "@std/path/to-file-url";

import {
  PATTERNS_ROUTE_PREFIX,
  resolveEntryIdentity,
} from "@commonfabric/runner";
import { decode } from "@commonfabric/utils/encoding";
import { CONNECTOR_PATTERN_SOURCES } from "../../../connectors/pattern-sources.ts";

// The prefix this route serves patterns under is the runner's constant, not
// this route's own. A pattern's content identity folds in each module's
// authored path, and the worker names modules by their URL pathname
// (HttpProgramResolver), so the identity must be computed over
// pathname-prefixed names to equal the worker's stored patternIdentity — and
// the same prefix is what a `system:` provenance ref expands to.

/**
 * Simple helper for serving pattern files from the patterns directory.
 * Works with both dev mode and compiled binaries.
 */
export class PatternsServer {
  private baseUrl: URL;
  private connectorSources: Array<{ routePrefix: string; baseUrl: URL }>;
  // Pattern files are fixed for the process's lifetime (baked into the binary
  // or static on disk), so each file's content identity is computed once and
  // cached forever. A rejected computation is evicted so a transient failure
  // (e.g. an incomplete closure during a partial deploy) can be retried.
  private identityCache = new Map<string, Promise<string>>();

  constructor() {
    const repositoryRoot = join(
      import.meta.dirname || "",
      "..",
      "..",
      "..",
      "..",
    );
    this.baseUrl = this.directoryUrl(join(repositoryRoot, "packages/patterns"));
    this.connectorSources = CONNECTOR_PATTERN_SOURCES.map((source) => ({
      routePrefix: `${source.keyPrefix}/`,
      baseUrl: this.directoryUrl(join(repositoryRoot, source.directory)),
    }));
  }

  private directoryUrl(directory: string): URL {
    const url = toFileUrl(directory);
    if (!url.href.endsWith("/")) url.href += "/";
    return url;
  }

  private resolve(filename: string): URL {
    const source = this.connectorSources.find(({ routePrefix }) =>
      filename.startsWith(routePrefix)
    );
    const baseUrl = source?.baseUrl ?? this.baseUrl;
    const relative = source === undefined
      ? filename
      : filename.slice(source.routePrefix.length);
    const url = new URL(relative, baseUrl);

    if (!url.href.startsWith(baseUrl.href)) {
      throw new Error("Path traversal detected");
    }
    return url;
  }

  /**
   * Get a pattern file's content as Uint8Array.
   */
  async get(filename: string): Promise<Uint8Array> {
    const url = this.resolve(filename);

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
