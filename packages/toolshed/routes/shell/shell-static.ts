import * as path from "@std/path";
import { createRouter } from "@/lib/create-app.ts";
import { getMimeType } from "@/lib/mime-type.ts";
import {
  compareETags,
  createCacheHeaders,
  generateETag,
} from "@commonfabric/static/etag";

/**
 * Inputs the static router reads files and computes ETags with. Injectable so
 * the serving logic can be exercised against an in-memory or fixture file set.
 */
export interface ShellStaticDeps {
  readFile: (filePath: string) => Promise<Uint8Array>;
  generateETag: (content: Uint8Array) => Promise<string>;
}

export interface ShellStaticOptions {
  deps?: ShellStaticDeps;
  /**
   * Build identifier embedded in a compiled toolshed binary. Its immutable
   * `/builds/<id>/` URL namespace aliases the binary's single static graph.
   */
  immutableBuildId?: string | null;
}

const defaultDeps: ShellStaticDeps = {
  readFile: Deno.readFile,
  generateETag,
};

/**
 * Encapsulates static file response with ETag-based caching support.
 * Handles both 200 (full content) and 304 (not modified) responses.
 */
export class StaticResponse {
  mimeType: string;
  buffer: Uint8Array;
  etag: string;

  constructor(
    buffer: Uint8Array,
    mimeType: string,
    etag: string,
  ) {
    this.buffer = buffer;
    this.mimeType = mimeType;
    this.etag = etag;
  }

  static async fromFile(filePath: string, deps: ShellStaticDeps = defaultDeps) {
    const buffer = await deps.readFile(filePath);
    const mimeType = getMimeType(filePath);
    const etag = await deps.generateETag(buffer);
    return new StaticResponse(buffer, mimeType, etag);
  }

  response(ifNoneMatch?: string | null) {
    // Check if client has matching ETag
    if (ifNoneMatch && compareETags(this.etag, ifNoneMatch)) {
      return new Response(null, {
        status: 304,
        headers: {
          "ETag": this.etag,
        },
      });
    }

    // Simple caching strategy:
    // Use no-cache + ETag for all files
    // This means: always validate with server, but use cache if 304
    const cacheHeaders = createCacheHeaders(this.etag);

    const response = new Response(this.buffer as BufferSource, {
      status: 200,
      headers: {
        "Content-Type": this.mimeType,
        ...cacheHeaders,
      },
    });
    return response;
  }
}

/**
 * Build a router that serves the compiled shell frontend out of `staticRoot`.
 *
 * Responses carry ETag-based caching: a 200 with the file bytes and cache
 * headers, or a 304 when the client's `If-None-Match` matches. Requests that
 * do not resolve to a file fall back to `index.html` for client-side routing.
 * Paths resolving outside `staticRoot` are rejected by the traversal guard and
 * fall through to the same `index.html` fallback.
 */
export function createShellStaticRouter(
  staticRoot: string,
  options: ShellStaticOptions = {},
) {
  const deps = options.deps ?? defaultDeps;
  const immutableBuildPrefix = options.immutableBuildId
    ? `builds/${encodeURIComponent(options.immutableBuildId)}/`
    : undefined;
  const router = createRouter();
  const cache = new Map<string, StaticResponse>();

  router.get("/*", async (c) => {
    let reqPath = c.req.path.slice(1); // Remove leading slash

    // GCS retains a physical copy of every deployed graph under this URL.
    // A compiled toolshed contains exactly one graph, so expose that same
    // contract as an exact-build alias without embedding the bytes twice.
    if (immutableBuildPrefix && reqPath.startsWith(immutableBuildPrefix)) {
      reqPath = reqPath.slice(immutableBuildPrefix.length);
    }

    // Default to index.html for root path
    if (!reqPath) {
      reqPath = "index.html";
    }

    // Get If-None-Match header for ETag validation
    const ifNoneMatch = c.req.header("If-None-Match");

    const cached = cache.get(reqPath);
    if (cached) {
      return cached.response(ifNoneMatch);
    }

    try {
      const filePath = path.join(staticRoot, reqPath);
      // Reject anything that resolves outside the static root. A relative path
      // that climbs out of the root starts with "..", and an unrelated
      // absolute path has no relative route into the root; a plain prefix
      // check would also accept sibling directories like
      // `${staticRoot}-dev/...`.
      const relative = path.relative(staticRoot, filePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Outside of static root range");
      }
      const res = await StaticResponse.fromFile(filePath, deps);
      cache.set(reqPath, res);
      return res.response(ifNoneMatch);
    } catch {
      // Serve index.html for client-side routing
      const cached = cache.get("index.html");
      if (cached) {
        return cached.response(ifNoneMatch);
      }
      const indexPath = path.join(staticRoot, "index.html");
      const res = await StaticResponse.fromFile(indexPath, deps);
      cache.set("index.html", res);
      return res.response(ifNoneMatch);
    }
  });

  return router;
}
